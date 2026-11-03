import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
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

it.each([true, false])('focus profile keeps one floor-sized fit with Auto fit %s', async (enabled) => {
  if (!browser) return;
  const { config, problems } = parseDaemonConfig({ launcher: { profiles: [{
    name: 'focus-shell', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    shell: false, open: 'focus',
  }] } });
  expect(problems).toEqual([]);
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launchProfiles: config.launcher,
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 600, height: 210,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `(() => {
      window.__resizes = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"')) window.__resizes.push(JSON.parse(data));
        return send.call(this, data);
      };
    })()`,
    probe: `(() => {
      const state = (window.__focusProbe ||= { phase: 0, started: Date.now() });
      if (Date.now() - state.started > 20000) return JSON.stringify({ timeout: true, phase: state.phase,
        connection: document.getElementById('connection')?.textContent,
        error: document.getElementById('error-message')?.textContent,
        frames: window.__resizes });
      if (state.phase === 0) {
        const profile = document.getElementById('profile');
        if (document.getElementById('connection')?.textContent !== 'Connected' ||
            !profile?.querySelector('option[value="focus-shell"]')) return null;
        if (!${String(enabled)}) document.getElementById('auto-fit').click();
        profile.value = 'focus-shell';
        document.getElementById('start').click();
        state.phase = 1;
        return null;
      }
      const card = document.querySelector('.pane');
      if (!card || !card.querySelector('.pane-size')?.textContent.includes('×')) return null;
      state.paneReady ||= Date.now();
      if (Date.now() - state.paneReady < 700) return null;
      const tile = card.querySelector('.pane-term');
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;width:' + tile.clientWidth +
        'px;height:' + tile.clientHeight + 'px';
      document.body.append(host);
      const terminal = new Terminal({ fontSize: 6,
        fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace' });
      const fit = new FitAddon.FitAddon();
      terminal.loadAddon(fit); terminal.open(host);
      const proposal = fit.proposeDimensions();
      terminal.dispose(); host.remove();
      return JSON.stringify({ frames: window.__resizes, proposal,
        layout: document.getElementById('panes').dataset.layout,
        tile: [tile.clientWidth, tile.clientHeight] });
    })()`,
  });
  const result = JSON.parse(String(shot.probe)) as { timeout?: boolean; frames: { cols: number; rows: number; take: boolean }[];
    proposal?: { cols: number; rows: number }; layout?: string; tile?: number[] };
  expect(result.timeout, JSON.stringify(result)).toBeUndefined();
  expect(result.layout).toBe('focus');
  expect(result.proposal?.rows, JSON.stringify(result)).toBeLessThan(24);
  expect(result.frames, JSON.stringify(result)).toHaveLength(1);
  expect(result.frames[0]).toMatchObject({ take: true });
  expect(result.frames[0]!.cols).toBeGreaterThanOrEqual(80);
  expect(result.frames[0]!.rows).toBeGreaterThanOrEqual(24);
}, 150_000);

it('debounces a changing-width drag into one resize after settling', async (context) => {
  if (!browser) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  expect((await api(daemon.port, daemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cols: 100, rows: 30,
  } })).status).toBe(200);
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1800, height: 900,
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
    interact: async ({ evaluate }) => evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 450));
      window.__resizes.length = 0;
      const root = document.getElementById('panes');
      for (const width of [1600, 1450, 1300, 1150, 1000, 850]) {
        root.style.width = width + 'px';
        window.dispatchEvent(new Event('resize'));
        await new Promise(resolve => setTimeout(resolve, 35));
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      return { frames: window.__resizes, width: root.clientWidth };
    })()`),
  });
  const result = shot.probe as { frames: { cols: number; rows: number; take: boolean }[]; width: number };
  expect(result.width).toBe(850);
  expect(result.frames, JSON.stringify(result)).toHaveLength(1);
  expect(result.frames[0]).toMatchObject({ take: true });
}, 150_000);

it('keeps pane control through Enlarge, a closed session, and Restore in two windows', async (context) => {
  if (!browser) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
      openViewer: false, cols: 129, rows: 49,
    } });
    expect(started.status).toBe(200);
    ids.push(String(started.body['id']));
  }
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1920, height: 1080,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `(() => {
      window.__resizes = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"'))
          window.__resizes.push({ url: this.url, ...JSON.parse(data) });
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelectorAll('.pane-size').length === 5 &&
      [...document.querySelectorAll('.pane-size')].every(node => node.textContent.includes('×')) ? true : null)()`,
    interact: async ({ evaluate, send }) => {
      await send('Target.createTarget', { url: `${new URL(urls.at(-1)!).origin}/dashboard` });
      const shared = await evaluate(`(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (document.getElementById('share-count')?.textContent === '4 of 5 here, 2 windows') return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return document.getElementById('share-count')?.textContent;
      })()`);
      expect(shared).toBe(true);
      await evaluate(`(async () => {
        await new Promise(resolve => setTimeout(resolve, 700));
        document.querySelector('.pane[data-session="${ids[1]}"] button[aria-label="Enlarge"]').click();
        await new Promise(resolve => setTimeout(resolve, 600));
      })()`);
      expect((await api(daemon.port, daemon.token, `/sessions/${ids[0]}`, { method: 'DELETE' })).status).toBe(200);
      return evaluate(`(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (document.getElementById('share-count')?.textContent === '4 of 4 here, 2 windows') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        window.__resizes.length = 0;
        document.querySelector('.pane button[aria-label="Restore"]').click();
        await new Promise(resolve => setTimeout(resolve, 3000));
        return { share: document.getElementById('share-count')?.textContent,
          panes: [...document.querySelectorAll('.pane')].map(card => ({ id: card.dataset.session,
            size: card.querySelector('.pane-size')?.textContent })),
          resizes: window.__resizes.slice() };
      })()`);
    },
  });
  const result = shot.probe as { share: string; panes: { id: string; size: string }[];
    resizes: { url: string; cols: number; rows: number; take: boolean }[] };
  expect(result.share).toBe('4 of 4 here, 2 windows');
  expect(result.panes.map((pane) => pane.id)).toEqual(ids.slice(1));
  expect(result.panes.every((pane) => !pane.size.includes('following')), JSON.stringify(result)).toBe(true);
  for (const id of ids.slice(1)) {
    expect(result.resizes.filter((frame) => frame.url.includes(`/sessions/${id}/stream`)).length,
      JSON.stringify(result)).toBeLessThanOrEqual(1);
  }
}, 180_000);
