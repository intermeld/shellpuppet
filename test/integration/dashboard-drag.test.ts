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
    await evaluate(`window.__focusBeforeReload = true; location.reload()`);
    let reloaded: unknown;
    const reloadDeadline = Date.now() + 20_000;
    while (!reloaded && Date.now() < reloadDeadline) {
      try {
        reloaded = await evaluate(`(() => {
          const strip = document.getElementById('strip');
          const divider = document.querySelector('.pane-divider[data-axis="focus"]');
          if (window.__focusBeforeReload || document.readyState !== 'complete' ||
              document.getElementById('connection')?.textContent !== 'Connected' ||
              document.querySelectorAll('.pane-size').length !== 2 || !strip || !divider) return null;
          const width = strip.getBoundingClientRect().width;
          return width > 0 ? { width, divider: true } : null;
        })()`);
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context|Inspected target navigated or closed/i.test(String(error))) throw error;
      }
      if (!reloaded) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(reloaded, 'the reloaded Focus dashboard did not become ready').toBeTruthy();
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

it('drags uneven Grid columns and rows with minimums and keyboard steps, then resets on Grid', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(5, async ({ evaluate, send }) => {
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
      columns: document.querySelectorAll('.pane-divider[data-axis="column"]').length,
      rows: document.querySelectorAll('.pane-divider[data-axis="row"]').length,
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
    row: { heights: number[]; columns: number; rows: number; template: string }; key: string; home: string; reset: string };
  expect(result.during.frames).toBe(0);
  expect(result.moved.widths[0], JSON.stringify(result)).toBeGreaterThan(result.first.width + 50);
  expect(result.moved.widths[1]).toBeGreaterThanOrEqual(652);
  expect(result.moved.frames).toHaveLength(2);
  expect(result.minimum).toBeGreaterThanOrEqual(652);
  expect(result.minimum).toBeLessThan(654);
  expect(result.row.columns).toBe(2);
  expect(result.row.rows).toBe(1);
  expect(result.row.heights).toHaveLength(5);
  expect(result.row.heights[0]!).toBeGreaterThan(result.row.heights[3]!);
  expect(result.row.heights[3]!).toBeGreaterThanOrEqual(446);
  expect(result.row.heights[4]!).toBeCloseTo(result.row.heights[3]!, 0);
  expect(result.key).not.toBe(result.home);
  expect(result.reset.split(' ')[0]).toBe(result.reset.split(' ')[1]);
}, 150_000);

it('keeps a Focus drag alive through relayout and announces its pixel value', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(2, async ({ evaluate, send }) => {
    await evaluate(`document.getElementById('focus').click()`);
    const first = await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      const b = d.getBoundingClientRect(); window.__dragDivider = d; window.__resizes.length = 0;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, value: d.getAttribute('aria-valuenow') }; })()`) as { x: number; y: number; value: string | null };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x - 220, y: first.y, button: 'left', buttons: 1 });
    const moved = await evaluate(`(() => { const root = document.getElementById('panes');
      const d = document.querySelector('.pane-divider[data-axis="focus"]');
      let listenerAdds = 0;
      const add = d.addEventListener;
      d.addEventListener = function(...args) { listenerAdds++; return add.apply(this, args); };
      d.focus();
      for (const width of [2050, 2040, 2030, 2020, 2010]) {
        root.style.width = width + 'px'; window.dispatchEvent(new Event('resize'));
      }
      return { same: d === window.__dragDivider, dragging: d.classList.contains('dragging'),
        focused: document.activeElement === d, listenerAdds,
        value: d.getAttribute('aria-valuenow'), min: d.getAttribute('aria-valuemin'),
        max: d.getAttribute('aria-valuemax'), text: d.getAttribute('aria-valuetext') }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: first.x - 220, y: first.y, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 350));
    const released = await evaluate(`(() => ({ stored: sessionStorage.getItem('shellpuppet.dashboard.tracks'),
      dragging: document.querySelector('.pane-divider[data-axis="focus"]').classList.contains('dragging'),
      frames: window.__resizes.length }))()`);
    await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]'); d.focus();
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); })()`);
    const key = await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      return { value: d.getAttribute('aria-valuenow'), text: d.getAttribute('aria-valuetext') }; })()`);
    return { first, moved, released, key };
  });
  const result = shot.probe as { first: { value: string | null }; moved: { same: boolean; dragging: boolean;
    focused: boolean; listenerAdds: number;
    value: string | null; min: string | null; max: string | null; text: string | null };
    released: { stored: string | null; dragging: boolean; frames: number }; key: { value: string | null; text: string | null } };
  expect(result.moved.same).toBe(true);
  expect(result.moved.dragging).toBe(true);
  expect(result.moved.focused).toBe(true);
  expect(result.moved.listenerAdds).toBe(0);
  expect(Number(result.moved.value)).toBeGreaterThan(Number(result.moved.min));
  expect(Number(result.moved.value)).toBeLessThan(Number(result.moved.max));
  expect(result.moved.text).toMatch(/Focus pane \d+ pixels wide/);
  expect(result.released.stored).toContain('focusStrip');
  expect(result.released.dragging).toBe(false);
  expect(result.released.frames).toBeGreaterThan(0);
  expect(result.key.value).not.toBe(result.moved.value);
  expect(result.key.text).toMatch(/Focus pane \d+ pixels wide/);
}, 150_000);

it('ends a held Focus drag before Home resets its width', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(2, async ({ evaluate, send }) => {
    const first = await evaluate(`(() => {
      document.getElementById('focus').click();
      const d = document.querySelector('.pane-divider[data-axis="focus"]');
      const box = d.getBoundingClientRect();
      const listeners = new Map();
      const add = document.addEventListener;
      const remove = document.removeEventListener;
      document.addEventListener = function(type, listener, options) {
        if (['pointermove', 'pointerup', 'pointercancel'].includes(type))
          listeners.set(listener, type);
        return add.call(this, type, listener, options);
      };
      document.removeEventListener = function(type, listener, options) {
        if (listeners.get(listener) === type) listeners.delete(listener);
        return remove.call(this, type, listener, options);
      };
      window.__dragListeners = listeners;
      window.__trackSaves = 0;
      const save = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'shellpuppet.dashboard.tracks') window.__trackSaves++;
        return save.call(this, key, value);
      };
      document.addEventListener('pointerdown', e => window.__dragPointer = e.pointerId, true);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`) as { x: number; y: number };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x - 180, y: first.y, button: 'left', buttons: 1 });
    const during = await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      return { width: document.getElementById('strip').getBoundingClientRect().width,
        dragging: d.classList.contains('dragging'), listeners: window.__dragListeners.size,
        captured: d.hasPointerCapture(window.__dragPointer) }; })()`);
    const home = await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
      return { width: document.getElementById('strip').getBoundingClientRect().width,
        dragging: d.classList.contains('dragging'), listeners: window.__dragListeners.size,
        captured: d.hasPointerCapture(window.__dragPointer), saves: window.__trackSaves }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x - 250, y: first.y, button: 'left', buttons: 1 });
    const afterMove = await evaluate(`(() => ({ width: document.getElementById('strip').getBoundingClientRect().width,
      listeners: window.__dragListeners.size, saves: window.__trackSaves }))()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: first.x - 250, y: first.y, button: 'left', clickCount: 1 });
    const next = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: next.x + next.width / 2, y: first.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: next.x + next.width / 2 - 120, y: first.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: next.x + next.width / 2 - 120, y: first.y, button: 'left', clickCount: 1 });
    const second = await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      return { width: document.getElementById('strip').getBoundingClientRect().width,
        dragging: d.classList.contains('dragging'), listeners: window.__dragListeners.size,
        captured: d.hasPointerCapture(window.__dragPointer), saves: window.__trackSaves }; })()`);
    return { during, home, afterMove, second };
  });
  const result = shot.probe as { during: { width: number; dragging: boolean; listeners: number; captured: boolean };
    home: { width: number; dragging: boolean; listeners: number; captured: boolean; saves: number };
    afterMove: { width: number; listeners: number; saves: number };
    second: { width: number; dragging: boolean; listeners: number; captured: boolean; saves: number } };
  expect(result.during.width).toBeGreaterThan(300);
  expect(result.during.dragging).toBe(true);
  expect(result.during.listeners).toBe(3);
  expect(result.during.captured).toBe(true);
  expect(result.home.width).toBeCloseTo(300, 0);
  expect(result.home.dragging).toBe(false);
  expect(result.home.listeners).toBe(0);
  expect(result.home.captured).toBe(false);
  expect(result.afterMove.width).toBeCloseTo(result.home.width, 0);
  expect(result.afterMove.listeners).toBe(0);
  expect(result.afterMove.saves).toBe(result.home.saves);
  expect(result.second.width).toBeGreaterThan(result.home.width + 50);
  expect(result.second.dragging).toBe(false);
  expect(result.second.listeners).toBe(0);
  expect(result.second.captured).toBe(false);
  expect(result.second.saves).toBe(result.home.saves + 1);
}, 150_000);

for (const eventType of ['pagehide', 'beforeunload'] as const) {
  it(`commits a held Focus drag on ${eventType} exactly once`, async (context) => {
    if (!browser) { context.skip(); return; }
    const shot = await exercise(2, async ({ evaluate, send }) => {
      const start = await evaluate(`(() => {
        document.getElementById('focus').click();
        const divider = document.querySelector('.pane-divider[data-axis="focus"]');
        const box = divider.getBoundingClientRect();
        const listeners = new Map();
        const add = document.addEventListener;
        const remove = document.removeEventListener;
        document.addEventListener = function(type, listener, options) {
          if (['pointermove', 'pointerup', 'pointercancel'].includes(type)) listeners.set(listener, type);
          return add.call(this, type, listener, options);
        };
        document.removeEventListener = function(type, listener, options) {
          if (listeners.get(listener) === type) listeners.delete(listener);
          return remove.call(this, type, listener, options);
        };
        window.__dragListeners = listeners;
        window.__trackSaves = 0;
        const save = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'shellpuppet.dashboard.tracks') window.__trackSaves++;
          return save.call(this, key, value);
        };
        document.addEventListener('pointerdown', event => window.__dragPointer = event.pointerId, true);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`) as { x: number; y: number };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x - 180, y: start.y, button: 'left', buttons: 1 });
      const during = await evaluate(`(() => ({ width: document.getElementById('strip').getBoundingClientRect().width,
        listeners: window.__dragListeners.size, saves: window.__trackSaves }))()`);
      const ended = await evaluate(`(() => {
        window.dispatchEvent(new Event('${eventType}'));
        const divider = document.querySelector('.pane-divider[data-axis="focus"]');
        return { width: document.getElementById('strip').getBoundingClientRect().width,
          stored: JSON.parse(sessionStorage.getItem('shellpuppet.dashboard.tracks') || 'null')?.focusStrip,
          dragging: divider.classList.contains('dragging'), listeners: window.__dragListeners.size,
          captured: divider.hasPointerCapture(window.__dragPointer), saves: window.__trackSaves };
      })()`);
      const repeated = await evaluate(`(() => {
        window.dispatchEvent(new Event('${eventType === 'pagehide' ? 'beforeunload' : 'pagehide'}'));
        return { saves: window.__trackSaves, listeners: window.__dragListeners.size };
      })()`);
      return { during, ended, repeated };
    });
    const result = shot.probe as { during: { width: number; listeners: number; saves: number };
      ended: { width: number; stored: number | null; dragging: boolean; listeners: number; captured: boolean; saves: number };
      repeated: { saves: number; listeners: number } };
    expect(result.during.width).toBeGreaterThan(300);
    expect(result.during.listeners).toBe(3);
    expect(result.during.saves).toBe(0);
    expect(result.ended.width).toBeCloseTo(result.during.width, 0);
    expect(result.ended.stored).toBeCloseTo(result.during.width, 0);
    expect(result.ended.dragging).toBe(false);
    expect(result.ended.listeners).toBe(0);
    expect(result.ended.captured).toBe(false);
    expect(result.ended.saves).toBe(1);
    expect(result.repeated.saves).toBe(1);
    expect(result.repeated.listeners).toBe(0);
  }, 150_000);
}

it('commits a cancelled drag and a release outside the window', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(2, async ({ evaluate, send }) => {
    await evaluate(`(() => { document.getElementById('focus').click(); window.__resizes.length = 0;
      const listeners = new Map();
      const add = document.addEventListener;
      const remove = document.removeEventListener;
      document.addEventListener = function(type, listener, options) {
        if (['pointermove', 'pointerup', 'pointercancel'].includes(type)) listeners.set(listener, type);
        return add.call(this, type, listener, options);
      };
      document.removeEventListener = function(type, listener, options) {
        if (listeners.get(listener) === type) listeners.delete(listener);
        return remove.call(this, type, listener, options);
      };
      window.__dragListeners = listeners;
      document.addEventListener('pointerdown', e => window.__dragPointer = e.pointerId, true); })()`);
    const box = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 180, y, button: 'left', buttons: 1 });
    const during = await evaluate(`document.getElementById('strip').getBoundingClientRect().width`);
    await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      d.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__dragPointer, bubbles: true })); })()`);
    const cancelled = await evaluate(`(() => ({ stored: sessionStorage.getItem('shellpuppet.dashboard.tracks'),
      dragging: document.querySelector('.pane-divider[data-axis="focus"]').classList.contains('dragging'),
      width: document.getElementById('strip').getBoundingClientRect().width, frames: window.__resizes.length }))()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 180, y, button: 'left', clickCount: 1 });
    const next = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: next.x + next.width / 2, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: next.x + next.width / 2 - 120, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -30, y: -30, button: 'left', clickCount: 1 });
    const outside = await evaluate(`(() => ({ stored: sessionStorage.getItem('shellpuppet.dashboard.tracks'),
      dragging: document.querySelector('.pane-divider[data-axis="focus"]').classList.contains('dragging') }))()`);
    const final = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: final.x + final.width / 2, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: final.x + final.width / 2 - 80, y, button: 'left', buttons: 1 });
    await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      const width = document.getElementById('strip').getBoundingClientRect().width;
      const events = [];
      const observe = target => event => events.push({ type: event.type, at: performance.now(), target,
        actualTarget: event.target === d ? 'divider' : 'other', captured: d.hasPointerCapture(window.__dragPointer) });
      for (const type of ['lostpointercapture', 'pointermove', 'pointerup']) {
        d.addEventListener(type, observe('divider'), true);
        window.addEventListener(type, observe('window'), true);
      }
      const capturedBefore = d.hasPointerCapture(window.__dragPointer);
      const releasedAt = performance.now();
      window.__lostSaves = 0;
      const save = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'shellpuppet.dashboard.tracks') window.__lostSaves++;
        return save.call(this, key, value);
      };
      d.releasePointerCapture(window.__dragPointer);
      const immediately = d.classList.contains('dragging');
      window.__lostCapture = { width, events, capturedBefore, releasedAt, immediately };
      return { capturedBefore, immediately }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 30, button: 'left', buttons: 1 });
    const lost = await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      const { width, events, capturedBefore, releasedAt, immediately } = window.__lostCapture;
      const afterMove = d.classList.contains('dragging');
      return { width, after: document.getElementById('strip').getBoundingClientRect().width,
        dragging: d.classList.contains('dragging'), stored: sessionStorage.getItem('shellpuppet.dashboard.tracks'),
        capturedBefore, capturedAfter: d.hasPointerCapture(window.__dragPointer), immediately, afterMove,
        listeners: window.__dragListeners.size, saves: window.__lostSaves,
        releasedAt, events }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -30, y: -30, button: 'left', clickCount: 1 });
    const lostAfterUp = await evaluate(`window.__lostSaves`);
    const last = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    await evaluate(`(() => { window.__trackSaves = 0;
      const save = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'shellpuppet.dashboard.tracks') window.__trackSaves++;
        return save.call(this, key, value);
      }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: last.x + last.width / 2, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: last.x + last.width / 2 - 90, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x + last.width / 2 - 90, y, button: 'left', clickCount: 1 });
    const doubleEnd = await evaluate(`(() => { const d = document.querySelector('.pane-divider[data-axis="focus"]');
      const first = { saves: window.__trackSaves, frames: window.__resizes.length };
      d.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: window.__dragPointer, bubbles: true }));
      return { first, after: { saves: window.__trackSaves, frames: window.__resizes.length },
        dragging: d.classList.contains('dragging') }; })()`);
    return { during, cancelled, outside, lost, lostAfterUp, doubleEnd };
  });
  const result = shot.probe as { during: number; cancelled: { stored: string | null; dragging: boolean; width: number; frames: number };
    outside: { stored: string | null; dragging: boolean };
    lost: { width: number; after: number; dragging: boolean; stored: string | null;
      capturedBefore: boolean; capturedAfter: boolean; immediately: boolean; afterMove: boolean;
      listeners: number; saves: number;
      releasedAt: number; events: { type: string; at: number; target: string; actualTarget: string; captured: boolean }[] };
    lostAfterUp: number;
    doubleEnd: { first: { saves: number; frames: number }; after: { saves: number; frames: number }; dragging: boolean } };
  expect(result.cancelled.width).toBeCloseTo(result.during, 0);
  expect(result.cancelled.stored).toContain('focusStrip');
  expect(result.cancelled.dragging).toBe(false);
  expect(result.cancelled.frames).toBeGreaterThan(0);
  expect(result.outside.stored).toContain('focusStrip');
  expect(result.outside.dragging).toBe(false);
  expect(result.lost.after).toBeCloseTo(result.lost.width, 0);
  expect(result.lost.capturedBefore, JSON.stringify(result)).toBe(true);
  expect(result.lost.afterMove, JSON.stringify(result)).toBe(false);
  expect(result.lost.events.some(event => event.type === 'pointermove' && event.target === 'window' &&
    event.actualTarget === 'other' && !event.captured && event.at >= result.lost.releasedAt), JSON.stringify(result)).toBe(true);
  expect(result.lost.dragging, JSON.stringify(result)).toBe(false);
  expect(result.lost.stored).toContain('focusStrip');
  expect(result.lost.listeners).toBe(0);
  expect(result.lost.saves).toBe(1);
  expect(result.lostAfterUp).toBe(1);
  expect(result.doubleEnd.first.saves).toBe(1);
  expect(result.doubleEnd.after).toEqual(result.doubleEnd.first);
  expect(result.doubleEnd.dragging).toBe(false);
}, 150_000);

it('ends a drag when sessions arrive or move to another window', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(2, async ({ evaluate, send }) => {
    await evaluate(`document.getElementById('focus').click()`);
    const box = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await evaluate(`window.__arriveDivider = document.querySelector('.pane-divider[data-axis="focus"]')`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 160, y, button: 'left', buttons: 1 });
    const added = await api(daemon!.port, daemon!.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false, openViewer: false,
    } });
    expect(added.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 650));
    const arrival = await evaluate(`(() => ({ count: document.querySelectorAll('.pane').length,
      same: document.querySelector('.pane-divider[data-axis="focus"]') === window.__arriveDivider,
      dragging: document.querySelector('.pane-divider[data-axis="focus"]').classList.contains('dragging'),
      stored: sessionStorage.getItem('shellpuppet.dashboard.tracks') }))()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 160, y, button: 'left', clickCount: 1 });
    const current = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: current.x + current.width / 2, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: current.x + current.width / 2 - 110, y, button: 'left', buttons: 1 });
    const moved = await evaluate(`(async () => { const channel = new BroadcastChannel('shellpuppet.dashboard');
      const id = await new Promise(resolve => { channel.onmessage = e => {
        if (e.data?.type === 'window-roster' && e.data.window?.rank === 0) resolve(e.data.window.id);
      }; });
      channel.postMessage({ type: 'window-roster', token: 'test-other', window:
        { id: 'test-other', rank: -1, openedAt: 1, width: 1300, height: 900 } });
      await new Promise(resolve => setTimeout(resolve, 80));
      channel.postMessage({ type: 'window-assignment', token: 'test-other', owner: 'test-other',
        byWindow: { [id]: [document.querySelector('.pane').dataset.session] } });
      await new Promise(resolve => setTimeout(resolve, 150));
      window.__resizes.length = 0;
      document.getElementById('text-larger').click();
      await new Promise(resolve => setTimeout(resolve, 400));
      channel.close();
      return { count: document.querySelectorAll('.pane').length,
        oldDragging: document.querySelector('.pane-divider.dragging') !== null,
        divider: document.querySelector('.pane-divider[data-axis="focus"]') !== null,
        stored: sessionStorage.getItem('shellpuppet.dashboard.tracks'), frames: window.__resizes.length }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -30, y: -30, button: 'left', clickCount: 1 });
    return { arrival, moved };
  });
  const result = shot.probe as { arrival: { count: number; same: boolean; dragging: boolean; stored: string | null };
    moved: { count: number; oldDragging: boolean; divider: boolean; stored: string | null; frames: number } };
  expect(result.arrival.count).toBe(3);
  expect(result.arrival.same).toBe(false);
  expect(result.arrival.dragging).toBe(false);
  expect(result.arrival.stored).toBeNull();
  expect(result.moved.count).toBe(1);
  expect(result.moved.oldDragging).toBe(false);
  expect(result.moved.divider).toBe(false);
  expect(result.moved.stored).toBeNull();
  expect(result.moved.frames).toBeGreaterThan(0);
}, 150_000);

it('ends and rebuilds a Focus divider when the same-count assignment changes its panes', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(3, async ({ evaluate, send }) => {
    await evaluate(`document.getElementById('focus').click()`);
    const assigned = await evaluate(`(async () => {
      const channel = window.__swapChannel = new BroadcastChannel('shellpuppet.dashboard');
      const id = window.__localId = await new Promise(resolve => { channel.onmessage = e => {
        if (e.data?.type === 'window-roster' && e.data.window?.rank === 0) resolve(e.data.window.id);
      }; channel.postMessage({ type: 'window-roster', token: 'test-swap', window:
        { id: 'test-swap', rank: -1, openedAt: 1, width: 1300, height: 900 } }); });
      const ids = window.__allIds = [...document.querySelectorAll('.pane')].map(pane => pane.dataset.session);
      channel.postMessage({ type: 'window-assignment', token: 'test-swap', owner: 'test-swap',
        byWindow: { [id]: ids.slice(0, 2) } });
      await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('first assignment missing')), 3000);
        const check = () => { const found = [...document.querySelectorAll('.pane')].map(pane => pane.dataset.session);
          if (found.length === 2 && found.every((value, index) => value === ids[index])) {
            clearTimeout(deadline); resolve();
          } else requestAnimationFrame(check);
        }; check(); });
      return ids;
    })()`) as string[];
    const box = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await evaluate(`window.__oldDivider = document.querySelector('.pane-divider[data-axis="focus"]')`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 180, y, button: 'left', buttons: 1 });
    const reached = await evaluate(`document.getElementById('strip').getBoundingClientRect().width`);
    const swapped = await evaluate(`(async () => {
      const ids = window.__allIds;
      window.__resizes.length = 0;
      window.__swapChannel.postMessage({ type: 'window-assignment', token: 'test-swap', owner: 'test-swap',
        byWindow: { [window.__localId]: ids.slice(1) } });
      await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('second assignment missing')), 3000);
        const check = () => { const found = [...document.querySelectorAll('.pane')].map(pane => pane.dataset.session);
          if (found.length === 2 && found[0] === ids[1] && found[1] === ids[2]) {
            clearTimeout(deadline); resolve();
          } else requestAnimationFrame(check);
        }; check(); });
      const divider = document.querySelector('.pane-divider[data-axis="focus"]');
      const result = { same: divider === window.__oldDivider, oldDragging: window.__oldDivider.classList.contains('dragging'),
        dragging: divider.classList.contains('dragging'), width: document.getElementById('strip').getBoundingClientRect().width,
        stored: sessionStorage.getItem('shellpuppet.dashboard.tracks'), frames: window.__resizes.slice() };
      window.__swapChannel.close();
      return result;
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 180, y, button: 'left', clickCount: 1 });
    return { assigned, reached, swapped };
  });
  const result = shot.probe as { assigned: string[]; reached: number; swapped: { same: boolean; oldDragging: boolean;
    dragging: boolean; width: number; stored: string | null; frames: { url: string }[] } };
  expect(result.swapped.same, JSON.stringify(result)).toBe(false);
  expect(result.swapped.oldDragging).toBe(false);
  expect(result.swapped.dragging).toBe(false);
  expect(result.swapped.width).toBeCloseTo(result.reached, 0);
  expect(result.swapped.stored).toContain('focusStrip');
  expect(result.swapped.frames.some(frame => frame.url.includes(result.assigned[1]!))).toBe(true);
  expect(result.swapped.frames.some(frame => frame.url.includes(result.assigned[0]!))).toBe(false);
}, 150_000);

it('does not fit with Auto fit off after a pen drag, but Fit still takes the grid', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(2, async ({ evaluate, send }) => {
    await evaluate(`(() => { document.getElementById('focus').click(); document.getElementById('auto-fit').click();
      window.__pointerTypes = []; document.addEventListener('pointerdown', e => window.__pointerTypes.push(e.pointerType), true);
      window.__resizes.length = 0; })()`);
    await new Promise(resolve => setTimeout(resolve, 350));
    await evaluate(`window.__resizes.length = 0`);
    const box = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'pen' });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 240, y, button: 'left', buttons: 1, pointerType: 'pen' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 240, y, button: 'left', clickCount: 1, pointerType: 'pen' });
    const dragged = await evaluate(`({ width: document.getElementById('strip').getBoundingClientRect().width,
      pointerTypes: window.__pointerTypes, frames: window.__resizes.length })`);
    await evaluate(`document.querySelector('#strip .pane button[aria-label="Fit"]').click()`);
    const fitted = await evaluate(`window.__resizes.length`);
    return { dragged, fitted };
  });
  const result = shot.probe as { dragged: { width: number; pointerTypes: string[]; frames: number }; fitted: number };
  expect(result.dragged.pointerTypes).toContain('pen');
  expect(result.dragged.width).toBeGreaterThan(450);
  expect(result.dragged.frames).toBe(0);
  expect(result.fitted).toBeGreaterThan(0);
}, 150_000);

it('forgets saved tracks when the pane count passes through zero', async (context) => {
  if (!browser) { context.skip(); return; }
  const shot = await exercise(2, async ({ evaluate, send }) => {
    await evaluate(`document.getElementById('focus').click()`);
    const box = await evaluate(`document.querySelector('.pane-divider[data-axis="focus"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 180, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 180, y, button: 'left', clickCount: 1 });
    const saved = await evaluate(`sessionStorage.getItem('shellpuppet.dashboard.tracks')`);
    const interval = await evaluate(`(async () => { const channel = new BroadcastChannel('shellpuppet.dashboard');
      const id = await new Promise(resolve => { channel.onmessage = e => {
        if (e.data?.type === 'window-roster' && e.data.window?.rank === 0) resolve(e.data.window.id);
      }; });
      const ids = [...document.querySelectorAll('.pane')].map(x => x.dataset.session);
      channel.postMessage({ type: 'window-roster', token: 'test-zero', window:
        { id: 'test-zero', rank: -1, openedAt: 1, width: 1300, height: 900 } });
      await new Promise(resolve => setTimeout(resolve, 80));
      channel.postMessage({ type: 'window-assignment', token: 'test-zero', owner: 'test-zero', byWindow: { [id]: [] } });
      await new Promise(resolve => setTimeout(resolve, 120));
      const empty = { count: document.querySelectorAll('.pane').length,
        stored: sessionStorage.getItem('shellpuppet.dashboard.tracks') };
      channel.postMessage({ type: 'window-assignment', token: 'test-zero', owner: 'test-zero', byWindow: { [id]: ids } });
      await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('panes did not return')), 5000);
        const check = () => { if (document.querySelectorAll('.pane').length === ids.length) {
          clearTimeout(deadline); resolve();
        } else requestAnimationFrame(check); };
        check(); });
      const refilled = { count: document.querySelectorAll('.pane').length,
        width: document.getElementById('strip').getBoundingClientRect().width };
      channel.close(); return { empty, refilled }; })()`);
    return { saved, ...(interval as object) };
  });
  const result = shot.probe as { saved: string | null; empty: { count: number; stored: string | null };
    refilled: { count: number; width: number } };
  expect(result.saved).toContain('focusStrip');
  expect(result.empty.count).toBe(0);
  expect(result.empty.stored).toBeNull();
  expect(result.refilled.count).toBe(2);
  expect(result.refilled.width).toBeCloseTo(300, 0);
}, 150_000);
