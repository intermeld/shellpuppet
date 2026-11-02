import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let daemon: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await daemon?.stop(); daemon = null; }, 120_000);

async function exercise(count: number, interact: Parameters<typeof captureDashboard>[0]['interact']) {
  const urls: string[] = [];
  daemon = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  for (let index = 0; index < count; index++) {
    expect((await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
      openViewer: false, cols: 100, rows: 30,
    } })).status).toBe(200);
  }
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  return captureDashboard({ browser: browser!, viewerUrl: urls.at(-1)!, width: 2200, height: 1300,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `(() => {
      window.__resizes = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"'))
          window.__resizes.push({ url: this.url, frame: JSON.parse(data) });
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelectorAll('.pane-size').length === ${count} &&
      [...document.querySelectorAll('.pane-size')].every(x => x.textContent.includes('×')) ? true : null)()`,
    interact,
  });
}

it('drags the Focus boundary, fits the grown pane on release, and retains its width until Auto', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(2, async ({ evaluate, send }) => {
    await evaluate(`document.getElementById('focus').click()`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const before = await evaluate(`(() => {
      const divider = document.querySelector('.pane-divider[data-axis="focus"]');
      const main = document.getElementById('main-pane').getBoundingClientRect();
      const strip = document.getElementById('strip').getBoundingClientRect();
      window.__resizes.length = 0;
      return { divider: divider?.getBoundingClientRect().toJSON(), main: main.toJSON(), strip: strip.toJSON(),
        mainSize: document.querySelector('#main-pane .pane-size')?.textContent,
        stripId: document.querySelector('#strip .pane')?.dataset.session };
    })()`) as { divider?: { x: number; y: number; width: number; height: number }; main: { width: number }; strip: { width: number } };
    expect(before.divider).toBeTruthy();
    const x = before.divider!.x + before.divider!.width / 2;
    const y = before.divider!.y + before.divider!.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 500, y, button: 'left', buttons: 1 });
    const during = await evaluate(`({ width: document.getElementById('strip').getBoundingClientRect().width, frames: window.__resizes.length, sizes: [...document.querySelectorAll('.pane-size')].map(x => x.textContent) })`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 500, y, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = await evaluate(`(() => ({ width: document.getElementById('strip').getBoundingClientRect().width,
      frames: window.__resizes.slice(), stored: sessionStorage.getItem('shellpuppet.dashboard.tracks'),
      mainSize: document.querySelector('#main-pane .pane-size')?.textContent,
      sizes: [...document.querySelectorAll('.pane-size')].map(x => x.textContent) }))()`);
    await evaluate(`location.reload()`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const reloaded = await evaluate(`(() => ({ width: document.getElementById('strip').getBoundingClientRect().width,
      divider: !!document.querySelector('.pane-divider[data-axis="focus"]') }))()`);
    const narrowed = await evaluate(`(() => { const root = document.getElementById('panes');
      root.style.width = '1300px'; window.dispatchEvent(new Event('resize'));
      return { main: document.getElementById('main-pane').getBoundingClientRect().width,
        strip: document.getElementById('strip').getBoundingClientRect().width }; })()`);
    await evaluate(`document.getElementById('auto').click()`);
    const reset = await evaluate(`sessionStorage.getItem('shellpuppet.dashboard.tracks')`);
    return { before, during, after, reloaded, narrowed, reset };
  });
  const result = shot.probe as { before: { strip: { width: number }; mainSize: string; stripId: string }; during: { width: number; frames: number };
    after: { width: number; mainSize: string; frames: { url: string; frame: { take: boolean } }[] };
    reloaded: { width: number; divider: boolean }; narrowed: { main: number; strip: number }; reset: string | null };
  expect(result.during.width).toBeGreaterThan(result.before.strip.width + 100);
  expect(result.during.frames).toBe(0);
  expect(result.after.frames, JSON.stringify(result)).toHaveLength(1);
  expect(result.after.frames[0]!.frame.take).toBe(true);
  expect(result.after.frames[0]!.url).toContain(result.before.stripId);
  expect(result.after.mainSize).toBe(result.before.mainSize);
  expect(result.reloaded.width).toBeCloseTo(result.after.width, 0);
  expect(result.reloaded.divider).toBe(true);
  expect(result.narrowed.main).toBeGreaterThanOrEqual(652);
  expect(result.narrowed.strip).toBeGreaterThanOrEqual(300);
  expect(result.reset).toBeNull();
}, 150_000);

it('drags Grid columns and rows with minimums and keyboard steps, then resets on Grid', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(4, async ({ evaluate, send }) => {
    await evaluate(`document.getElementById('grid').click()`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const first = await evaluate(`(() => {
      const d = document.querySelector('.pane-divider[data-axis="column"]');
      window.__resizes.length = 0;
      return { box: d?.getBoundingClientRect().toJSON(), width: document.querySelector('.pane').getBoundingClientRect().width };
    })()`) as { box?: { x: number; y: number; width: number; height: number }; width: number };
    expect(first.box).toBeTruthy();
    const x = first.box!.x + first.box!.width / 2;
    const y = first.box!.y + first.box!.height / 4;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 300, y, button: 'left', buttons: 1 });
    const during = await evaluate(`({ frames: window.__resizes.length, widths: [...document.querySelectorAll('.pane')].map(x => x.getBoundingClientRect().width), style: document.getElementById('panes').style.getPropertyValue('--grid-columns') })`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 300, y, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const moved = await evaluate(`(() => ({ widths: [...document.querySelectorAll('.pane')].map(x => x.getBoundingClientRect().width),
      frames: window.__resizes.slice(), style: document.getElementById('panes').style.getPropertyValue('--grid-columns') }))()`);
    const second = await evaluate(`document.querySelector('.pane-divider[data-axis="column"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    const nextX = second.x + second.width / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nextX, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nextX + 1000, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nextX + 1000, y, button: 'left', clickCount: 1 });
    const minimum = await evaluate(`Math.min(...[...document.querySelectorAll('.pane')].map(x => x.getBoundingClientRect().width))`);
    const rowBox = await evaluate(`document.querySelector('.pane-divider[data-axis="row"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    const rowX = rowBox.x + rowBox.width / 4;
    const rowY = rowBox.y + rowBox.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowX, y: rowY, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowX, y: rowY + 300, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowX, y: rowY + 300, button: 'left', clickCount: 1 });
    const row = await evaluate(`(() => ({ heights: [...document.querySelectorAll('.pane')].map(x => x.getBoundingClientRect().height),
      template: getComputedStyle(document.getElementById('panes')).gridTemplateRows }))()`);
    await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="row"]'); d.focus();
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); })()`);
    const key = await evaluate(`getComputedStyle(document.getElementById('panes')).gridTemplateRows`);
    await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="row"]');
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); })()`);
    const home = await evaluate(`getComputedStyle(document.getElementById('panes')).gridTemplateRows`);
    await evaluate(`document.getElementById('grid').click()`);
    const reset = await evaluate(`getComputedStyle(document.getElementById('panes')).gridTemplateColumns`);
    return { first, during, moved, minimum, row, key, home, reset };
  });
  const result = shot.probe as { first: { width: number }; during: { frames: number; widths: number[]; style: string };
    moved: { widths: number[]; frames: unknown[] }; minimum: number;
    row: { heights: number[]; template: string }; key: string; home: string; reset: string };
  expect(result.during.frames).toBe(0);
  expect(result.moved.widths[0], JSON.stringify(result)).toBeGreaterThan(result.first.width + 100);
  expect(result.moved.widths[1]).toBeGreaterThanOrEqual(652);
  expect(result.moved.frames).toHaveLength(2);
  expect(result.minimum).toBeGreaterThanOrEqual(652);
  expect(result.minimum).toBeLessThan(654);
  expect(result.row.heights[0]!).toBeGreaterThan(result.row.heights[2]!);
  expect(result.row.heights[2]!).toBeGreaterThanOrEqual(446);
  expect(result.key).not.toBe(result.home);
  expect(result.reset.split(' ')[0]).toBe(result.reset.split(' ')[1]);
}, 150_000);
