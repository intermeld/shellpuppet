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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, startTestDaemon } from './helpers.js';
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
  it('fills a rounded canvas at small text sizes with one native resize', async (context) => {
    if (browser === null) { context.skip(); return; }
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
        shell: false, openViewer: false, cols: 96, rows: 24 },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const id = String(started.body['id']);
    const manager = (td.daemon as unknown as {
      manager: { get: (id: string) => import('../../src/core/session.js').Session };
    }).manager;
    const session = manager.get(id);
    const pty = (session as unknown as { pty: { resize: (cols: number, rows: number) => void } }).pty;
    const resize = vi.spyOn(session, 'resize');
    const nativeResize = vi.spyOn(pty, 'resize');
    try {
      await captureViewer({ browser, viewerUrl: await freshViewerUrl(id), width: 558, height: 931,
        drive: true, probeOnly: true, timeoutMs: 60_000,
        beforeNavigateScript: `(() => {
          window.__paneErrors = [];
          window.addEventListener('error', event => __paneErrors.push(event.message));
          let implementation;
          Object.defineProperty(window, 'ShellPuppetPane', {
            get: () => implementation,
            set: value => { implementation = { ...value, create(config) {
              const client = value.create(config);
              client.getTerminal().options.fontFamily = 'monospace';
              window.__pane = client;
              return client;
            } }; }
          });
          window.__resizes = [];
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function(data) {
            try { const frame = JSON.parse(data); if (frame.type === 'resize') __resizes.push(frame); }
            catch { /* Terminal input is not a control frame. */ }
            return send.call(this, data);
          };
          window.__pause = () => new Promise(resolve => setTimeout(resolve, 1600));
        })()`,
        probe: 'window.__pane?.getGrid().cols > 0',
        timeoutProbe: 'JSON.stringify({ errors: window.__paneErrors, grid: window.__pane?.getGrid(), body: document.body?.innerText.slice(0, 400) })',
        interact: async ({ evaluate, send }) => {
          await evaluate('(async () => { __pane.setFontOverride(7); await __pause(); })()');
          // At a 3.8486328125 px monospace cell these are exactly 558 and 634.
          // Other installed monospace fonts exercise the same 137 -> 157 grid.
          const widths = await evaluate(`(() => {
            const term = __pane.getTerminal(), cell = term._core._renderService.dimensions.device.cell.width / devicePixelRatio;
            const style = getComputedStyle(term.element), container = getComputedStyle(document.getElementById('term'));
            const inset = innerWidth - parseInt(container.width) + parseInt(style.paddingLeft) + parseInt(style.paddingRight) + 14;
            return [Math.ceil(137 * cell) + inset, Math.round(157 * cell) + inset];
          })()`) as number[];
          await send('Emulation.setDeviceMetricsOverride', {
            width: widths[0], height: 931, deviceScaleFactor: 1, mobile: false,
          });
          await evaluate('__pause()');
          const before = await evaluate('__pane.getGrid()') as { cols: number; rows: number };
          expect(before.cols).toBe(137);
          resize.mockClear(); nativeResize.mockClear();
          await evaluate('__resizes.length = 0');
          await send('Emulation.setDeviceMetricsOverride', {
            width: widths[1], height: 931, deviceScaleFactor: 1, mobile: false,
          });
          await evaluate('__pause()');
          const after = await evaluate(`(() => {
            const term = __pane.getTerminal(), style = getComputedStyle(term.element);
            const available = parseInt(getComputedStyle(document.getElementById('term')).width) -
              parseInt(style.paddingLeft) - parseInt(style.paddingRight) - 14;
            return { grid: __pane.getGrid(), font: term.options.fontSize, available,
              width: term.element.querySelector('.xterm-screen').offsetWidth, frames: __resizes };
          })()`) as { grid: { cols: number; rows: number }; font: number; available: number; width: number; frames: unknown[] };
          const details = JSON.stringify({ platform: process.platform, widths, before, after, nativeCalls: nativeResize.mock.calls });
          expect.soft(after.grid, details).toEqual({ cols: 157, rows: before.rows });
          expect.soft(after.font, details).toBe(7);
          expect.soft(after.available - after.width, details).toBe(0);
          expect.soft(resize, details).toHaveBeenCalledTimes(1);
          expect.soft(nativeResize, details).toHaveBeenCalledTimes(1);
          expect.soft(nativeResize.mock.calls[0], details).toEqual([157, before.rows]);
          expect.soft(after.frames, details).toHaveLength(1);
          await evaluate('__pause()');
          expect.soft(await evaluate('__pane.getGrid()'), details).toEqual({ cols: 157, rows: before.rows });
          expect.soft(nativeResize, details).toHaveBeenCalledTimes(1);
          expect.soft(await evaluate('__resizes.length'), details).toBe(1);
        },
      });
    } finally {
      resize.mockRestore(); nativeResize.mockRestore();
      await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
    }
  }, 120_000);

  it('keeps notices off the cursor at both ends without resizing, and lets clicks through', async (context) => {
    if (browser === null) { context.skip(); return; }
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e',
        "process.stdin.setRawMode(true); process.stdin.on('data', () => process.stdout.write('\\x1b[2J\\x1b[30;1HBOTTOM')); process.stdout.write('\\x1b[2J\\x1b[HTOP')",
      ], shell: false, cols: 100, rows: 30, hold: true },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    try {
      const capture = await captureViewer({
        browser, viewerUrl: await freshViewerUrl(id), width: 920, height: 680,
        drive: true, probeOnly: true, timeoutMs: 90_000,
        probe: "document.querySelector('#term .xterm-rows > div')?.textContent.includes('TOP')",
        interact: async ({ evaluate }) => {
          await evaluate(`(() => {
            window.__noticeResizes = [];
            const send = WebSocket.prototype.send;
            WebSocket.prototype.send = function(data) {
              if (typeof data === 'string' && data.includes('"type":"resize"')) __noticeResizes.push(data);
              return send.call(this, data);
            };
            const alert = document.getElementById('prompt-alert');
            alert.textContent = 'A long question '.repeat(400);
            alert.hidden = false;
            const banner = document.getElementById('banner');
            banner.textContent = 'Connection notice';
            banner.hidden = false;
          })()`);
          for (const edge of ['TOP', 'BOTTOM']) {
            if (edge === 'BOTTOM') {
              expect((await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'b' } })).status).toBe(200);
            }
            await eventually(async () => {
              const sample = await evaluate(`(() => {
                const rows = document.querySelectorAll('#term .xterm-rows > div');
                const row = rows[${edge === 'TOP' ? 0 : 29}];
                if (!row?.textContent.includes('${edge}')) return null;
                const cursor = row.getBoundingClientRect();
                const box = document.getElementById('notices').getBoundingClientRect();
                const screen = document.querySelector('#term .xterm-screen').getBoundingClientRect();
                if (!box.height || box.top < cursor.bottom && box.bottom > cursor.top) return null;
                const left = Math.max(box.left, screen.left, 0), right = Math.min(box.right, screen.right, innerWidth);
                const top = Math.max(box.top, screen.top, 0), bottom = Math.min(box.bottom, screen.bottom, innerHeight);
                if (right <= left || bottom <= top) return null;
                const target = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
                return { through: !!target?.closest('#term'), height: box.height, screenHeight: screen.height };
              })()`) as { through: boolean; height: number; screenHeight: number } | null;
              if (!sample) return false;
              expect(sample.through).toBe(true);
              expect(sample.height).toBeLessThanOrEqual(sample.screenHeight / 3 + 1);
              return true;
            }, 10_000, 50, `visible notice clear of ${edge}`);
          }
          return evaluate('window.__noticeResizes');
        },
      });
      expect(capture.probe).toEqual([]);
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
