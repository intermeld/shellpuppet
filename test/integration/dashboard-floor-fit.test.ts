import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let daemon: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await daemon?.stop(); daemon = null; }, 120_000);

interface PaneMeasurement {
  id: string;
  size: string;
  font: number;
  below: boolean;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  floorMaximum: number;
  gridMaximum: number;
}

async function startSession(cols = 96, rows = 24, hold = false) {
  const response = await api(daemon!.port, daemon!.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cwd: process.cwd(), cols, rows, hold,
  } });
  expect(response.status).toBe(200);
  return String(response.body['id']);
}

async function setup() {
  const urls: string[] = [];
  daemon = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  return async () => {
    expect((await api(daemon!.port, daemon!.token, '/dashboard/open', { body: {} })).status).toBe(200);
    return urls.at(-1)!;
  };
}

// Expose the public pane client to measure real xterm cells independently of
// the fitting algorithm. The browser still receives real daemon geometry.
const instrument = `(() => {
  localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid' }));
  const clients = window.__paneClients = new Map();
  let implementation;
  Object.defineProperty(window, 'ShellPuppetPane', {
    get: () => implementation,
    set: value => { implementation = { ...value, create(config) {
      const client = value.create(config); clients.set(config.sessionId, client); return client;
    } }; }
  });
  window.__measurePanes = (maxima = false) => [...document.querySelectorAll('.pane')].filter(card =>
    card.querySelector('.xterm-screen')).map(card => {
    const client = clients.get(card.dataset.session);
    const term = client.getTerminal();
    const screen = card.querySelector('.xterm-screen');
    const wrap = card.querySelector('.pane-wrap');
    const style = getComputedStyle(wrap);
    const width = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const drawn = term.options.fontSize;
    let floorMaximum = 0, gridMaximum = 0;
    if (maxima) {
      for (let font = 1; font <= 40; font++) {
        term.options.fontSize = font;
        if (Math.ceil(screen.offsetWidth * 80 / term.cols) <= width &&
            Math.ceil(screen.offsetHeight * 24 / term.rows) <= height) floorMaximum = font;
        if (screen.offsetWidth <= width && screen.offsetHeight <= height) gridMaximum = font;
      }
      if (gridMaximum === 0) {
        term.options.fontSize = 1;
        gridMaximum = Math.min(width / screen.offsetWidth, height / screen.offsetHeight);
      }
      term.options.fontSize = drawn;
    }
    return { id: card.dataset.session, size: card.querySelector('.pane-size').textContent,
      font: Number(card.querySelector('.pane-term').dataset.fontSize), below: card.classList.contains('below-floor'),
      width, height, screenWidth: screen.getBoundingClientRect().width,
      screenHeight: screen.getBoundingClientRect().height, floorMaximum, gridMaximum };
  });
  window.__settlePanes = async count => {
    let last = '', since = performance.now();
    const started = performance.now();
    while (performance.now() - started < 15000) {
      const panes = window.__measurePanes();
      const current = JSON.stringify(panes);
      if (last !== current) { last = current; since = performance.now(); }
      if (panes.length === count && panes.every(pane => pane.size.includes('×')) &&
          performance.now() - since > 1300) return window.__measurePanes(true);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Panes did not settle: ' + last);
  };
})()`;

function expectWhole(panes: PaneMeasurement[]) {
  for (const pane of panes) {
    expect(pane.screenWidth, JSON.stringify(pane)).toBeLessThanOrEqual(pane.width);
    expect(pane.screenHeight, JSON.stringify(pane)).toBeLessThanOrEqual(pane.height);
  }
}

function expectSharedFloor(panes: PaneMeasurement[]) {
  expect(panes.length).toBeGreaterThan(1);
  expect(panes.every(pane => pane.below), JSON.stringify(panes)).toBe(true);
  expect(panes.map(pane => pane.size), JSON.stringify(panes)).toEqual(panes.map(() => '80×24'));
  const maximum = Math.min(...panes.map(pane => pane.floorMaximum));
  expect(panes.map(pane => pane.font), JSON.stringify(panes)).toEqual(panes.map(() => maximum));
  expectWhole(panes);
}

it('shares the largest floor text after growth, shrinkage, a late arrival and a track drag', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const ids = [await startSession(), await startSession(), await startSession()];
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 750,
    drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: `window.__paneClients?.size === 3 ? true : null`,
    interact: async ({ evaluate, send }) => {
      await evaluate(`window.__settlePanes(3)`);
      const histories = await evaluate(`(async () => {
        const cards = [...document.querySelectorAll('.pane')];
        for (const [index, dimensions] of [[320, 220], [1200, 700], [600, 260]].entries()) {
          cards[index].style.width = dimensions[0] + 'px'; cards[index].style.height = dimensions[1] + 'px';
          window.__paneClients.get(cards[index].dataset.session).relayout(false);
        }
        const before = window.__measurePanes();
        for (const card of cards) { card.style.width = '600px'; card.style.height = '300px'; }
        window.dispatchEvent(new Event('resize'));
        return before;
      })()`);
      const late = await startSession();
      ids.push(late);
      await evaluate(`window.__settlePanes(4)`);
      const equal = await evaluate(`(async () => {
        for (const card of document.querySelectorAll('.pane')) { card.style.width = '600px'; card.style.height = '300px'; }
        for (const client of window.__paneClients.values()) client.relayout(false);
        document.getElementById('text-auto').click();
        return window.__settlePanes(4);
      })()`) as PaneMeasurement[];
      // A wide window allows a real column divider to move while its short
      // tracks remain below the floor. The narrower track sets everyone's text.
      await evaluate(`(() => { for (const card of document.querySelectorAll('.pane')) {
        card.style.removeProperty('width'); card.style.removeProperty('height');
      } })()`);
      await evaluate(`(() => { for (let index = 0; index < 11; index++) document.getElementById('text-larger').click(); })()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.__settlePanes(4)`);
      const divider = await evaluate(`document.querySelector('.pane-divider[data-axis="column"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
      const x = divider.x + divider.width / 2, y = divider.y + divider.height / 4;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 250, y, button: 'left', buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 250, y, button: 'left', clickCount: 1 });
      const dragged = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      await evaluate(`document.getElementById('text-auto').click()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1500, deviceScaleFactor: 1, mobile: false });
      const grown = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      return { histories, equal, dragged, grown };
    },
  });
  const result = shot.probe as { histories: PaneMeasurement[]; equal: PaneMeasurement[]; dragged: PaneMeasurement[]; grown: PaneMeasurement[] };
  expect(result.histories[0]!.font).toBeLessThan(result.histories[1]!.font);
  expectSharedFloor(result.equal);
  expectSharedFloor(result.dragged);
  expect(new Set(result.dragged.map(pane => pane.width)).size).toBe(2);
  expect(result.grown.every(pane => !pane.below && pane.size !== '80×24' && pane.font >= 13), JSON.stringify(result)).toBe(true);
  expectWhole(result.grown);
  for (const id of ids) {
    const snapshot = await api(daemon!.port, daemon!.token, `/sessions/${id}/snapshot`);
    expect(snapshot.body['cols']).toBeGreaterThan(80);
    expect(snapshot.body['rows']).toBeGreaterThan(24);
  }
}, 180_000);

it('keeps Focus independent and preserves held and followed grids beside the shared floor', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const main = await startSession();
  const free = await startSession();
  const held = await startSession(120, 40, true);
  const followed = await startSession();
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 1700, height: 1000,
    drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: `window.__paneClients?.size === 4 ? true : null`,
    interact: async ({ evaluate }) => {
      await evaluate(`window.__settlePanes(4)`);
      await evaluate(`(() => { document.querySelector('.pane[data-session="${main}"]').click(); document.getElementById('focus').click(); })()`);
      await evaluate(`window.__settlePanes(4)`);
      expect((await api(daemon!.port, daemon!.token, `/sessions/${followed}/resize`,
        { body: { cols: 140, rows: 45 } })).status).toBe(200);
      const before = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      await evaluate(`document.querySelector('.pane[data-session="${followed}"] button[aria-label="Fit"]').click()`);
      const taken = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      return { before, taken };
    },
  });
  const { before, taken } = shot.probe as { before: PaneMeasurement[]; taken: PaneMeasurement[] };
  const primary = before.find(pane => pane.id === main)!;
  const ordinary = before.find(pane => pane.id === free)!;
  const fixed = before.find(pane => pane.id === held)!;
  const following = before.find(pane => pane.id === followed)!;
  expect(ordinary.size).toBe('80×24');
  expect(primary.below).toBe(false);
  expect(primary.font).toBeGreaterThan(ordinary.font);
  expect(primary.size).not.toBe('80×24');
  expect(fixed.size).toBe('120×40 (fixed)');
  expect(following.size).toBe('140×45 (following)');
  const shared = Math.min(...before.filter(pane => pane.below).map(pane => pane.floorMaximum));
  expect(ordinary.font).toBe(shared);
  for (const pane of [fixed, following]) expect(pane.font, JSON.stringify(before)).toBe(Math.min(shared, pane.gridMaximum));
  expectWhole(before);
  const sharedAfter = Math.min(...taken.filter(pane => pane.below).map(pane => pane.floorMaximum));
  for (const pane of taken.filter(pane => pane.id === free || pane.id === followed)) {
    expect(pane.size).toBe('80×24');
    expect(pane.font).toBe(sharedAfter);
  }
  expectWhole(taken);
  const snapshot = await api(daemon!.port, daemon!.token, `/sessions/${held}/snapshot`);
  expect([snapshot.body['cols'], snapshot.body['rows']]).toEqual([120, 40]);
}, 180_000);

it('measures the floor at the remembered text choice and recovers after growing', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  await startSession(); await startSession();
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 1550, height: 650,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `${instrument}; localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid', fontSize: 24 }));`,
    probe: `window.__paneClients?.size === 2 ? true : null`,
    interact: async ({ evaluate, send }) => {
      const largeChoice = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await evaluate(`(() => { for (let index = 0; index < 16; index++) document.getElementById('text-smaller').click(); })()`);
      const smallChoice = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await evaluate(`(() => { for (let index = 0; index < 16; index++) document.getElementById('text-larger').click(); })()`);
      const restored = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await send('Emulation.setDeviceMetricsOverride', { width: 2800, height: 1100, deviceScaleFactor: 1, mobile: false });
      const grown = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await evaluate(`document.getElementById('auto-fit').click()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 1550, height: 650, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.__settlePanes(2)`);
      await evaluate(`document.querySelector('.pane button[aria-label="Enlarge"]').click()`);
      await evaluate(`window.__settlePanes(1)`);
      await evaluate(`document.querySelector('.pane button[aria-label="Restore"]').click()`);
      const restoredPane = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      return { largeChoice, smallChoice, restored, grown, restoredPane };
    },
  });
  const result = shot.probe as Record<'largeChoice' | 'smallChoice' | 'restored' | 'grown' | 'restoredPane', PaneMeasurement[]>;
  expectSharedFloor(result.largeChoice);
  expectSharedFloor(result.restored);
  expect(result.largeChoice.map(pane => pane.font)).toEqual(result.restored.map(pane => pane.font));
  expect(result.smallChoice.every(pane => !pane.below && pane.font === 8 && pane.size !== '80×24'), JSON.stringify(result)).toBe(true);
  expect(result.grown.every(pane => !pane.below && pane.font === 24 && pane.size !== '80×24'), JSON.stringify(result)).toBe(true);
  expectWhole(result.grown);
  expect(result.restoredPane[0]!.size).toBe('80×24');
  expectWhole(result.restoredPane);
}, 180_000);
