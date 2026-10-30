/**
 * Two geometry claims of design §5, in a real browser.
 *
 * The wire-level tests prove what the daemon answers; these prove what the
 * page then does with it, which is where both claims actually live:
 *
 * 1. A held grid in a window of another shape keeps bars on one axis and
 *    scales its text to the other. The page fills what it can by changing the
 *    font, never by reshaping a grid that is not its to change, and proposes
 *    nothing.
 * 2. With one page driving and a second adopting, a deliberate act by the
 *    second hands control over: the narrow page asks, the daemon answers
 *    `yours` to it and `adopt` to the old driver, and the grid becomes the
 *    narrow page's.
 *
 * Two pages run at once, in headless Chromium, through the same capture
 * harness the screenshot route uses. Skipped where no Chromium-family browser
 * is installed.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

function fixturePath(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);
}

let td: TestDaemon;
let browser: string | null = null;

beforeAll(async () => {
  td = await startTestDaemon();
  browser = await findBrowser();
}, 60_000);

afterAll(async () => {
  await td.stop();
});

/** Start the partial-repaint fixture at 100x30 and wait out its churn. */
async function paintedSession(hold: boolean): Promise<string> {
  const started = await api(td.port, td.token, '/sessions', {
    body: {
      command: process.execPath,
      args: [fixturePath('partial-repaint-tui.mjs'), '40'],
      shell: false,
      cols: 100,
      rows: 30,
      ...(hold ? { hold: true } : {}),
    },
  });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  const done = await api(td.port, td.token, `/sessions/${id}/wait?text=DONE&timeout=30000`);
  expect(done.body['matched']).toBe(true);
  return id;
}

async function freshViewerUrl(id: string): Promise<string> {
  const minted = await api(td.port, td.token, `/sessions/${id}/viewer`, { body: {} });
  expect(minted.status).toBe(200);
  return String(minted.body['viewerUrl']);
}

/**
 * A settle gate for a probe: returns null until the watched expression has
 * been byte-identical for `stableMs`. State lives on `window` under the given
 * key, so repeated evaluations share it.
 */
function settlePrelude(key: string, watch: string, stableMs: number): string {
  return `const st = (window.${key} = window.${key} || {last: undefined, since: 0});
const now = Date.now();
const watched = ${watch};
if (st.last !== watched) { st.last = watched; st.since = now; }
if (now - st.since < ${String(stableMs)}) return null;`;
}

describe('geometry in the browser (design §5)', () => {
  it('a held grid in a window of another shape: bars on one axis, text scaled, nothing proposed', async (context) => {
    if (browser === null) {
      context.skip();
      return;
    }
    const id = await paintedSession(true);

    // 100x30 into 520x760: at the 13 px default the grid is about 703 px
    // wide, so a 520 px window cannot hold it. The text must scale down to
    // the width, which leaves the height short: bars on the vertical axis.
    const capture = await captureViewer({
      browser,
      viewerUrl: await freshViewerUrl(id),
      width: 520,
      height: 760,
      drive: true,
      timeoutMs: 90_000,
      probe: `(() => {
        const wrap = document.getElementById('wrap');
        if (!wrap) return null;
        const styles = window.getComputedStyle(wrap);
        const availW = wrap.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
        const availH = wrap.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
        const screen = document.querySelector('.xterm-screen');
        const rowsEl = document.querySelector('#term .xterm-rows');
        if (!screen || !rowsEl) return null;
        const size = document.getElementById('size').textContent;
        // xterm.js applies the font size through a runtime stylesheet rule on
        // the rows, not inline on the terminal element.
        const font = parseFloat(window.getComputedStyle(rowsEl).fontSize);
        ${settlePrelude('__heldProbe', 'size + "|" + screen.offsetWidth + "x" + screen.offsetHeight + "|" + font', 1200)}
        return JSON.stringify({
          size, font, screenW: screen.offsetWidth, screenH: screen.offsetHeight, availW, availH,
        });
      })()`,
    });
    const probe = JSON.parse(String(capture.probe)) as {
      size: string;
      font: number;
      screenW: number;
      screenH: number;
      availW: number;
      availH: number;
    };

    // The page knows the grid is not its to change.
    expect(probe.size).toContain('(fixed)');
    expect(probe.size).toContain('100×30');
    // Text scaled: smaller than the 13 px default, to fit the width...
    expect(probe.font).toBeLessThan(13);
    // ...the width axis is nearly filled...
    expect(probe.screenW).toBeGreaterThan(probe.availW * 0.8);
    // ...and the other axis keeps its bars.
    expect(probe.screenH).toBeLessThan(probe.availH * 0.75);

    // Nothing was proposed: the grid never moved.
    const after = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(after.body['cols']).toBe(100);
    expect(after.body['rows']).toBe(30);
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }, 180_000);

  it('a page that adopts and then acts takes the grid, and the old driver is told', async (context) => {
    if (browser === null) {
      context.skip();
      return;
    }
    const id = await paintedSession(false);

    // Page one finishes only once its size label gains "(following)": that
    // is, only once the daemon has told it that it no longer drives.
    const driverLost = captureViewer({
      browser,
      viewerUrl: await freshViewerUrl(id),
      width: 1100,
      height: 700,
      drive: true,
      timeoutMs: 120_000,
      probe: `(() => {
        const size = document.getElementById('size').textContent;
        if (!size || !size.includes('(following)')) return null;
        ${settlePrelude('__driverLost', 'size', 1000)}
        return size;
      })()`,
    });

    // Let page one connect and take the grid first.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    // Page two: a very narrow viewport. It adopts ("(following)"), then its
    // window is resized, a deliberate act, which must hand control over.
    const narrowActs = captureViewer({
      browser,
      viewerUrl: await freshViewerUrl(id),
      width: 380,
      height: 640,
      drive: true,
      timeoutMs: 120_000,
      probe: `(() => {
        const size = document.getElementById('size').textContent;
        if (!size) return null;
        const m = (window.__act = window.__act || {phase: 0, last: undefined, since: 0});
        const now = Date.now();
        if (m.last !== size) { m.last = size; m.since = now; }
        if (now - m.since < 1000) return null;
        if (m.phase === 0) {
          // Adopted, and stable: now act. The debounce in the page's resize
          // listener is what a real window resize goes through.
          if (!size.includes('(following)')) return null;
          m.phase = 1;
          m.last = '';
          m.since = now;
          window.dispatchEvent(new Event('resize'));
          return null;
        }
        // Acted: the answer must take the "(following)" away and give a grid
        // of this page's own shape.
        if (size.includes('(following)')) return null;
        const parts = size.split(String.fromCharCode(215));
        return JSON.stringify({cols: parseInt(parts[0], 10), rows: parseInt(parts[1], 10)});
      })()`,
    });

    const [driver, narrow] = await Promise.all([driverLost, narrowActs]);
    const took = JSON.parse(String(narrow.probe)) as { cols: number; rows: number };

    // The narrow page ended up driving a grid narrower than the one it adopted.
    expect(took.cols).toBeLessThan(100);
    // The daemon agreed: the session now runs at the narrow page's grid.
    const after = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(after.body['cols']).toBe(took.cols);
    expect(after.body['rows']).toBe(took.rows);
    // And the old driver was told, out loud, that it now follows.
    expect(String(driver.probe)).toContain('(following)');
    expect(String(driver.probe)).toContain(`${String(took.cols)}×${String(took.rows)}`);
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }, 300_000);
});
