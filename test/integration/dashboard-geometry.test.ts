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
