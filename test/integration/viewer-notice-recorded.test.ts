/** Replay a captured loaded repaint with real writes, clocks and pane timers. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { assessDeliveredCadence, recordDeliveredCadence } from './noticeCadence.js';
import type { DeliveredCadence } from './noticeCadence.js';

let browser: string | null;
let scratch: string;
const recorded = JSON.parse(fs.readFileSync(new URL('../fixtures/notice-recorded-ratio.json', import.meta.url), 'utf8')) as { end: number; legs: { row: number; start: number }[] };
beforeAll(async () => {
  browser = await findBrowser();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-notice-recorded-'));
  fs.copyFileSync(process.env.NOTICE_PANE_SOURCE || new URL('../../src/viewer/pane.js', import.meta.url), path.join(scratch, 'pane.js'));
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe.each(['viewer', 'dashboard'])('%s recorded notice repaint', mode => {
  for (const periodic of [false, true]) it(periodic ? 'holds through periodic 13.1 s repetition' :
    'holds through three captured replays at both heights', async context => {
    if (!browser) { context.skip(); return; }
    const url = (relative: string): string => new URL(relative, import.meta.url).href;
    const page = path.join(scratch, mode + '.html');
    fs.writeFileSync(page, '<!doctype html><link rel="stylesheet" href="' + url('../../node_modules/@xterm/xterm/css/xterm.css') +
      '"><link rel="stylesheet" href="' + url('../../src/viewer/' + mode + '.css') +
      '"><script src="' + url('../../node_modules/@xterm/xterm/lib/xterm.js') +
      '"></script><script src="' + pathToFileURL(path.join(scratch, 'pane.js')).href +
      '"></script><script src="' + url('../fixtures/notice-occupancy-browser.js') +
      '"></script><script src="' + url('../fixtures/notice-delivered-browser.js') +
      '"></script><script src="' + url('../fixtures/notice-recorded-browser.js') + '"></script>');
    const specs = [24, 150].flatMap(rows => Array.from({ length: periodic ? 1 : 3 }, (_, repeat) => ({ rows, repeat })));
    const result = await captureViewer({ browser, viewerUrl: pathToFileURL(page).href, width: 1000, height: 900,
      drive: true, probeOnly: true, timeoutMs: 90000, probe: '!!window.replayRecordedNotice',
      interact: ({ evaluate }) => evaluate('Promise.all(' + JSON.stringify(specs) + '.map(spec=>replayRecordedNotice(' +
        JSON.stringify(mode) + ',spec.rows,' + JSON.stringify(recorded) + ',' + (periodic ? '2' : '1') + ')))'),
    });
    const results = result.probe as { rows: number; cadence: DeliveredCadence }[];
    expect(results).toHaveLength(specs.length);
    for (const [index, item] of results.entries()) {
      const assessment = assessDeliveredCadence(item.cadence);
      recordDeliveredCadence('recorded-' + mode + '-' + (periodic ? 'periodic-' : '') + index, item.cadence);
      expect.soft(item.cadence.legs.length).toBeGreaterThan(20);
      expect.soft(assessment.violations, JSON.stringify({ rows: item.rows, assessment })).toEqual([]);
    }
  }, 120000);
});
