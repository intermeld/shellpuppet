/** Compare time covered by each edge, including after a session has ended. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { noticeFrameLimitScript } from './noticeFrameLimit.js';
import { assessDeliveredCadence, recordDeliveredCadence } from './noticeCadence.js';
import type { DeliveredCadence } from './noticeCadence.js';

let browser: string | null;
let scratch: string;
beforeAll(async () => {
  browser = await findBrowser();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-covered-time-'));
  fs.copyFileSync(new URL('../../src/viewer/pane.js', import.meta.url), path.join(scratch, 'pane.js'));
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

async function run<T>(mode: string, expression: string): Promise<T[]> {
  const url = (relative: string): string => new URL(relative, import.meta.url).href;
  const page = path.join(scratch, `${mode}.html`);
  fs.writeFileSync(page, `<!doctype html><link rel="stylesheet" href="${url('../../node_modules/@xterm/xterm/css/xterm.css')}">
    <link rel="stylesheet" href="${url(`../../src/viewer/${mode === 'viewer' ? 'viewer' : 'dashboard'}.css`)}">
    <script src="${url('../../node_modules/@xterm/xterm/lib/xterm.js')}"></script>
    <script src="${pathToFileURL(path.join(scratch, 'pane.js')).href}"></script>
    <script src="${url('../fixtures/notice-occupancy-browser.js')}"></script>
    <script src="${url('../fixtures/notice-delivered-browser.js')}"></script>
    <script src="${url('../fixtures/notice-covered-time-browser.js')}"></script>`);
  const result = await captureViewer({ browser: browser!, viewerUrl: pathToFileURL(page).href,
    cpuThrottlingRate: Number(process.env['NOTICE_CPU_RATE'] ?? 1),
    beforeNavigateScript: noticeFrameLimitScript,
    width: 1000, height: 900, drive: true, probeOnly: true, timeoutMs: 300_000,
    probe: '!!window.noticeCoveredTimeCases', interact: async ({ evaluate }) => {
      await evaluate('window.__stopCaseFrames = noticeFrameTiming()');
      const cases = await evaluate(expression) as Record<string, unknown>[];
      const timing = await evaluate('__stopCaseFrames()') as Record<string, unknown>;
      return cases.map(item => ({ ...timing, samples: timing['frames'], ...item }));
    },
  });
  return result.probe as T[];
}

interface Rest {
  samples: number; covered: number; follow: number | null; placements: string[];
  weights: Record<string, number>; restRows: number[]; rects: number; expectedSide: string; initialSide: string;
  frames: number; frameInterval: number; maxFrameGap: number; frameSpan: number; observedMs: number;
  deadlineFrame: number | null; clearFrame: number | null;
  firstLowerLeg: number | null;
}
interface Moving { interval: number; legs: Rest[]; sustained: Rest[]; final: { overlap: boolean }; cadence: DeliveredCadence }
interface Layout { steps: { name: string; anchorError: number; capError: number; heightError: number }[] }

describe.each(['viewer', 'dashboard'])('%s covered notice time', mode => {
  for (const kind of ['plurality', 'adjacent', 'equal']) {
    it(`keeps the correct edge through ${kind} repaints at 24 and 150 rows`, async context => {
      if (!browser) { context.skip(); return; }
      const results = await run<Rest>(mode, `noticeCoveredTimeCases(${JSON.stringify(mode)}, ${JSON.stringify(kind)})`);
      if (process.env['NOTICE_DIAGNOSTICS']) process.stderr.write(JSON.stringify({ mode, kind, results }) + '\n');
      for (const result of results) {
        const details = JSON.stringify(result);
        expect.soft(result.samples, details).toBeGreaterThan(0);
        expect.soft(result.frames, details).toBeGreaterThanOrEqual(Math.floor(result.frameSpan / 200));
        expect.soft(result.frameInterval, details).toBeLessThan(200);
        expect.soft(result.maxFrameGap, details).toBeLessThan(500);
        expect.soft(result.frameSpan, details).toBeGreaterThan(2000);
        expect.soft(result.observedMs - result.frameSpan, details).toBeLessThan(500);
        expect.soft(result.covered, details).toBe(0);
        expect.soft(result.placements, details).toEqual([result.expectedSide]);
        if (kind === 'plurality') expect.soft(result.initialSide, details).toBe('bottom');
        expect.soft(result.rects, details).toBeLessThan(20);
        if (kind === 'plurality') expect.soft(result.firstLowerLeg, details).toBeLessThan(1000);
        if (kind !== 'equal') {
          expect.soft(result.follow, details).not.toBeNull();
          // Start follows appearance by 50 ms. Placement is measured on each
          // completed frame through the 2.5 s startup deadline.
          expect.soft(result.deadlineFrame, details).not.toBeNull();
          expect.soft(result.clearFrame, details).not.toBeNull();
          expect.soft(result.clearFrame! - result.deadlineFrame!, details).toBeLessThanOrEqual(1);
          // Verify the actual xterm event durations, not just timer requests.
          const total = Object.values(result.weights).reduce((sum, duration) => sum + duration, 0);
          const rest = result.restRows.reduce((sum, row) => sum + (result.weights[String(row)] ?? 0), 0);
          expect.soft(rest / total, details).toBeGreaterThan(0.35);
          expect.soft(Math.max(...Object.values(result.weights)) / total, details).toBeLessThan(0.6);
        }
      }
    }, 210_000);
  }
  it('applies the repaint budget to moving dominant rows and clears a genuine rest', async context => {
    if (!browser) { context.skip(); return; }
    const results = await run<Moving>(mode, `noticeMovingRestCases(${JSON.stringify(mode)}, true)`);
    for (const [index, result] of results.entries()) {
      expect.soft(result.legs).toHaveLength(4);
      expect.soft(result.sustained).toHaveLength(2);
      const assessment = assessDeliveredCadence(result.cadence);
      recordDeliveredCadence('moving-' + mode + '-' + String(index), result.cadence);
      const details = JSON.stringify({ ...result, cadence: assessment });
      // A dominant row revisited between excursions is not a genuine rest.
      // All phases and the final quiet frame face the delivered contract.
      for (const leg of [...result.legs, ...result.sustained]) {
        expect.soft(leg.samples, details).toBeGreaterThan(0);
      }
      expect.soft(assessment.violations, details).toEqual([]);
      expect.soft(assessment.rests.length, details).toBeGreaterThan(0);
      expect.soft(result.final.overlap, details).toBe(false);
    }
  }, 330_000);
  it('anchors and caps explicit layout after every session end', async context => {
    if (!browser) { context.skip(); return; }
    const results = await run<Layout>(mode, `noticeEndedLayoutCases(${JSON.stringify(mode)})`);
    for (const result of results) for (const step of result.steps) {
      const details = JSON.stringify({ ...result, step });
      expect.soft(step.anchorError, details).toBeLessThan(0.1);
      expect.soft(step.capError, details).toBeLessThan(0.1);
      expect.soft(step.heightError, details).toBeLessThan(0.1);
    }
  }, 90_000);
});
