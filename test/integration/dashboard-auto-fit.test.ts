import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let running: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await running?.stop(); running = null; }, 120_000);

it('fits a settled layout once per free pane, keeps the floor, and stops when switched off', async (context) => {
  if (!browser) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const started = await api(daemon.port, daemon.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
        openViewer: false, cols: 100, rows: 30 },
    });
    expect(started.status).toBe(200);
    ids.push(String(started.body['id']));
  }
  expect((await api(daemon.port, daemon.token, `/sessions/${ids[1]}/resize`,
    { body: { cols: 100, rows: 30, hold: true } })).status).toBe(200);
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1920, height: 1080,
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
    probe: `(() => {
      if (document.getElementById('connection')?.textContent !== 'Connected' ||
          [...document.querySelectorAll('.pane-size')].filter(x => x.textContent.includes('×')).length !== 2) return null;
      return true;
    })()`,
    interact: async ({ evaluate }) => evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      const initial = document.getElementById('auto-fit').getAttribute('aria-pressed');
      window.__resizes.length = 0;
      document.getElementById('focus').click();
      await new Promise(resolve => setTimeout(resolve, 450));
      const on = window.__resizes.slice();
      document.getElementById('auto-fit').click();
      window.__resizes.length = 0;
      document.getElementById('grid').click();
      await new Promise(resolve => setTimeout(resolve, 450));
      return { initial, on, off: window.__resizes.slice(),
        saved: JSON.parse(localStorage.getItem('shellpuppet.dashboard')).autoFit };
    })()`),
  });
  const result = shot.probe as { initial: string; on: { url: string; frame: { cols: number; rows: number } }[];
    off: unknown[]; saved: boolean };
  expect(result.initial).toBe('true');
  expect(result.on.filter(x => x.url.includes(ids[0]!))).toHaveLength(1);
  expect(result.on.filter(x => x.url.includes(ids[1]!))).toHaveLength(0);
  expect(result.on.every(x => x.frame.cols >= 80 && x.frame.rows >= 24)).toBe(true);
  expect(result.off).toEqual([]);
  expect(result.saved).toBe(false);
}, 150_000);
