/** Notice placement must follow time spent at a row, and dispose its work. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';

let browser: string | null;
let scratch: string;
beforeAll(async () => {
  browser = await findBrowser();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-notice-'));
  fs.copyFileSync(new URL('../../src/viewer/pane.js', import.meta.url), path.join(scratch, 'pane.js'));
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

interface Placement { overlap: boolean }
interface Occupancy {
  samples: number; covered: number; placements: string[]; rects: number; final: Placement;
  frames: number; frameInterval: number; frameSpan: number; observedMs: number;
  lower: Placement; upper: Placement; edge: Placement; font: Placement; limit: Placement; scale: Placement;
  shown: Placement; fitted: Placement; resized: Placement;
}
interface Pending { frames: number; timers: number; listeners: number; observers: number; callbacks: number }
interface Disposal { pending: string; before: Pending; immediate: Pending; after: Pending; repeated: Pending }

async function run<T>(mode: string, expression: string): Promise<T[]> {
  const url = (relative: string): string => new URL(relative, import.meta.url).href;
  const page = path.join(scratch, `${mode}.html`);
  fs.writeFileSync(page, `<!doctype html><link rel="stylesheet" href="${url('../../node_modules/@xterm/xterm/css/xterm.css')}">
    <link rel="stylesheet" href="${url(`../../src/viewer/${mode === 'viewer' ? 'viewer' : 'dashboard'}.css`)}">
    <script src="${url('../../node_modules/@xterm/xterm/lib/xterm.js')}"></script>
    <script src="${pathToFileURL(path.join(scratch, 'pane.js')).href}"></script>
    <script src="${url('../fixtures/notice-occupancy-browser.js')}"></script>`);
  const result = await captureViewer({ browser: browser!, viewerUrl: pathToFileURL(page).href,
    cpuThrottlingRate: Number(process.env['NOTICE_CPU_RATE'] ?? 1),
    width: 1000, height: 900, drive: true, probeOnly: true, timeoutMs: 180_000,
    probe: '!!window.noticeOccupancyCases', interact: async ({ evaluate }) => {
      await evaluate('window.__stopCaseFrames = noticeFrameTiming()');
      const cases = await evaluate(expression) as Record<string, unknown>[];
      const timing = await evaluate('__stopCaseFrames()') as Record<string, unknown>;
      return cases.map(item => ({ ...timing, samples: timing['frames'], ...item }));
    },
  });
  return result.probe as T[];
}

describe.each(['viewer', 'dashboard'])('%s notice occupancy', mode => {
  for (const kind of ['dominant', 'quiet', 'alternation']) {
    it(`keeps the resting row uncovered during ${kind}`, async context => {
      if (!browser) { context.skip(); return; }
      const results = await run<Occupancy>(mode, `noticeOccupancyCases(${JSON.stringify(mode)}, ${JSON.stringify(kind)})`);
      for (const result of results) {
        const details = JSON.stringify(result);
        if (kind === 'quiet') {
          for (const key of ['lower', 'upper', 'edge', 'font', 'limit', 'scale'] as const) {
            expect.soft(result[key].overlap, `${key}: ${details}`).toBe(false);
          }
        } else {
          expect.soft(result.samples, details).toBeGreaterThan(kind === 'dominant' ? 5 : 20);
          expect.soft(result.frames, details).toBeGreaterThan(20);
          expect.soft(result.frameInterval, details).toBeLessThan(200);
          expect.soft(result.frameSpan, details).toBeGreaterThan(2500);
          expect.soft(result.observedMs - result.frameSpan, details).toBeLessThan(500);
          expect.soft(result.covered, details).toBe(0);
          expect.soft(result.placements, details).toEqual(['top']);
          if (kind === 'dominant') {
            expect.soft(result.rects, details).toBeLessThan(20);
            for (const key of ['shown', 'fitted', 'resized'] as const) {
              expect.soft(result[key].overlap, `${key}: ${details}`).toBe(false);
            }
          }
          else expect.soft(result.final.overlap, details).toBe(false);
        }
      }
    }, 210_000);
  }
  it('cancels pending work and disposes listeners at destroy and every session end', async context => {
    if (!browser) { context.skip(); return; }
    const results = await run<Disposal>(mode, `noticeDisposalCases(${JSON.stringify(mode)})`);
    for (const result of results) {
      const details = JSON.stringify(result);
      expect.soft(result.before[result.pending === 'frame' ? 'frames' : 'timers'], details).toBeGreaterThan(0);
      expect.soft(result.before.listeners, details).toBe(1);
      for (const key of ['immediate', 'after', 'repeated'] as const) {
        expect.soft(result[key].frames, details).toBe(0);
        expect.soft(result[key].timers, details).toBe(0);
        expect.soft(result[key].listeners, details).toBe(0);
        expect.soft(result[key].observers, details).toBe(0);
        expect.soft(result[key].callbacks, details).toBe(result.immediate.callbacks);
      }
    }
  }, 90_000);
  it('places a prompt clear at once after the notice was hidden for the whole history', async context => {
    if (!browser) { context.skip(); return; }
    interface Measure { side: string; overlap: boolean; height: number }
    const result = (await run<{ first: Measure; immediate: Measure; afterFrame: Measure; later: Measure }>(mode, `(async () => {
      const p = makeNoticePane(${JSON.stringify(mode)}, 24);
      await p.move(0); p.show(); await noticePause(1200); const first = p.measure();
      p.control({ type: 'prompt-clear' }); await noticePause(10500);
      await p.move(22);
      p.control({ type: 'prompt-stall', question: 'Replace the existing file?', waitingMs: 300,
        options: ['1. Replace', '2. Keep both', '3. Cancel'] });
      const immediate = p.measure(); await noticePause(60); const afterFrame = p.measure();
      await noticePause(600); const later = p.measure();
      p.destroy(); return [{ first, immediate, afterFrame, later }];
    })()`))[0]!;
    const details = JSON.stringify(result);
    expect.soft(result.first.side, details).toBe('bottom');
    expect.soft(result.first.overlap, details).toBe(false);
    for (const key of ['immediate', 'afterFrame', 'later'] as const) {
      expect.soft(result[key].height, `${key}: ${details}`).toBeGreaterThan(0);
      expect.soft(result[key].overlap, `${key}: ${details}`).toBe(false);
    }
  }, 120_000);
  it('keeps the existing cadence when a prompt control repeats or briefly clears', async context => {
    if (!browser) { context.skip(); return; }
    interface Measure { side: string; overlap: boolean }
    const result = (await run<{ first: Measure; repeated: Measure; rested: Measure; reannounced: Measure }>(mode, `(async () => {
      const p = makeNoticePane(${JSON.stringify(mode)}, 24);
      await p.move(0); p.show(); await noticePause(1200); const first = p.measure();
      await p.move(22); p.show(); const repeated = p.measure();
      await noticePause(1400); const rested = p.measure();
      p.control({ type: 'prompt-clear' }); await noticePause(400); await p.move(0); p.show();
      const reannounced = p.measure();
      p.destroy(); return [{ first, repeated, rested, reannounced }];
    })()`))[0]!;
    const details = JSON.stringify(result);
    expect.soft(result.first.side, details).toBe('bottom');
    // A repeat is not a new notice: only the one-second rest may move it.
    expect.soft(result.repeated.side, details).toBe('bottom');
    expect.soft(result.rested.side, details).toBe('top');
    expect.soft(result.rested.overlap, details).toBe(false);
    // A prompt re-announced after a brief clear keeps that cadence too.
    expect.soft(result.reannounced.side, details).toBe('top');
  }, 90_000);
  it('places a replayed prompt as a new notice after the pane reconnects', async context => {
    if (!browser) { context.skip(); return; }
    interface Measure { side: string; overlap: boolean; height: number }
    const result = (await run<{ first: Measure; stale: boolean; immediate: Measure; afterFrame: Measure; later: Measure }>(mode, `(async () => {
      const p = makeNoticePane(${JSON.stringify(mode)}, 24);
      const alert = document.getElementById('prompt-alert');
      await p.move(0); p.show(); await noticePause(1200); const first = p.measure();
      // The clear for that prompt is lost with the connection.
      await p.reconnect(); const stale = !alert.hidden;
      p.binary('\x1b[H\x1b[2J'); await p.move(22);
      p.control({ type: 'prompt-stall', question: 'Replace the existing file?', waitingMs: 20000,
        options: ['1. Replace', '2. Keep both', '3. Cancel'] });
      const immediate = p.measure(); await noticePause(60); const afterFrame = p.measure();
      await noticePause(600); const later = p.measure();
      p.destroy(); return [{ first, stale, immediate, afterFrame, later }];
    })()`))[0]!;
    const details = JSON.stringify(result);
    expect.soft(result.first.side, details).toBe('bottom');
    expect.soft(result.stale, details).toBe(false);
    for (const key of ['immediate', 'afterFrame', 'later'] as const) {
      expect.soft(result[key].height, `${key}: ${details}`).toBeGreaterThan(0);
      expect.soft(result[key].overlap, `${key}: ${details}`).toBe(false);
    }
  }, 90_000);
  it('places a replayed prompt from the reconnect snapshot that follows it', async context => {
    if (!browser) { context.skip(); return; }
    interface Measure { side: string; overlap: boolean; height: number }
    const result = (await run<{ first: Measure; parsed: Measure; placed: Measure; afterFrame: Measure; later: Measure }>(
      mode, `(async () => {
      const p = makeNoticePane(${JSON.stringify(mode)}, 24);
      await p.move(0); p.show(); await noticePause(1200); const first = p.measure();
      // The daemon sends the replayed prompt directly and the snapshot when
      // it has been drawn, so the prompt can arrive first.
      await p.reconnect();
      p.control({ type: 'prompt-stall', question: 'Replace the existing file?', waitingMs: 20000,
        options: ['1. Replace', '2. Keep both', '3. Cancel'] });
      p.binary('\x1b[H\x1b[2J\x1b[23;1H');
      // The next write's callback runs straight after the snapshot is parsed,
      // before a frame or a cursor sample could place the notice.
      const parsed = await new Promise(resolve => p.term.write('', () => resolve(p.measure())));
      await p.move(22);
      const placed = p.measure(); await noticePause(60); const afterFrame = p.measure();
      await noticePause(600); const later = p.measure();
      p.destroy(); return [{ first, parsed, placed, afterFrame, later }];
    })()`))[0]!;
    const details = JSON.stringify(result);
    expect.soft(result.first.side, details).toBe('bottom');
    for (const key of ['parsed', 'placed', 'afterFrame', 'later'] as const) {
      expect.soft(result[key].height, `${key}: ${details}`).toBeGreaterThan(0);
      expect.soft(result[key].overlap, `${key}: ${details}`).toBe(false);
    }
  }, 90_000);
  it('places a provider stall or a prompt clear at once when one follows the other', async context => {
    if (!browser) { context.skip(); return; }
    interface Measure { side: string; overlap: boolean; height: number }
    const result = (await run<{ first: Measure; immediate: Measure; afterFrame: Measure; later: Measure;
      replaced: Measure; replacedFrame: Measure }>(mode, `(async () => {
      const p = makeNoticePane(${JSON.stringify(mode)}, 24);
      await p.move(0); p.show(); await noticePause(1200); const first = p.measure();
      p.control({ type: 'prompt-clear' }); await noticePause(1500);
      await p.move(22);
      p.control({ type: 'session-stalled', stalled: { reason: 'provider-refused',
        since: '2026-01-01T00:00:00.000Z', description: 'The provider declined to answer.' } });
      const immediate = p.measure(); await noticePause(60); const afterFrame = p.measure();
      await noticePause(600); const later = p.measure();
      // A prompt that replaces the visible stall is a different notice too.
      await p.move(0); p.show(); const replaced = p.measure();
      await noticePause(60); const replacedFrame = p.measure();
      p.destroy(); return [{ first, immediate, afterFrame, later, replaced, replacedFrame }];
    })()`))[0]!;
    const details = JSON.stringify(result);
    expect.soft(result.first.side, details).toBe('bottom');
    for (const key of ['immediate', 'afterFrame', 'later', 'replaced', 'replacedFrame'] as const) {
      expect.soft(result[key].height, `${key}: ${details}`).toBeGreaterThan(0);
      expect.soft(result[key].overlap, `${key}: ${details}`).toBe(false);
    }
  }, 90_000);
});
