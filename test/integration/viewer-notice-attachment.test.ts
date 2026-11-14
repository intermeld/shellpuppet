/** Real snapshot ordering, Pop out/reattachment and nested PTY repaints. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import type { CaptureOptions } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { noticeFrameLimitScript } from './noticeFrameLimit.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';
import { assessDeliveredCadence, deliveredNoticeScript, recordDeliveredCadence } from './noticeCadence.js';
import type { DeliveredCadence } from './noticeCadence.js';

const fixture = fileURLToPath(new URL('../fixtures/notice-nested-tui.mjs', import.meta.url));
const cycleFixture = fileURLToPath(new URL('../fixtures/notice-r-cycle-tui.mjs', import.meta.url));
let browser: string | null;
let td: TestDaemon | undefined;
beforeAll(async () => { browser = await findBrowser(); });
afterEach(async () => {
  const cleanup = td;
  td = undefined;
  await cleanup?.stop();
}, 120_000);

const observe = `(() => {
  let implementation;
  Object.defineProperty(window, 'ShellPuppetPane', {
    get: () => implementation,
    set: value => { implementation = { ...value, create(config) {
      const pane = value.create(config);
      const term = pane.getTerminal(), write = term.write.bind(term), pending = [];
      window.__noticePhases = [];
      let phase;
      const acknowledge = () => {
        if (!phase || term.buffer.active.cursorY !== phase.row) return;
        const { id, duration, row } = phase;
        phase = null;
        __noticePhases.push({ at: performance.now(), duration, id, row, observedRow: term.buffer.active.cursorY });
        term.input('a' + id + ':' + Date.now() + ';', true);
      };
      term.onCursorMove(acknowledge);
      term.parser.registerOscHandler(777, data => {
        const [id, duration, row] = data.split(':').map(Number);
        // ConPTY can forward an OSC before flushing its preceding cursor move.
        phase = { id, duration, row };
        acknowledge();
        return true;
      });
      let first = true, parsing = false;
      // Preserve stream order while giving controls and layout time to run
      // before the first snapshot parses, as on a busy terminal renderer.
      term.write = (bytes, callback) => {
        if (first && bytes instanceof Uint8Array) {
          first = false; parsing = true;
          setTimeout(() => {
            parsing = false;
            for (const [data, done] of pending) write(data, () => { done?.(); window.__noticeSnapshotParsed = true; });
            pending.length = 0;
          }, 150);
        }
        if (parsing) pending.push([bytes, callback]);
        else write(bytes, callback);
      };
      window.__notice = { pane, term, alert: config.elements.promptAlert, banner: config.elements.banner,
        notices: config.elements.promptAlert.parentElement };
      return pane;
    } }; }
  });
  window.__pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  window.__noticeFrames = [];
  requestAnimationFrame(function sampleNoticeFrame(time) {
    __noticeFrames.push(time);
    requestAnimationFrame(sampleNoticeFrame);
  });
  window.__noticeFrameSummary = (start, end = performance.now()) => {
    const times = __noticeFrames.filter(time => time >= start && time <= end);
    const gaps = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
    return { frames: gaps.length, samples: gaps.length,
      frameInterval: gaps[Math.floor(gaps.length / 2)] ?? null,
      maxFrameGap: gaps.at(-1) ?? null,
      frameSpan: times.length < 2 ? 0 : times.at(-1) - times[0], observedMs: end - start };
  };
  window.__showEndBanner = () => {
    const s = __notice, text = s.banner.querySelector('.pane-banner-message') || s.banner;
    text.textContent = 'Session ended'; s.banner.hidden = false; s.pane.relayout(true);
  };
  window.__measure = (row = __notice.term.buffer.active.cursorY) => {
    const s = __notice, box = s.notices.getBoundingClientRect();
    const screen = s.term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const cell = screen.height / s.term.rows, bottom = s.notices.style.top === 'auto';
    return { row, rows: s.term.rows, hidden: s.alert.hidden && s.banner.hidden, height: box.height, side: bottom ? 'bottom' : 'top',
      ...__noticeFrameSummary(0),
      overlap: box.top < screen.top + (row + 1) * cell && box.bottom > screen.top + row * cell,
      anchorError: Math.abs(bottom ? box.bottom - screen.bottom : box.top - screen.top),
      capError: Math.abs(parseFloat(s.notices.style.maxHeight) - screen.height / 3) };
  };
})()`;

async function withPage(mode: string, rows: number,
  interact: (page: Parameters<NonNullable<CaptureOptions['interact']>>[0], input: (data: string) => Promise<void>) => Promise<unknown>,
  cadence = 'short'): Promise<void> {
  const urls: string[] = [];
  const cycleCadence: Record<string, string> = { rword: 'R', rlong: 'long', rrest: 'rest', rchange: 'change' };
  const daemon = await startTestDaemon({ promptScanIntervalMs: 100, promptStallMs: 300,
    launcher: url => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
  });
  td = daemon;
  const started = await api(daemon.port, daemon.token, '/sessions', { body: {
    command: process.execPath, args: [cycleCadence[cadence] ? cycleFixture : fixture, String(rows), cycleCadence[cadence] ?? cadence],
    cwd: path.dirname(fixture), shell: false,
    openViewer: false, cols: 80, rows, hold: true,
  } });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const id = String(started.body['id']);
  let viewerUrl: string;
  if (mode === 'dashboard') {
    expect((await api(daemon.port, daemon.token, '/dashboard/open', { body: {} })).status).toBe(200);
    viewerUrl = urls.at(-1)!;
  } else {
    const minted = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, { body: {} });
    expect(minted.status).toBe(200);
    viewerUrl = String(minted.body['viewerUrl']);
  }
  await captureViewer({ browser: browser!, viewerUrl, width: 1000, height: 900,
    cpuThrottlingRate: Number(process.env['NOTICE_CPU_RATE'] ?? 1),
    drive: true, probeOnly: true, timeoutMs: 90_000,
    beforeNavigateScript: noticeFrameLimitScript + ';' + observe + ';window.open = url => { window.__openedURL = url; return window.__openedHandle = { closed: false }; };',
    probe: ['long', 'staged', 'spinner', 'equal', 'rword', 'rlong', 'rrest', 'rchange'].includes(cadence) ?
      'window.__notice && window.__noticeSnapshotParsed && !__notice.alert.hidden' :
      'window.__notice && !__notice.alert.hidden && __notice.term.buffer.active.cursorY > 0',
    interact: page => interact(page, async data => {
      expect((await api(daemon.port, daemon.token, `/sessions/${id}/input`, { body: { data } })).status).toBe(200);
    }),
  });
}

interface Placement {
  row: number; rows: number; hidden: boolean; height: number; overlap: boolean; anchorError: number; capError: number;
}
function checkPlacement(result: Placement, rows: number): void {
  const details = JSON.stringify(result);
  expect.soft(result.rows, details).toBe(rows);
  expect.soft(result.row, details).toBeGreaterThanOrEqual(rows - 2);
  expect.soft(result.hidden, details).toBe(false);
  expect.soft(result.height, details).toBeGreaterThan(0);
  expect.soft(result.overlap, details).toBe(false);
  expect.soft(result.anchorError, details).toBeLessThan(0.1);
  expect.soft(result.capError, details).toBeLessThan(0.1);
}

describe.each(['viewer', 'dashboard'])('%s real nested repaints', mode => {
  for (const kind of ['rlong', 'rrest', 'rchange']) {
    it(`assesses the real PTY ${kind} word from delivered visits`, async context => {
      if (!browser) { context.skip(); return; }
      await withPage(mode, 24, async ({ evaluate }, input) => {
        await evaluate(deliveredNoticeScript);
        await evaluate('window.__delivered = observeDeliveredNotice(__notice.term, __notice.notices, performance.now(), 0)');
        await input('r');
        const cadence = await evaluate(`(async () => { await __pause(${kind === 'rlong' ? 45500 : 24500}); return __delivered.stop(); })()`) as DeliveredCadence;
        const assessment = assessDeliveredCadence(cadence);
        recordDeliveredCadence(`${mode}-24-${kind}`, cadence);
        const details = JSON.stringify({ ...assessment, timing: await evaluate('__noticeFrameSummary(0)') });
        expect.soft(cadence.legs.length, details).toBeGreaterThan(20);
        expect.soft(assessment.violations, details).toEqual([]);
      }, kind);
    }, 120_000);
  }
  it('follows a real PTY rest across two lower notice rows', async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, 24, async ({ evaluate }, input) => {
      await evaluate(deliveredNoticeScript);
      await evaluate('window.__delivered = observeDeliveredNotice(__notice.term, __notice.notices, performance.now(), 0)');
      await input('r');
      const cadence = await evaluate(`(async () => { await __pause(12500); return __delivered.stop(); })()`) as DeliveredCadence;
      cadence.cycleRows = [0, 22, 0, 22, 23, 22, 23, 0, 8, 9, 10, 11, 12];
      const assessment = assessDeliveredCadence(cadence);
      recordDeliveredCadence(`${mode}-24-rword`, cadence);
      const details = JSON.stringify({ ...assessment, timing: await evaluate('__noticeFrameSummary(0)') });
      expect.soft(assessment.legs.length, details).toBeGreaterThan(13);
      expect.soft(assessment.rests.some(rest => (rest as { edge?: string }).edge === 'bottom'), details).toBe(true);
      expect.soft(assessment.violations, details).toEqual([]);
    }, 'rword');
  }, 120_000);
  for (const cadence of ['staged', 'spinner', 'equal']) for (const rows of [24, 150])
  it(`respects repaint evidence during ${cadence} updates at 80x${String(rows)}`, async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, rows, async ({ evaluate }, input) => {
      await evaluate('__pause(1100)');
      expect((await evaluate('__measure()') as { side: string }).side).toBe('bottom');
      await evaluate(deliveredNoticeScript);
      await evaluate(`window.__delivered = observeDeliveredNotice(__notice.term, __notice.notices,
        performance.now(), 0)`);
      await evaluate(`window.__visits = [];
        __notice.term.onCursorMove(() => __visits.push({ row: __notice.term.buffer.active.cursorY, at: performance.now() }))`);
      await input('r');
      const result = await evaluate(`(async () => {
        const start = performance.now(), prompt = __notice.term.rows - 2;
        let firstClear = null, changes = 0, coveredAtRest = 0, restSamples = 0, last = __measure().side;
        let firstRestAt = null, lastRestAt = null;
        while (performance.now() - start < 10000) {
          const now = performance.now() - start, measure = __measure(prompt);
          if (measure.side !== last) { changes++; last = measure.side; }
          if (!measure.overlap) firstClear ??= now;
          if (now >= 2500 && __notice.term.buffer.active.cursorY === prompt) {
            firstRestAt ??= now; lastRestAt = now;
            restSamples++; if (measure.overlap) coveredAtRest++;
          }
          await __pause(4);
        }
        const vertical = __visits.filter((visit, i) => i === 0 || visit.row !== __visits[i - 1].row);
        const legs = vertical.slice(1).map((visit, i) => visit.at - vertical[i].at);
        return { firstClear, changes, restSamples, coveredAtRest, firstRestAt, lastRestAt,
          restTiming: __noticeFrameSummary(start + 2500, performance.now()),
          maxLeg: Math.max(...legs), visits: __visits.length,
          cadence: __delivered.stop() };
      })()`) as { firstClear: number | null; changes: number; restSamples: number; coveredAtRest: number;
        firstRestAt: number | null; lastRestAt: number | null; maxLeg: number; visits: number;
        restTiming: { frames: number; frameInterval: number; maxFrameGap: number; frameSpan: number; observedMs: number };
        cadence: DeliveredCadence };
      const assessment = assessDeliveredCadence(result.cadence);
      recordDeliveredCadence(`${mode}-${String(rows)}-${cadence}`, result.cadence);
      const details = JSON.stringify({ ...result, cadence: assessment,
        timing: await evaluate('__noticeFrameSummary(0)') });
      expect.soft(result.firstRestAt, details).not.toBeNull();
      expect.soft(result.lastRestAt! - result.firstRestAt!, details).toBeGreaterThan(2000);
      expect.soft(result.restSamples, details).toBeGreaterThanOrEqual(
        Math.floor((result.lastRestAt! - result.firstRestAt!) / 200));
      expect.soft(result.restTiming.frameSpan, details).toBeGreaterThan(6000);
      expect.soft(result.restTiming.frames, details).toBeGreaterThanOrEqual(
        Math.floor(result.restTiming.frameSpan / 200));
      expect.soft(result.restTiming.frameInterval, details).toBeLessThan(200);
      expect.soft(result.restTiming.maxFrameGap, details).toBeLessThan(500);
      expect.soft(result.restTiming.observedMs - result.restTiming.frameSpan, details).toBeLessThan(500);
      expect.soft(result.cadence.legs.length, details).toBeGreaterThan(4);
      expect.soft(assessment.violations, details).toEqual([]);
      if (!assessment.rests.length) {
        expect.soft(result.changes, details).toBeLessThanOrEqual(1);
        if (cadence === 'staged') {
          expect.soft(result.firstClear, details).not.toBeNull();
          if ((assessment.repaints[0]?.firstCycle ?? 0) <= 2500) {
            expect.soft(result.firstClear!, details).toBeLessThanOrEqual(2500);
            expect.soft(result.coveredAtRest, details).toBe(0);
          }
        }
      }
      if (cadence === 'spinner') expect.soft(result.visits, details).toBeGreaterThan(100);
    }, cadence);
  }, 120_000);
  for (const rows of [24, 150]) it(`uncovers the prompt in a 1.3 s staged repaint at 80x${String(rows)}`, async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, rows, async ({ evaluate }, input) => {
      await evaluate('__pause(1100)');
      const initial = await evaluate('__measure()') as { side: string; overlap: boolean };
      expect(initial.side, JSON.stringify(initial)).toBe('bottom');
      await input('r');
      const result = await evaluate(`(async () => {
        const start = performance.now(), prompt = __notice.term.rows - 2;
        let firstClear = null, changes = 0, coveredAtRest = 0, restSamples = 0;
        let firstRestAt = null, lastRestAt = null;
        let last = __measure(prompt).side;
        while (performance.now() - start < 6500) {
          const now = performance.now() - start, measure = __measure(prompt);
          if (measure.side !== last) { changes++; last = measure.side; }
          if (!measure.overlap && firstClear === null) firstClear = now;
          if (now > 2500 && __notice.term.buffer.active.cursorY === prompt) {
            firstRestAt ??= now; lastRestAt = now;
            restSamples++; if (measure.overlap) coveredAtRest++;
          }
          await __pause(4);
        }
        return { firstClear, changes, restSamples, coveredAtRest, side: last,
          firstRestAt, lastRestAt, ...__noticeFrameSummary(start, performance.now()) };
      })()`) as { firstClear: number | null; changes: number; restSamples: number;
        coveredAtRest: number; side: string; firstRestAt: number | null; lastRestAt: number | null;
        frames: number; frameInterval: number; maxFrameGap: number; frameSpan: number; observedMs: number };
      if (process.env['NOTICE_DIAGNOSTICS']) process.stderr.write(JSON.stringify({ mode, rows, result }) + '\n');
      const details = JSON.stringify(result);
      expect.soft(result.firstClear, details).not.toBeNull();
      expect.soft(result.firstClear!, details).toBeLessThan(2500);
      expect.soft(result.changes, details).toBe(1);
      expect.soft(result.restSamples, details).toBeGreaterThanOrEqual(
        Math.floor((result.lastRestAt! - result.firstRestAt!) / 200));
      expect.soft(result.frames, details).toBeGreaterThanOrEqual(Math.floor(result.frameSpan / 200));
      expect.soft(result.frameInterval, details).toBeLessThan(200);
      expect.soft(result.maxFrameGap, details).toBeLessThan(500);
      expect.soft(result.frameSpan, details).toBeGreaterThan(5500);
      expect.soft(result.observedMs - result.frameSpan, details).toBeLessThan(500);
      expect.soft(result.firstRestAt, details).not.toBeNull();
      expect.soft(result.lastRestAt! - result.firstRestAt!, details).toBeGreaterThan(2000);
      expect.soft(result.coveredAtRest, details).toBe(0);
      expect.soft(result.side, details).toBe('top');
    }, 'long');
  }, 120_000);
  for (const cadence of ['short', 'extended']) for (const rows of [24, 150])
  it(`keeps the lower resting prompt clear during ${cadence} repaints at 80x${String(rows)}`, async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, rows, async ({ evaluate }, input) => {
      await evaluate('__pause(700)');
      await evaluate(deliveredNoticeScript);
      await evaluate('window.__delivered = observeDeliveredNotice(__notice.term, __notice.notices, performance.now(), 0)');
      await evaluate(`window.__visits = [];
        __notice.term.onCursorMove(() => __visits.push({ row: __notice.term.buffer.active.cursorY, at: performance.now() }))`);
      await input('r');
      const result = await evaluate(`(async () => {
        const start = performance.now();
        let samples = 0, restSamples = 0, covered = 0, coveredAtRest = 0, changes = 0, last = __measure().side;
        const changeTimes = [], coveredTimes = [], initialSide = last;
        while (performance.now() - start < 6500) {
          const measurement = __measure(__notice.term.rows - 2);
          if (measurement.side !== last) { last = measurement.side; changes++; changeTimes.push(performance.now() - start); }
          if (performance.now() - start > 1700) {
            samples++; if (measurement.overlap) { covered++; coveredTimes.push(performance.now() - start); }
            if (__notice.term.buffer.active.cursorY === __notice.term.rows - 2) {
              restSamples++; if (measurement.overlap) coveredAtRest++;
            }
          }
          await __pause(4);
        }
        const end = performance.now(), weights = {};
        for (let i = 0; i < __visits.length; i++) {
          const visit = __visits[i], duration = Math.max(0, (__visits[i + 1]?.at ?? end) - Math.max(start + 1700, visit.at));
          weights[visit.row] = (weights[visit.row] || 0) + duration;
        }
        const gaps = __visits.slice(1).map((visit, index) => ({
          row: __visits[index].row, at: __visits[index].at - start, ms: visit.at - __visits[index].at }));
        const maxGap = Math.max(0, ...gaps.map(gap => gap.ms));
        return { samples, restSamples, covered, coveredAtRest, changes, changeTimes,
          firstCovered: coveredTimes[0] ?? null, lastCovered: coveredTimes.at(-1) ?? null,
          initialSide, finalSide: last,
          maxGap, longGaps: gaps.filter(gap => gap.ms > 500), weights, phases: __noticePhases.length,
          phaseMismatches: __noticePhases.filter(phase => phase.observedRow !== phase.row).length, hidden: __notice.alert.hidden,
          cadence: __delivered.stop(), ...__noticeFrameSummary(start + 1700, end) };
      })()`) as { samples: number; restSamples: number; covered: number; coveredAtRest: number;
        changes: number; changeTimes: number[]; maxGap: number; phases: number; phaseMismatches: number;
        longGaps: { row: number; at: number; ms: number }[];
        weights: Record<string, number>; hidden: boolean; cadence: DeliveredCadence;
        frames: number; frameInterval: number; maxFrameGap: number; frameSpan: number; observedMs: number };
      // The first header follows the preceding lower phase; its inner return
      // is not a cycle boundary. Complete delivered words determine the ratio.
      // All samples, including the unfinished final cycle, still face every
      // overlap, rest and stability assertion below.
      result.cadence.cycleRows = [0, Math.floor(rows / 2), 0, rows - 2];
      const assessment = assessDeliveredCadence(result.cadence);
      recordDeliveredCadence(`${mode}-${String(rows)}-${cadence}`, result.cadence);
      const details = JSON.stringify({ ...result, cadence: assessment,
        timing: await evaluate('__noticeFrameSummary(0)') });
      expect.soft(result.samples, details).toBeGreaterThanOrEqual(Math.floor(result.frameSpan / 200));
      expect.soft(result.restSamples, details).toBeGreaterThanOrEqual(Math.floor(result.frameSpan / 200));
      expect.soft(result.frames, details).toBeGreaterThanOrEqual(Math.floor(result.frameSpan / 200));
      expect.soft(result.frameInterval, details).toBeLessThan(200);
      expect.soft(result.maxFrameGap, details).toBeLessThan(500);
      expect.soft(result.frameSpan, details).toBeGreaterThan(4000);
      expect.soft(result.observedMs - result.frameSpan, details).toBeLessThan(500);
      expect.soft(result.hidden, details).toBe(false);
      expect.soft(assessment.violations, details).toEqual([]);
      if (!assessment.rests.length) {
        expect.soft(result.covered, details).toBe(0);
        expect.soft(result.coveredAtRest, details).toBe(0);
        expect.soft(result.changes, details).toBe(0);
      }
      const repaints = assessment.repaints.filter(stretch => stretch.firstCycle !== null);
      expect.soft(repaints.length, details).toBeGreaterThan(0);
      for (const stretch of repaints) {
        expect.soft(stretch.top / stretch.bottom, details).toBeLessThan(2 / 3);
      }
      if (cadence === 'extended') {
        expect.soft(result.phases, details).toBeGreaterThan(12);
        expect.soft(result.phaseMismatches, details).toBe(0);
      }
    }, cadence);
  }, 120_000);
});

describe('notice placement on Pop out and reattachment', () => {
  for (const rows of [24, 150]) for (const ended of [false, true]) {
    it(`places the ${ended ? 'ended' : 'live'} snapshot at 80x${String(rows)}`, async context => {
      if (!browser) { context.skip(); return; }
      await withPage('dashboard', rows, async ({ evaluate, send }, input) => {
        if (ended) { await input('q'); await evaluate('__pause(1200)'); await evaluate('__showEndBanner()'); }
        else await evaluate('__pause(700)');
        await evaluate("document.querySelector('[data-action=pop]').click()");
        const openedURL = await evaluate('window.__openedURL') as string;
        expect(openedURL).toBeTruthy();
        const target = await send('Target.createTarget', { url: 'about:blank' }, true) as { targetId: string };
        try {
          const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true) as { sessionId: string };
          await send('Page.enable', {}, attached.sessionId);
          await send('Page.addScriptToEvaluateOnNewDocument', { source: observe }, attached.sessionId);
          await send('Page.navigate', { url: openedURL }, attached.sessionId);
          const popup = async (expression: string): Promise<unknown> => {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId) as {
              result: { value: unknown }; exceptionDetails?: unknown;
            };
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
          };
          let ready = false;
          for (let i = 0; i < 100 && !ready; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            ready = await popup('!!window.__notice && __notice.term.buffer.active.cursorY > 0') as boolean;
          }
          expect(ready).toBe(true);
          if (ended) await popup('__showEndBanner()');
          // Earlier than the 550 ms quiet fallback: snapshot completion must place it.
          await popup('__pause(100)');
          const placement = await popup('__measure()') as Placement;
          checkPlacement(placement, rows);
        } finally { await send('Target.closeTarget', { targetId: target.targetId }, true); }
        await evaluate('window.__openedHandle.closed = true');
        await evaluate('__pause(1600)');
        if (ended) await evaluate('__showEndBanner()');
        checkPlacement(await evaluate('__measure()') as Placement, rows);
        await evaluate('__pause(2200)');
        if (ended) await evaluate('__showEndBanner()');
        checkPlacement(await evaluate('__measure()') as Placement, rows);
      });
    }, 120_000);
  }
});
