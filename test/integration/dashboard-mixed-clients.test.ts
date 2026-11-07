import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { captureDashboard } from './dashboardCapture.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let running: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await running?.stop(); running = null; }, 120_000);

const recordFrames = `(() => {
  window.__resizes = [];
  window.__geometry = [];
  const Native = window.WebSocket;
  const send = Native.prototype.send;
  Native.prototype.send = function(data) {
    if (typeof data === 'string' && data.includes('"type":"resize"'))
      window.__resizes.push(JSON.parse(data));
    return send.call(this, data);
  };
  window.WebSocket = new Proxy(Native, { construct(Target, args) {
    const socket = new Target(...args);
    if (String(args[0]).includes('/stream')) socket.addEventListener('message', event => {
      if (typeof event.data === 'string' && event.data.includes('"type":"geometry"'))
        window.__geometry.push(JSON.parse(event.data));
    });
    return socket;
  } });
})()`;

it('bounds resize frames across two dashboards and a passive single-session viewer', async (context) => {
  if (!browser) { context.skip(); return; }
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
  for (let index = 0; index < 2; index++) {
    expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  }
  const minted = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, { body: {} });
  expect(minted.status).toBe(200);
  const viewerUrl = `${String(minted.body['viewerUrl'])}&drive=0`;

  type Evaluate = (expression: string) => Promise<unknown>;
  const pages: Evaluate[] = [];
  const readyResolve: (() => void)[] = [];
  const ready = [0, 1, 2].map((index) => new Promise<void>((resolve) => { readyResolve[index] = resolve; }));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const interact = (index: number) => async ({ evaluate }: { evaluate: Evaluate }) => {
    pages[index] = evaluate;
    readyResolve[index]!();
    await held;
    return true;
  };
  const dashboardProbe = `(() => document.getElementById('connection')?.textContent === 'Connected' &&
    document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`;
  const captures: Promise<unknown>[] = [];
  try {
    captures.push(captureDashboard({ browser, viewerUrl: urls[0]!, width: 1400, height: 900, drive: true,
      beforeNavigateScript: recordFrames, probe: dashboardProbe, interact: interact(0), timeoutMs: 150_000 }));
    await Promise.race([ready[0], captures[0]]);
    captures.push(captureDashboard({ browser, viewerUrl: urls[1]!, width: 1200, height: 800, drive: true,
      beforeNavigateScript: recordFrames, probe: dashboardProbe, interact: interact(1), timeoutMs: 150_000 }));
    await Promise.race([ready[1], captures[1]]);
    captures.push(captureViewer({ browser, viewerUrl, width: 900, height: 700, drive: true,
      beforeNavigateScript: recordFrames, probe: `(() => document.getElementById('size')?.textContent.includes('×') ? true : null)()`,
      interact: interact(2), timeoutMs: 150_000 }));
    await Promise.race([ready[2], captures[2]]);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await pages[0]!(`document.querySelector('.pane button[aria-label="Fit"]').click()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await Promise.all(pages.map((evaluate) => evaluate(`window.__resizes.length = 0`)));
    await pages[0]!(`(() => {
      document.getElementById('panes').style.width = '1100px';
      window.dispatchEvent(new Event('resize'));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const layoutFrames = await Promise.all(pages.map((evaluate) => evaluate(`window.__resizes.length`))) as number[];
    expect(layoutFrames[0]! + layoutFrames[1]!).toBeGreaterThanOrEqual(1);
    expect(layoutFrames[0]! + layoutFrames[1]!).toBeLessThanOrEqual(2);
    expect(layoutFrames[2]).toBe(0);
    await pages[0]!(`document.querySelector('.pane button[aria-label="Fit"]').click()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await Promise.all(pages.map((evaluate) => evaluate(`window.__resizes.length = 0`)));

    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 194, rows: 100 } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const first = await Promise.all(pages.map((evaluate) => evaluate(`({
      frames: window.__resizes.length, owner: window.__geometry.at(-1)?.control,
      cols: window.__geometry.at(-1)?.cols, rows: window.__geometry.at(-1)?.rows
    })`))) as { frames: number; owner: string; cols: number; rows: number }[];
    expect(first.map(page => page.frames)).toEqual([0, 0, 0]);
    expect(first.map(page => [page.cols, page.rows])).toEqual([[194, 100], [194, 100], [194, 100]]);
    expect(first.filter((page) => page.owner === 'yours')).toHaveLength(0);
    await Promise.all(pages.map((evaluate) => evaluate(`window.__resizes.length = 0`)));

    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 210, rows: 110 } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const second = await Promise.all(pages.map((evaluate) => evaluate(`window.__resizes.length`))) as number[];
    expect(second).toEqual([0, 0, 0]);
  } finally {
    release();
    await Promise.allSettled(captures);
  }
}, 240_000);
