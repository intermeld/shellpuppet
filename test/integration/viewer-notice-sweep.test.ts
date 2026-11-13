/** Real-clock delivered cadence sweep in both pane modes and grid heights. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { assessDeliveredCadence, deliveredChanges, recordDeliveredCadence } from './noticeCadence.js';
import type { DeliveredCadence } from './noticeCadence.js';

let browser: string | null;
let scratch: string;
beforeAll(async () => {
  browser = await findBrowser();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-notice-sweep-'));
  fs.copyFileSync(process.env.NOTICE_PANE_SOURCE || new URL('../../src/viewer/pane.js', import.meta.url), path.join(scratch, 'pane.js'));
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

interface Spec { rows: number; cycle: number; stages: number; ratio: number; inside: boolean;
  label?: string; initial?: string; duration?: number; spinner?: boolean; delayLower?: number;
  directLegs?: number[][]; legs?: (string | number)[][]; continuation?: string }
interface Sweep extends Spec { cadence: DeliveredCadence; initialSide: string }

const cases: Spec[] = [24, 150].flatMap(rows => [300, 1300, 3000].flatMap(cycle =>
  [2, 3, 4, 5].flatMap(stages => [0.25, 0.55, 1].map((ratio, index) => ({
    rows, cycle, stages, ratio, inside: (rows === 24 ? 0 : 1) === (index + stages) % 2,
  })))));
for (const rows of [24, 150]) {
  cases.push({ rows, cycle: 1300, stages: 2, ratio: 1, inside: false, spinner: true });
  for (const durations of [[100, 900, 900, 900], [100, 900, 900, 900, 900], [400, 400, 500, 900],
    [900, 900, 900, 900, 900], [1100, 300, 400, 300, 400, 300, 1100]]) {
    cases.push({ rows, cycle: durations.reduce((a, b) => a + b), stages: durations.length,
      ratio: durations[0]! / durations.at(-1)!, inside: false,
      directLegs: durations.map((ms, i) => [i === 0 ? 0 : i === durations.length - 1 ? rows - 2 :
        Math.floor(rows / 3) + (i - 1) % Math.floor(rows / 3), ms]) });
  }
  for (const cycle of [1300, 2800, 4500, 6000, 9000, 12000, 15000]) for (const shape of ['equal', 'clear', 'uneven']) {
    const stages = Math.max(3, Math.ceil(cycle / 750));
    const base = cycle / stages;
    const top = shape === 'equal' ? base : base / 3;
    const bottom = base;
    const middle = (cycle - top - bottom) / (stages - 2);
    const durations = [top, ...Array.from({ length: stages - 2 }, (_, i) =>
      middle + (shape === 'uneven' && stages > 3 ? (i % 2 ? -1 : 1) * 50 : 0)), bottom];
    durations[durations.length - 2]! += cycle - durations.reduce((sum, ms) => sum + ms, 0);
    cases.push({ rows, cycle, stages, ratio: top / bottom, inside: false, label: shape + '-' + cycle,
      duration: cycle > 10000 ? cycle * 3 + 400 : undefined,
      directLegs: durations.map((ms, i) => [i === 0 ? 0 : i === stages - 1 ? rows - 2 :
        Math.floor(rows / 3) + (i - 1) % Math.floor(rows / 3), ms]) });
  }
  cases.push({ rows, cycle: 1800, stages: 4, ratio: 1, inside: false, label: 'rectangle-bottom-rest',
    directLegs: [[0, 450], [rows - 2, 600], [rows - 1, 600], [Math.floor(rows / 2), 150]] });
  const p = [[0, 850], [rows - 2, 450]];
  const q = [...p, ...p, [rows - 1, 900], [rows - 2, 900], [rows - 1, 100]];
  const r = [...q, [0, 400], ...Array.from({ length: 5 }, (_, i) => [Math.floor(rows / 3) + i, 820])];
  for (const [label, legs] of [['P', p], ['Q', q], ['R', r]] as const) {
    cases.push({ rows, cycle: legs.reduce((sum, leg) => sum + leg[1]!, 0), stages: legs.length,
      ratio: 1, inside: false, label, initial: 'top', duration: 26500, directLegs: legs });
  }
  for (const continuation of ['repaint', 'rest']) cases.push({ rows, cycle: 2600, stages: 4, ratio: 1,
    inside: false, label: 'A/B-' + continuation, initial: 'top', duration: 15500, directLegs: [...p, ...p], continuation });
}
if (process.env.NOTICE_NEGATIVE_CONTROL) {
  cases.splice(0, cases.length, ...[24, 150].map(rows => ({
    rows, cycle: 1300, stages: 2, ratio: 1, inside: false, initial: 'top', delayLower: 200,
  })));
}
if (process.env.NOTICE_SWEEP_FOCUS) {
  const labels = new Set(process.env.NOTICE_SWEEP_FOCUS.split(','));
  cases.splice(0, cases.length, ...cases.filter(item => labels.has(item.label ?? '')));
}
if (process.env.NOTICE_SWEEP_INDEX) {
  const selected = cases[Number(process.env.NOTICE_SWEEP_INDEX)];
  cases.splice(0, cases.length, ...(selected ? [selected] : []));
}

if (!process.env.NOTICE_SWEEP_FULL && !process.env.NOTICE_SWEEP_FOCUS && !process.env.NOTICE_SWEEP_INDEX &&
  !process.env.NOTICE_NEGATIVE_CONTROL) {
  // The whole grid runs for about ten minutes per mode on the real clock, so
  // NOTICE_SWEEP_FULL=1 asks for it. By default, the named cadences at 80x24.
  const named = new Set(['P', 'R', 'A/B-rest', 'rectangle-bottom-rest', 'equal-4500', 'clear-1300']);
  cases.splice(0, cases.length, ...cases.filter(item => item.rows === 24 && named.has(item.label ?? '')));
}

describe.each(['viewer', 'dashboard'])('%s notice cadence sweep', mode => {
  it('judges every delivered rest and repaint stretch across cycle lengths', async context => {
    if (!browser) { context.skip(); return; }
    const url = (relative: string): string => new URL(relative, import.meta.url).href;
    const page = path.join(scratch, mode + '.html');
    fs.writeFileSync(page, '<!doctype html><link rel="stylesheet" href="' + url('../../node_modules/@xterm/xterm/css/xterm.css') +
      '"><link rel="stylesheet" href="' + url('../../src/viewer/' + mode + '.css') +
      '"><script src="' + url('../../node_modules/@xterm/xterm/lib/xterm.js') +
      '"></script><script src="' + pathToFileURL(path.join(scratch, 'pane.js')).href +
      '"></script><script src="' + url('../fixtures/notice-occupancy-browser.js') +
      '"></script><script src="' + url('../fixtures/notice-delivered-browser.js') +
      '"></script><script src="' + url('../fixtures/notice-sweep-browser.js') + '"></script>');
    const result = await captureViewer({ browser, viewerUrl: pathToFileURL(page).href,
      width: 1000, height: 900, drive: true, probeOnly: true, timeoutMs: 700000,
      probe: '!!window.noticeSweepCases',
      interact: ({ evaluate }) => evaluate('noticeSweepCases(' + JSON.stringify(mode) + ',' + JSON.stringify(cases) + ')'),
    });
    const results = result.probe as Sweep[];
    const evidence = process.env.NOTICE_EVIDENCE_DIR;
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'sweep-' + mode + '.json'), JSON.stringify(results));
    }
    expect(results).toHaveLength(cases.length);
    for (const [index, item] of results.entries()) {
      const assessment = assessDeliveredCadence(item.cadence);
      const details = JSON.stringify({ ...item, cadence: assessment });
      recordDeliveredCadence('sweep-' + mode + '-' + index, item.cadence);
      expect.soft(item.cadence.legs.length, details).toBeGreaterThan(2);
      expect.soft(assessment.violations, details).toEqual([]);
      if (['P', 'Q', 'R'].includes(item.label ?? '')) {
        const changes = deliveredChanges(item.cadence);
        expect.soft(changes[0]?.side, details).toBe('bottom');
        expect.soft(changes[0]?.time, details).toBeLessThanOrEqual(2500);
        if (item.label === 'P') expect.soft(changes.length, details).toBe(1);
        else expect.soft(changes.some(change => change.side === 'top'), details).toBe(true);
      }
      if (item.cycle >= 12000 && !assessment.rests.length) {
        const changes = deliveredChanges(item.cadence);
        const afterCorrectionCycle = changes.filter(change => change.time > item.cycle * 2 + 250);
        expect.soft(afterCorrectionCycle.length, details).toBe(0);
        if (item.label?.startsWith('equal-')) {
          const afterFirstCycle = changes.filter(change => change.time > item.cycle + 250);
          expect.soft(afterFirstCycle.length, details).toBe(0);
        }
      }
      if (item.label === 'rectangle-bottom-rest') {
        expect.soft(assessment.rests.some(rest => (rest as { edge?: string }).edge === 'bottom'), details).toBe(true);
      }
    }
  }, 720000);
});
