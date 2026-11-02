import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let running: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await running?.stop(); running = null; }, 120_000);

async function openDashboard(width: number, height: number, interact: Parameters<typeof captureDashboard>[0]['interact']) {
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const started = await api(daemon.port, daemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cols: 100, rows: 30,
  } });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser: browser!, viewerUrl: urls.at(-1)!, width, height,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `(() => {
      window.__resizes = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"')) window.__resizes.push(JSON.parse(data));
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`,
    interact,
  });
  return { id, daemon, result: shot.probe };
}

it('fills the tile at the 400 column cap with a fixed text choice', async (context) => {
  if (!browser) { context.skip(); return; }
  const { result } = await openDashboard(5000, 1000, async ({ evaluate }) => evaluate(`(async () => {
    document.getElementById('text-smaller').click();
    await new Promise(resolve => setTimeout(resolve, 850));
    const tile = document.querySelector('.pane-term').getBoundingClientRect();
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { size: document.querySelector('.pane-size').textContent, font: Number(document.querySelector('.pane-term').dataset.fontSize),
      tileWidth: tile.width, screenWidth: screen.width, tileHeight: tile.height, screenHeight: screen.height,
      screenOffsetWidth: document.querySelector('.xterm-screen').offsetWidth,
      wrapWidth: document.querySelector('.pane-wrap').clientWidth };
  })()`));
  const measured = result as { size: string; font: number; tileWidth: number; screenWidth: number;
    tileHeight: number; screenHeight: number };
  expect(measured.size).toContain('400×');
  expect(measured.font, JSON.stringify(measured)).toBeGreaterThan(12);
  expect(measured.screenWidth / measured.tileWidth).toBeGreaterThan(0.94);
  expect(measured.screenWidth).toBeLessThanOrEqual(measured.tileWidth + 2);
}, 150_000);

it('refits one outside resize, follows a second, shows held grids whole, and Fit restores text', async (context) => {
  if (!browser) { context.skip(); return; }
  let daemon: TestDaemon;
  let id: string;
  const { result } = await openDashboard(1400, 900, async ({ evaluate }) => {
    // The session id comes from the single visible card; this callback runs after the dashboard is ready.
    id = String(await evaluate(`document.querySelector('.pane').dataset.session`));
    daemon = running!;
    await evaluate(`(async () => { document.getElementById('text-smaller').click();
      await new Promise(resolve => setTimeout(resolve, 650)); window.__resizes.length = 0; })()`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 194, rows: 100, hold: true } })).status).toBe(200);
    const heldFirst = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 650));
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent }; })()`);
    await evaluate(`window.__resizes.length = 0`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 194, rows: 100 } })).status).toBe(200);
    const first = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 700));
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent }; })()`);
    await evaluate(`window.__resizes.length = 0`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 210, rows: 110 } })).status).toBe(200);
    const second = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 700));
      const tile = document.querySelector('.pane-term').getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent,
        font: Number(document.querySelector('.pane-term').dataset.fontSize),
        contained: screen.width <= tile.width + 2 && screen.height <= tile.height + 2 }; })()`);
    await evaluate(`window.__resizes.length = 0`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 220, rows: 115, hold: true } })).status).toBe(200);
    const held = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 650));
      const tile = document.querySelector('.pane-term').getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent,
        tile: [tile.width, tile.height], screen: [screen.width, screen.height],
        contained: screen.width <= tile.width + 2 && screen.height <= tile.height + 2 }; })()`);
    const narrowHeld = await evaluate(`(async () => {
      const root = document.getElementById('panes'); root.style.width = '140px';
      window.dispatchEvent(new Event('resize'));
      await new Promise(resolve => setTimeout(resolve, 550));
      const tile = document.querySelector('.pane-term').getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      const result = { tile: [tile.width, tile.height], screen: [screen.width, screen.height],
        contained: screen.left >= tile.left - 2 && screen.right <= tile.right + 2 &&
          screen.top >= tile.top - 2 && screen.bottom <= tile.bottom + 2 };
      root.style.width = ''; window.dispatchEvent(new Event('resize'));
      await new Promise(resolve => setTimeout(resolve, 550));
      return result;
    })()`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 220, rows: 115 } })).status).toBe(200);
    const fit = await evaluate(`(async () => { document.querySelector('.pane button[aria-label="Fit"]').click();
      await new Promise(resolve => setTimeout(resolve, 500));
      return { font: Number(document.querySelector('.pane-term').dataset.fontSize),
        size: document.querySelector('.pane-size').textContent }; })()`);
    return { heldFirst, first, second, held, narrowHeld, fit };
  });
  const measured = result as { heldFirst: { frames: unknown[]; size: string }; first: { frames: unknown[]; size: string };
    second: { frames: unknown[]; size: string; font: number; contained: boolean };
    held: { frames: unknown[]; size: string; contained: boolean };
    narrowHeld: { tile: number[]; screen: number[]; contained: boolean }; fit: { font: number; size: string } };
  expect(measured.heldFirst.frames).toHaveLength(0);
  expect(measured.heldFirst.size).toContain('fixed');
  expect(measured.first.frames).toHaveLength(1);
  expect(measured.first.size).not.toContain('194×100');
  expect(measured.second.frames).toHaveLength(0);
  expect(measured.second.size).toContain('following');
  expect(measured.second.contained).toBe(true);
  expect(measured.second.font).toBeLessThan(12);
  expect(measured.held.frames).toHaveLength(0);
  expect(measured.held.size).toContain('fixed');
  expect(measured.held.contained, JSON.stringify(measured)).toBe(true);
  expect(measured.narrowHeld.contained, JSON.stringify(measured)).toBe(true);
  expect(measured.fit.font).toBe(12);
}, 150_000);
