/** Real PTY repaint traffic must not make a waiting alert jump between halves. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from './browserCapture.js';
import type { CaptureOptions } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { noticeFrameLimitScript } from './noticeFrameLimit.js';
import { api, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';
import { assessDeliveredCadence, deliveredNoticeScript, recordDeliveredCadence } from './noticeCadence.js';
import type { DeliveredCadence } from './noticeCadence.js';

const fixture = fileURLToPath(new URL('../fixtures/notice-repaint-tui.mjs', import.meta.url));
let browser: string | null;
let td: TestDaemon | undefined;
beforeAll(async () => { browser = await findBrowser(); });
afterEach(async () => {
  const cleanup = td;
  td = undefined;
  await cleanup?.stop();
}, 120_000);

const observePane = `(() => {
  let implementation;
  Object.defineProperty(window, 'ShellPuppetPane', {
    get: () => implementation,
    set: value => { implementation = { ...value, create(config) {
      const pane = value.create(config);
      const term = pane.getTerminal();
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
        // A marker alone does not prove that ConPTY has delivered its row.
        phase = { id, duration, row };
        acknowledge();
        return true;
      });
      const notices = config.elements.promptAlert.parentElement;
      const state = window.__noticeTest = { pane, term, notices, alert: config.elements.promptAlert,
        moves: 0, halves: new Set(), rects: 0, movedAt: null, visits: [] };
      term.onCursorMove(() => {
        state.moves++;
        state.halves.add(term.buffer.active.cursorY < term.rows / 2);
        state.movedAt ??= performance.now();
        state.visits.push({ row: term.buffer.active.cursorY, at: performance.now() });
      });
      for (const element of [config.container.parentElement, term.element.querySelector('.xterm-screen')]) {
        const rect = element.getBoundingClientRect.bind(element);
        element.getBoundingClientRect = () => { state.rects++; return rect(); };
      }
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
    return { frames: gaps.length, frameInterval: gaps[Math.floor(gaps.length / 2)] ?? null,
      maxFrameGap: gaps.at(-1) ?? null,
      frameSpan: times.length < 2 ? 0 : times.at(-1) - times[0], observedMs: end - start };
  };
  window.__placement = () => {
    const style = getComputedStyle(__noticeTest.notices);
    return { top: style.top, bottom: style.bottom };
  };
  window.__sample = async (ms, requiredMoves = 0) => {
    const state = __noticeTest;
    state.moves = state.rects = 0; state.halves.clear();
    const samples = [], changes = [], visitsAt = state.visits.length;
    const start = performance.now();
    let last = JSON.stringify(__placement());
    while (performance.now() - start < ms ||
           (state.moves < requiredMoves && performance.now() - start < 10000)) {
      const placement = __placement(), current = JSON.stringify(placement);
      if (current !== last) { changes.push({ at: performance.now() - start, placement }); last = current; }
      samples.push({ ...placement, hidden: state.alert.hidden });
      await __pause(4);
    }
    return { placements: [...new Set(samples.map(s => JSON.stringify({ top: s.top, bottom: s.bottom })))],
      samples: samples.length, hidden: samples.some(s => s.hidden), moves: state.moves,
      halves: state.halves.size, rects: state.rects, changes, visits: state.visits.slice(visitsAt),
      ...__noticeFrameSummary(start) };
  };
})()`;

// Exercise the same synchronous calls used by an arriving alert, geometry,
// font controls and layout before the first frame has any movement history.
function initialPlacementChecks(mode: string): string {
  return `(async () => {
    const originalState = __noticeTest, NativeSocket = WebSocket;
    let socket;
    window.WebSocket = class {
      constructor() { this.readyState = 1; socket = this; }
      send() {}
      close() { this.readyState = 3; }
    };
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:700px';
    const container = document.createElement('div');
    container.style.cssText = 'width:100%;height:100%';
    const notices = document.createElement('div');
    notices.style.position = 'absolute';
    const alert = document.createElement('div');
    alert.hidden = true;
    notices.append(alert); wrap.append(container, notices); document.body.append(wrap);
    const pane = ShellPuppetPane.create({ container, sessionId: 'initial-notice',
      dashboardProof: ${mode === 'dashboard' ? "'test-proof'" : 'null'}, elements: { promptAlert: alert } });
    window.WebSocket = NativeSocket;
    const term = pane.getTerminal(), measurements = [], startedAt = performance.now();
    let disposed = false;
    const geometry = rows => socket.onmessage({ data: JSON.stringify({ type: 'geometry',
      cols: 100, rows, control: 'held' }) });
    const measure = (step, side) => {
      const screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      const outer = wrap.getBoundingClientRect();
      const offset = side === 'top' ? screen.top - outer.top : outer.bottom - screen.bottom;
      measurements.push({ step, side, anchor: notices.style[side],
        ...__noticeFrameSummary(startedAt),
        anchorError: Math.abs(parseFloat(notices.style[side]) - offset),
        capError: Math.abs(parseFloat(notices.style.maxHeight) - screen.height / 3) });
    };
    try {
      socket.onopen(); geometry(49);
      await new Promise(resolve => term.write(String.fromCharCode(27) + '[31;1H', () => {
        socket.onmessage({ data: JSON.stringify({ type: 'prompt-stall', question: 'Allow?', waitingMs: 300 }) });
        measure('initial alert', 'top');
        pane.setFontOverride(8); measure('text size', 'top');
        pane.setDashboardFontLimit(7); measure('dashboard text limit', 'top');
        // Both edges leave row 30 visible, so a taller grid keeps the edge.
        geometry(70); measure('taller grid', 'top');
        geometry(49); measure('original grid', 'top');
        wrap.style.width = '180px'; wrap.style.height = '100px';
        pane.relayout(false); measure('fit and scale', 'top');
        resolve();
      }));
      await __pause(100);
      await new Promise(resolve => term.write(String.fromCharCode(27) + '[5;1H', resolve));
      await __pause(80);
      const beforeDestroy = notices.style.cssText;
      pane.destroy();
      disposed = true;
      await __pause(450);
      return { measurements, destroyedUnchanged: beforeDestroy === notices.style.cssText };
    } finally {
      if (!disposed) pane.destroy();
      wrap.remove(); window.WebSocket = NativeSocket; window.__noticeTest = originalState;
    }
  })()`;
}

async function withPage(mode: string, interact: NonNullable<CaptureOptions['interact']>, period?: number,
  pluralityRows?: number): Promise<void> {
  await td?.stop();
  td = undefined;
  const urls: string[] = [];
  td = await startTestDaemon({ promptScanIntervalMs: 100, promptStallMs: 300,
    launcher: url => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
  });
  const started = await api(td.port, td.token, '/sessions', { body: {
    command: process.execPath,
    args: period === undefined ? [fixture] : [path.join(path.dirname(fixture),
      pluralityRows === undefined ? 'notice-occupancy-tui.mjs' : 'notice-plurality-tui.mjs'), String(period), String(pluralityRows ?? 24)],
    cwd: path.dirname(fixture), shell: false,
    openViewer: false, cols: period === undefined ? 100 : 80, rows: period === undefined ? 49 : pluralityRows ?? 24, hold: true,
  } });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const id = String(started.body['id']);
  let viewerUrl: string;
  if (mode === 'dashboard') {
    expect((await api(td.port, td.token, '/dashboard/open', { body: {} })).status).toBe(200);
    viewerUrl = urls.at(-1)!;
  } else {
    const minted = await api(td.port, td.token, `/sessions/${id}/viewer`, { body: {} });
    expect(minted.status).toBe(200);
    viewerUrl = String(minted.body['viewerUrl']);
  }
  await captureViewer({ browser: browser!, viewerUrl, width: 1000, height: 900,
    cpuThrottlingRate: Number(process.env['NOTICE_CPU_RATE'] ?? 1),
    drive: true, probeOnly: true, timeoutMs: period === undefined ? 60_000 : 90_000,
    beforeNavigateScript: noticeFrameLimitScript + ';' + observePane,
    probe: `window.__noticeTest && !__noticeTest.alert.hidden &&
      __noticeTest.alert.textContent.includes('Waiting for you') && ${period === undefined ? '__noticeTest.moves > 10' : 'true'}`,
    timeoutProbe: `JSON.stringify({ alert: window.__noticeTest?.alert.textContent,
      moves: window.__noticeTest?.moves, body: document.body?.innerText.slice(0, 300) })`,
    interact: async page => {
      await page.evaluate('__pause(1000)');
      return interact(page);
    },
  });
}

describe.each(['viewer', 'dashboard'])('%s notice placement', mode => {
  for (const rows of [24, 150]) it(`uncovers a leading prompt among three excursions at 80x${String(rows)}`, async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, async ({ evaluate }) => {
      const sessions = (await api(td!.port, td!.token, '/sessions')).body['sessions'] as { id: string }[];
      await evaluate(`window.__visits = [];
        __noticeTest.term.onCursorMove(() => __visits.push({ row: __noticeTest.term.buffer.active.cursorY, at: performance.now() }))`);
      await evaluate(deliveredNoticeScript);
      await evaluate(`window.__leadingResult = (async () => {
        const state = __noticeTest, row = state.term.rows - 2, placements = new Set();
        const start = await new Promise(resolve => {
          const first = state.term.onCursorMove(() => {
            if (state.term.buffer.active.cursorY === 0) {
              first.dispose();
              const at = performance.now();
              // The input API can spend arbitrary time before the PTY starts
              // this word. Judge the same delivered word as the placement
              // timing, without counting the preceding idle cursor position.
              window.__leadingCadence = observeDeliveredNotice(state.term, state.notices, at, 0);
              resolve(at);
            }
          });
        });
        let samples = 0, restingSamples = 0, covered = 0, follow = null;
        let firstCoveredAt = null, firstWrongSideAt = null;
        while (performance.now() - start < 6000) {
          const box = state.notices.getBoundingClientRect(), screen = state.term.element.querySelector('.xterm-screen').getBoundingClientRect();
          const cell = screen.height / state.term.rows;
          const overlap = box.top < screen.top + (row + 1) * cell && box.bottom > screen.top + row * cell;
          if (!overlap) follow ??= performance.now() - start;
          // Start the placement check at the first frame actually delivered
          // after the 2.5 s startup deadline.
          if (__noticeFrames.at(-1) >= start + 2500) {
            samples++; if (overlap) { covered++; firstCoveredAt ??= performance.now() - start; }
            if (state.term.buffer.active.cursorY === row) restingSamples++;
            const side = state.notices.style.top === 'auto' ? 'bottom' : 'top';
            placements.add(side);
            if (side !== 'top') firstWrongSideAt ??= performance.now() - start;
          }
          await __pause(4);
        }
        const end = performance.now(), weights = {};
        const earlyWeights = {}, firstMoving = __visits.find(visit => visit.at >= start && visit.row !== 0)?.at ?? start;
        const earlyEnd = start + (follow ?? 0);
        let longestPromptStay = 0;
        for (let i = 0; i < __visits.length; i++) {
          const visit = __visits[i];
          const duration = Math.max(0, (__visits[i + 1]?.at ?? end) - Math.max(start + 1700, visit.at));
          weights[visit.row] = (weights[visit.row] || 0) + duration;
          const earlyDuration = Math.max(0, Math.min(earlyEnd, __visits[i + 1]?.at ?? earlyEnd) -
            Math.max(firstMoving, visit.at));
          earlyWeights[visit.row] = (earlyWeights[visit.row] || 0) + earlyDuration;
          if (visit.row === row) longestPromptStay = Math.max(longestPromptStay, earlyDuration);
        }
        let leadingAt = null, promptEvidence = 0, upperEvidence = 0;
        for (let i = 0; i < __visits.length; i++) {
          const visit = __visits[i];
          const from = Math.max(firstMoving, visit.at);
          const to = Math.min(earlyEnd, __visits[i + 1]?.at ?? earlyEnd);
          const duration = Math.max(0, to - from);
          if (visit.row === row) {
            const needed = Math.max(upperEvidence + 20, upperEvidence * 1.5) - promptEvidence;
            if (leadingAt === null && needed <= duration)
              leadingAt = from + Math.max(0, needed);
            if (leadingAt === null && duration >= 1000) leadingAt = from + 1000;
            promptEvidence += duration;
          } else if (visit.row === 0) upperEvidence += duration;
        }
        return { row, rows: state.term.rows, samples, restingSamples, covered, follow, weights,
          leadingAt: leadingAt === null ? null : leadingAt - start,
          startedAt: start, firstCoveredAt, firstWrongSideAt,
          earlyWeights, longestPromptStay,
          deadlineFrame: (__noticeFrames.find(time => time >= start + 2500) ?? NaN) - start,
          decisionGap: __noticeFrames.slice(1).reduce((largest, current, index) => {
            const previous = __noticeFrames[index];
            return previous < start + 2500 && current > start && current <= start + 2500 + 600
              ? Math.max(largest, current - previous) : largest;
          }, 0),
          stalls: __noticeFrames.slice(1).map((time, index) => ({
            from: __noticeFrames[index] - start, to: time - start, gap: time - __noticeFrames[index],
          })).filter(gap => gap.to >= 0 && gap.from <= 6000 && gap.gap >= 500),
          ...__noticeFrameSummary(start),
          placements: [...placements], hidden: state.alert.hidden,
          visits: __visits.map(visit => ({ row: visit.row, ms: visit.at - start })),
          cadence: __leadingCadence.stop() };
      })(); true`);
      expect((await api(td!.port, td!.token, `/sessions/${sessions[0]!.id}/input`, { body: { data: 'r' } })).status).toBe(200);
      const result = await evaluate('window.__leadingResult') as { row: number; rows: number; samples: number; restingSamples: number; covered: number;
        follow: number | null; weights: Record<string, number>; earlyWeights: Record<string, number>;
        longestPromptStay: number; placements: string[]; hidden: boolean;
        deadlineFrame: number; decisionGap: number; startedAt: number; leadingAt: number | null;
        firstCoveredAt: number | null; firstWrongSideAt: number | null;
        stalls: { from: number; to: number; gap: number }[];
        frames: number; frameInterval: number; maxFrameGap: number; frameSpan: number; observedMs: number;
        visits: { row: number; ms: number }[]; cadence: DeliveredCadence };
      const assessment = assessDeliveredCadence(result.cadence);
      recordDeliveredCadence(`${mode}-${String(rows)}-leading`, result.cadence);
      const details = JSON.stringify({ ...result, cadence: assessment });
      expect(assessment.violations, details).toEqual([]);
      const promptTime = result.earlyWeights[String(result.row)] ?? 0;
      const upperTime = result.earlyWeights['0'] ?? 0;
      if (result.samples === 0 || result.restingSamples === 0 || result.frames < 2 ||
          !Number.isFinite(result.deadlineFrame)) {
        throw new Error(`runner stalled before a post-deadline prompt observation: ${details}`);
      }
      expect(result.rows, details).toBe(rows);
      expect(result.hidden, details).toBe(false);
      expect(result.longestPromptStay >= 1000 ||
        (promptTime - upperTime >= 20 && upperTime <= promptTime * 2 / 3), details).toBe(true);
      expect(result.follow, details).not.toBeNull();
      expect(result.deadlineFrame, details).toBeGreaterThanOrEqual(2500);
      expect(result.follow, details).toBeLessThanOrEqual(result.deadlineFrame);
      const upperRest = (assessment.rests as { edge: string; start: number; end: number; deadline?: number }[])
        .find(rest => rest.edge === 'top');
      if (!upperRest) {
        expect(result.covered, details).toBe(0);
        expect(result.placements, details).toEqual(['top']);
        return;
      }
      // A delayed header can become a genuine upper rest. First prove startup
      // and a complete steady repaint, then require clearance of that rest.
      // The delivered assessor still checks all later visits and moves.
      const epoch = result.cadence.epoch!;
      const legs = result.cadence.legs.filter(leg => epoch + leg.start >= result.startedAt + result.deadlineFrame &&
        leg.end <= upperRest.start);
      const word = [0, Math.floor(rows / 3), Math.floor(rows / 2), result.row];
      const complete = legs.some((_, i) => word.every((row, j) => legs[i + j]?.row === row));
      const deadline = upperRest.deadline;
      if (!complete || deadline === undefined || !result.cadence.samples.some(sample =>
        sample.time > deadline && sample.time < upperRest.end)) {
        throw new Error(`runner stalled before both a steady post-deadline word and a completed upper rest could be judged: ${details}`);
      }
      const restDue = epoch + upperRest.start + 1000 - result.startedAt;
      expect(result.firstCoveredAt ?? Infinity, details).toBeGreaterThanOrEqual(restDue);
      expect(result.firstWrongSideAt ?? Infinity, details).toBeGreaterThanOrEqual(restDue);
    }, 200, rows);
  }, 240_000);

  for (const period of [33, 25]) it(`uncovers a moved prompt during ${String(period)} ms repaints and stays steady through longer pauses`, async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, async ({ evaluate }) => {
      const sessions = (await api(td!.port, td!.token, '/sessions')).body['sessions'] as { id: string }[];
      const input = async (data: string): Promise<void> => {
        expect((await api(td!.port, td!.token, `/sessions/${sessions[0]!.id}/input`, { body: { data } })).status).toBe(200);
      };
      await evaluate(`window.__sampleRest = async (ms, row, minPhases = 0) => {
        const state = __noticeTest, start = performance.now(), placements = new Set();
        const firstPhase = __noticePhases.findLastIndex(phase => phase.at <= start);
        const phase = __noticePhases.at(-1);
        const observation = observeDeliveredNotice(state.term, state.notices,
          phase?.row === state.term.buffer.active.cursorY ? phase.at : start);
        const rect = element => HTMLElement.prototype.getBoundingClientRect.call(element);
        let covered = 0, samples = 0, restingSamples = 0;
        const transitions = [];
        let previous = '';
        // A genuine rest can consume most of the initial observation window.
        // Keep the phase coverage guard by observing further delivered phases.
        while (performance.now() - start < ms || (performance.now() - start < 10000 &&
          __noticePhases.length - Math.max(0, firstPhase) < minPhases)) {
          const box = rect(state.notices), screen = rect(state.term.element.querySelector('.xterm-screen'));
          const cell = screen.height / state.term.rows;
          const side = state.notices.style.top === 'auto' ? 'bottom' : 'top';
          placements.add(side);
          const cursor = state.term.buffer.active.cursorY;
          const current = cursor + ':' + side;
          if (current !== previous) {
            transitions.push({ ms: Math.round(performance.now() - start), cursor, side });
            if (transitions.length > 40) transitions.shift();
            previous = current;
          }
          if (box.top < screen.top + (row + 1) * cell && box.bottom > screen.top + row * cell) covered++;
          if (state.term.buffer.active.cursorY === row) restingSamples++;
          samples++;
          await __pause(4);
        }
        const phases = __noticePhases.slice(Math.max(0, firstPhase));
        const maxLeg = Math.max(0, ...phases.slice(1).map((phase, i) => phase.at - phases[i].at));
        return { placements: [...placements], covered, samples, restingSamples, transitions,
          ...__noticeFrameSummary(start),
          phases: phases.length, maxLeg, phaseMismatches: phases.filter(phase => phase.observedRow !== phase.row).length,
          hidden: state.alert.hidden, cadence: observation.stop() };
      }`);
      await evaluate(deliveredNoticeScript);
      // The fixture starts on row 1. Anchor startup to the first delivered
      // prompt, including any placement that occurs before the input API replies.
      await evaluate('window.__moving = observeDeliveredNotice(__noticeTest.term, __noticeTest.notices, performance.now(), 22)');
      await input('r');
      await eventually(async () => await evaluate('__moving.peek().legs.length > 0') === true,
        10_000, 50, 'runner stalled before the first moving prompt was delivered');
      const moving = await evaluate(`(async () => {
        await __pause(6000);
        return { cadence: __moving.stop(), hidden: __noticeTest.alert.hidden };
      })()`) as { cadence: DeliveredCadence; hidden: boolean };
      const trace = moving.cadence;
      const judged = assessDeliveredCadence(trace);
      recordDeliveredCadence(`${mode}-${String(period)}-r`, trace);
      const upperRest = (judged.rests as { edge: string; start: number; end: number; deadline?: number }[])
        .find(rest => rest.edge === 'top');
      const steadyEnd = upperRest?.start ?? trace.end;
      const steady = trace.samples.filter(sample => sample.time >= 2500 && sample.time < steadyEnd);
      const promptSamples = steady.filter(sample => sample.row === 22);
      const promptMs = trace.legs.filter(leg => leg.row === 22).reduce((total, leg) =>
        total + Math.max(0, Math.min(leg.end, steadyEnd) - Math.max(leg.start, 2500)), 0);
      const evidence = JSON.stringify({ assessment: judged, firstSteady: steady[0], lastSteady: steady.at(-1) });
      expect(judged.violations, evidence).toEqual([]);
      expect(moving.hidden, evidence).toBe(false);
      if (!promptSamples.length || !steady.some(sample => sample.evaluation) ||
          !trace.legs.some(leg => leg.row === 0) || trace.end < 6000) {
        throw new Error(`runner stalled before the split repaint and steady prompt were observed: ${evidence}`);
      }
      if (upperRest) {
        const word = trace.legs.filter(leg => leg.start >= 2500 && leg.end <= steadyEnd);
        if (!word.some((leg, i) => leg.row === 22 && word[i + 1]?.row === 0 && word[i + 2]?.row === 22) ||
            !trace.samples.some(sample => sample.time > (upperRest.deadline ?? Infinity) && sample.time < upperRest.end)) {
          throw new Error(`runner stalled before a complete steady repaint and an observable upper rest: ${evidence}`);
        }
      }
      expect(promptMs / (steadyEnd - 2500), evidence).toBeGreaterThan(0.6);
      expect(trace.samples.find(sample => sample.side === 'top')?.time, evidence).toBeLessThanOrEqual(2500);
      expect(new Set(steady.map(sample => sample.side)), evidence).toEqual(new Set(['top']));
      expect(promptSamples.some(sample => sample.covered), evidence).toBe(false);
      for (const key of ['s', 'l']) {
        await input('b'); await evaluate('__pause(1150)');
        await evaluate('window.__phaseStart = __noticePhases.length');
        await input(key);
        await eventually(async () => await evaluate('__noticePhases.length - __phaseStart >= 2') === true,
          5000, 50, 'runner stalled before the prompt and header phases were parsed');
        const result = await evaluate('__sampleRest(3500, 22, 5)') as {
          placements: string[]; covered: number; samples: number; restingSamples: number; hidden: boolean;
          phases: number; maxLeg: number; phaseMismatches: number;
          cadence: DeliveredCadence;
          frames: number; frameInterval: number; maxFrameGap: number; frameSpan: number; observedMs: number;
        };
        const assessment = assessDeliveredCadence(result.cadence);
        recordDeliveredCadence(`${mode}-${String(period)}-${key}`, result.cadence);
        const details = JSON.stringify({ key, period, ...result, cadence: assessment });
        if (!result.restingSamples || result.frames < 2 || result.cadence.legs.length < 2) {
          throw new Error(`runner stalled before the moving prompt was observed: ${details}`);
        }
        expect.soft(result.phases, details).toBeGreaterThan(4);
        expect.soft(result.phaseMismatches, details).toBe(0);
        expect.soft(assessment.violations, details).toEqual([]);
        expect.soft(result.hidden, details).toBe(false);
      }
      await input('t'); await evaluate('__pause(650)');
      await input('c'); await evaluate('__pause(900)');
      const centre = await evaluate('__sampleRest(100, 12)') as { covered: number };
      expect(centre.covered, JSON.stringify(centre)).toBe(0);
    }, period);
  }, 120_000);

  it('keeps the waiting alert still through three seconds of split repaint writes', async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, async ({ evaluate }) => {
      // The initial clear-edge decision has its own deadline. Observe the
      // subsequent repaint cadence after that startup placement has settled.
      await evaluate('__pause(1600)');
      const result = await evaluate('__sample(3000, 31)') as {
        placements: string[]; samples: number; hidden: boolean; moves: number; halves: number; rects: number;
        frames: number; frameInterval: number; maxFrameGap: number; frameSpan: number; observedMs: number;
      };
      const details = JSON.stringify(result);
      if (!result.samples || result.frames < 2 || result.halves !== 2 || result.moves <= 30) {
        throw new Error(`runner stalled before both halves of the split writes were observed: ${details}`);
      }
      expect(result.hidden, details).toBe(false);
      expect.soft(result.placements, details).toHaveLength(1);
      expect.soft(result.rects, details).toBeLessThan(20);
      const initial = await evaluate(initialPlacementChecks(mode)) as {
        measurements: { step: string; anchor: string; anchorError: number; capError: number }[];
        destroyedUnchanged: boolean;
      };
      for (const measurement of initial.measurements) {
        expect(measurement.anchor, JSON.stringify(measurement)).not.toBe('auto');
        expect(measurement.anchorError, JSON.stringify(measurement)).toBeLessThan(0.1);
        expect(measurement.capError, JSON.stringify(measurement)).toBeLessThan(0.1);
      }
      expect(initial.destroyedUnchanged, JSON.stringify(initial)).toBe(true);
    });
  }, 90_000);

  it('waits for a real resting move before following it in either direction', async context => {
    if (!browser) { context.skip(); return; }
    await withPage(mode, async ({ evaluate }) => {
      // Stop repainting first, so the delay is measured from the real move.
      const id = (await api(td!.port, td!.token, '/sessions')).body['sessions'] as { id: string }[];
      const input = async (data: string): Promise<void> => {
        expect((await api(td!.port, td!.token, `/sessions/${id[0]!.id}/input`, { body: { data } })).status).toBe(200);
      };
      await input('b');
      // Start each direction from the edge that the next held cursor covers.
      // First prove the lower cursor move was delivered; a prior top placement
      // alone would otherwise make the readiness check pass too early.
      await eventually(async () => await evaluate('__noticeTest.term.buffer.active.cursorY === 48') === true,
        3000, 20, 'the lower resting cursor was not delivered');
      await eventually(async () => await evaluate('__noticeTest.notices.style.top !== "auto"') === true,
        3000, 20, 'the lower cursor rest did not place the notice at the top');
      for (const key of ['t', 'b']) {
        await evaluate(`(() => {
          const state = __noticeTest;
          state.movedAt = null;
          state.before = JSON.stringify(__placement());
          state.changedAt = null;
          state.watch = setInterval(() => {
            if (JSON.stringify(__placement()) !== state.before) state.changedAt ??= performance.now();
          }, 4);
        })()`);
        await input(key);
        const result = await evaluate(`(async () => {
          const state = __noticeTest, start = performance.now();
          while ((state.changedAt === null || state.movedAt === null) && performance.now() - start < 3000) await __pause(10);
          clearInterval(state.watch);
          return { delay: state.changedAt === null ? null : state.changedAt - state.movedAt,
            before: state.before, after: JSON.stringify(__placement()), row: state.term.buffer.active.cursorY };
        })()`) as { delay: number | null; before: string; after: string; row: number };
        const details = JSON.stringify({ key, ...result });
        expect.soft(result.after, details).not.toBe(result.before);
        expect.soft(result.row, details).toBe(key === 't' ? 4 : 48);
        expect.soft(result.delay, details).toBeGreaterThanOrEqual(200);
        expect.soft(result.delay, details).toBeLessThan(1500);
      }
      await input('j');
      const jitter = await evaluate('__sample(1000)') as { placements: string[]; halves: number };
      expect(jitter.halves).toBe(2);
      expect(jitter.placements, JSON.stringify(jitter)).toHaveLength(1);
    });
  }, 90_000);
});
