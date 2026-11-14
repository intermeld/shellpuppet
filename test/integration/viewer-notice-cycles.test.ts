/** Complete repaint cycles and initial snapshots in both pane modes. */
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-notice-cycles-'));
  fs.copyFileSync(new URL('../../src/viewer/pane.js', import.meta.url), path.join(scratch, 'pane.js'));
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

async function run<T>(mode: string, expression: string): Promise<T[]> {
  const url = (relative: string): string => new URL(relative, import.meta.url).href;
  const page = path.join(scratch, `${mode}.html`);
  fs.writeFileSync(page, `<!doctype html><link rel="stylesheet" href="${url('../../node_modules/@xterm/xterm/css/xterm.css')}">
    <link rel="stylesheet" href="${url(`../../src/viewer/${mode}.css`)}">
    <script src="${url('../../node_modules/@xterm/xterm/lib/xterm.js')}"></script>
    <script src="${pathToFileURL(path.join(scratch, 'pane.js')).href}"></script>
    <script src="${url('../fixtures/notice-occupancy-browser.js')}"></script>
    <script src="${url('../fixtures/notice-cycle-browser.js')}"></script>`);
  const result = await captureViewer({ browser: browser!, viewerUrl: pathToFileURL(page).href,
    cpuThrottlingRate: Number(process.env['NOTICE_CPU_RATE'] ?? 1),
    width: 1000, height: 900, drive: true, probeOnly: true, timeoutMs: 90_000,
    probe: '!!window.noticeSnapshotCases', interact: async ({ evaluate }) => {
      await evaluate('window.__stopCaseFrames = noticeFrameTiming()');
      const cases = await evaluate(expression) as Record<string, unknown>[];
      const timing = await evaluate('__stopCaseFrames()') as Record<string, unknown>;
      return cases.map(item => ({ ...timing, samples: timing['frames'], ...item }));
    },
  });
  return result.probe as T[];
}

interface EqualLayout {
  changes: unknown[]; layouts: { height: number; anchorError: number; capError: number }[];
}
interface Nested { samples: number; covered: number; restSamples: number; coveredAtRest: number; changes: unknown[] }
interface Snapshot {
  ended: boolean; ready: { overlap: boolean; row: number }; rows: number; ordinaryReads: number;
  tracking: number;
  destroyed?: boolean; unchanged?: boolean; reads?: number;
}
interface HorizontalRest { rows: number; samples: number; covered: number; follow: number | null;
  visits: { row: number; at: number }[]; rects: number; frames: number; frameInterval: number;
  frameSpan: number; observedMs: number; deadlineFrame: number | null; clearFrame: number | null }

describe.each(['viewer', 'dashboard'])('%s notice repaint boundaries', mode => {
  for (const kind of ['height', 'refresh']) it(`keeps both initial edges during equal alternation with late ${kind} updates`, async context => {
    if (!browser) { context.skip(); return; }
    const results = await run<EqualLayout>(mode, `noticeEqualLayoutCases(${JSON.stringify(mode)}, ${JSON.stringify(kind)})`);
    for (const result of results) {
      const details = JSON.stringify(result);
      expect.soft(result.changes, details).toEqual([]);
      expect.soft(result.layouts, details).toHaveLength(12);
      for (const layout of result.layouts) {
        expect.soft(layout.anchorError, details).toBeLessThan(0.1);
        expect.soft(layout.capError, details).toBeLessThan(0.1);
      }
      if (kind === 'height') expect.soft(new Set(result.layouts.map(layout => layout.height)).size, details).toBeGreaterThan(1);
    }
  }, 120_000);
  for (const timing of [[30, 290, 30, 300], [160, 290, 30, 450]]) {
    it(`ignores a nested header return with ${timing.join('/')} ms legs`, async context => {
      if (!browser) { context.skip(); return; }
      const results = await run<Nested>(mode, `noticeNestedReturnCases(${JSON.stringify(mode)}, ${JSON.stringify(timing)})`);
      for (const result of results) {
        const details = JSON.stringify(result);
        expect.soft(result.samples, details).toBeGreaterThan(100);
        expect.soft(result.restSamples, details).toBeGreaterThan(100);
        expect.soft(result.covered, details).toBe(0);
        expect.soft(result.coveredAtRest, details).toBe(0);
        expect.soft(result.changes, details).toEqual([]);
      }
    }, 60_000);
  }
  it('places after initial snapshot parsing, including ended panes, without measuring ordinary chunks', async context => {
    if (!browser) { context.skip(); return; }
    const results = await run<Snapshot>(mode, `noticeSnapshotCases(${JSON.stringify(mode)})`);
    for (const result of results) {
      const details = JSON.stringify(result);
      if (result.destroyed) {
        expect.soft(result.unchanged, details).toBe(true);
        expect.soft(result.reads, details).toBe(0);
      } else {
        expect.soft(result.ready.row, details).toBe(result.rows - 2);
        expect.soft(result.ready.overlap, details).toBe(false);
        expect.soft(result.ordinaryReads, details).toBe(0);
        expect.soft(result.tracking, details).toBe(result.ended ? 0 : 1);
      }
    }
  }, 60_000);
  it('follows a settled row while typing or animating horizontally', async context => {
    if (!browser) { context.skip(); return; }
    const results = await run<HorizontalRest>(mode, `noticeHorizontalRestCases(${JSON.stringify(mode)})`);
    if (process.env['NOTICE_DIAGNOSTICS']) process.stderr.write(JSON.stringify({ mode, results }) + '\n');
    for (const result of results) {
      const details = JSON.stringify(result);
      expect.soft(result.visits.length, details).toBeGreaterThan(10);
      expect.soft([...new Set(result.visits.map(visit => visit.row))], details).toEqual([result.rows - 2]);
      expect.soft(result.samples, details).toBeGreaterThan(5);
      expect.soft(result.frames, details).toBeGreaterThan(20);
      expect.soft(result.frameInterval, details).toBeLessThan(200);
      expect.soft(result.frameSpan, details).toBeGreaterThan(1500);
      expect.soft(result.observedMs - result.frameSpan, details).toBeLessThan(500);
      expect.soft(result.covered, details).toBe(0);
      expect.soft(result.follow, details).not.toBeNull();
      expect.soft(result.deadlineFrame, details).not.toBeNull();
      expect.soft(result.clearFrame, details).not.toBeNull();
      expect.soft(result.clearFrame! - result.deadlineFrame!, details).toBeLessThanOrEqual(1);
      expect.soft(result.rects, details).toBeLessThan(10);
    }
  }, 60_000);
});
