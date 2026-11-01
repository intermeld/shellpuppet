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
  it('keeps notices off the cursor at both ends without resizing, and lets clicks through', async (context) => {
    if (browser === null) { context.skip(); return; }
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e',
        "let bottom = false; const paint = () => process.stdout.write('\\x1b[2J\\x1b[H' + (bottom ? '\\x1b[30;1HBOTTOM' : 'TOP')); paint(); setInterval(() => { bottom = !bottom; paint(); }, 1500);",
      ], shell: false, cols: 100, rows: 30, hold: true },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    try {
      const capture = await captureViewer({
        browser, viewerUrl: await freshViewerUrl(id), width: 920, height: 680,
        drive: true, timeoutMs: 90_000,
        probe: `(() => {
          const rows = [...document.querySelectorAll('#term .xterm-rows > div')];
          const notice = document.getElementById('notices');
          if (rows.length < 30 || !document.getElementById('size').textContent) return null;
          const state = (window.__cursorNotice = window.__cursorNotice || { sent: [], original: WebSocket.prototype.send });
          if (!state.installed) {
            WebSocket.prototype.send = function(data) {
              if (typeof data === 'string' && data.includes('"type":"resize"')) state.sent.push(JSON.parse(data));
              return state.original.call(this, data);
            };
            state.installed = true;
            const alert = document.getElementById('prompt-alert');
            alert.textContent = 'A long question '.repeat(400);
            alert.hidden = false;
            document.getElementById('banner').textContent = 'Connection notice';
            document.getElementById('banner').hidden = false;
          }
          const index = rows[0].textContent.includes('TOP') ? 0 :
            rows[rows.length - 1].textContent.includes('BOTTOM') ? rows.length - 1 : -1;
          if (index !== 0 && index !== rows.length - 1) return null;
          const box = notice.getBoundingClientRect();
          const row = rows[index].getBoundingClientRect();
          const screen = document.querySelector('#term .xterm-screen').getBoundingClientRect();
          const sample = {
            index, overlap: box.top < row.bottom && box.bottom > row.top,
            height: box.height, screenHeight: screen.height,
            hit: document.elementFromPoint(box.left + 20, box.top + 20)?.closest('#notices') !== null,
          };
          // The terminal paints rows and moves the notice on separate browser
          // turns. Observe each end only once the notice has followed the
          // cursor; a persistent overlap still times out the probe.
          if (!sample.overlap) {
            if (index === 0) state.top = sample;
            else state.bottom = sample;
          }
          if (!state.top || !state.bottom) return null;
          return JSON.stringify({ top: state.top, bottom: state.bottom, sent: state.sent });
        })()`,
      });
      const result = JSON.parse(String(capture.probe)) as {
        top: { overlap: boolean; height: number; screenHeight: number; hit: boolean };
        bottom: { overlap: boolean; height: number; screenHeight: number; hit: boolean };
        sent: unknown[];
      };
      expect(result.top.overlap).toBe(false);
      expect(result.bottom.overlap).toBe(false);
      expect(result.top.height).toBeLessThanOrEqual(result.top.screenHeight / 3 + 1);
      expect(result.bottom.height).toBeLessThanOrEqual(result.bottom.screenHeight / 3 + 1);
      expect(result.top.hit).toBe(false);
      expect(result.bottom.hit).toBe(false);
      expect(result.sent).toEqual([]);
    } finally {
      await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
    }
  }, 180_000);

  it('showing and hiding notices does not propose a new grid', async (context) => {
    if (browser === null) { context.skip(); return; }
    const id = await paintedSession(false);
    const capture = await captureViewer({
      browser,
      viewerUrl: await freshViewerUrl(id),
      width: 920,
      height: 680,
      drive: true,
      timeoutMs: 90_000,
      probe: `(() => {
        if (!document.querySelector('.xterm-screen') || !document.getElementById('size').textContent) return null;
        const watch = (window.__noticeWatch = window.__noticeWatch || { phase: 0, at: Date.now(), sent: [], original: WebSocket.prototype.send });
        if (watch.phase === 0) {
          WebSocket.prototype.send = function(data) {
            if (typeof data === 'string' && data.includes('"type":"resize"')) watch.sent.push(JSON.parse(data));
            return watch.original.call(this, data);
          };
          watch.before = document.getElementById('wrap').clientHeight;
          watch.phase = 1; watch.at = Date.now();
          return null;
        }
        if (Date.now() - watch.at < 300) return null;
        const banner = document.getElementById('banner');
        const alert = document.getElementById('prompt-alert');
        if (watch.phase === 1) {
          banner.textContent = 'Connection notice'; banner.hidden = false;
          alert.textContent = 'Waiting for you: answer the question'; alert.hidden = false;
          window.dispatchEvent(new Event('resize'));
          watch.shown = document.getElementById('wrap').clientHeight;
          watch.phase = 2; watch.at = Date.now(); return null;
        }
        if (watch.phase === 2) {
          banner.hidden = true; alert.hidden = true;
          window.dispatchEvent(new Event('resize'));
          watch.hidden = document.getElementById('wrap').clientHeight;
          watch.phase = 3; watch.at = Date.now(); return null;
        }
        return JSON.stringify({ before: watch.before, shown: watch.shown, hidden: watch.hidden, sent: watch.sent });
      })()`,
    });
    const result = JSON.parse(String(capture.probe)) as { before: number; shown: number; hidden: number; sent: unknown[] };
    expect(result.shown).toBe(result.before);
    expect(result.hidden).toBe(result.before);
    expect(result.sent).toEqual([]);
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }, 180_000);

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
