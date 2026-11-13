import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard, dashboardDiagnosticsScript, dashboardTimeoutProbe } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { api, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let running: TestDaemon | null = null;

it('retries an initial fit lost on socket close', async (context) => {
  const found = await findBrowser();
  if (!found) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const started = await api(daemon.port, daemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cols: 129, rows: 49,
  } });
  expect(started.status).toBe(200);
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser: found, viewerUrl: urls.at(-1)!, width: 1400, height: 900,
    drive: true, probeOnly: true, timeoutMs: 30_000,
    beforeNavigateScript: `(() => {
      window.__droppedTakes = 0;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"') && data.includes('"take":true')) {
          window.__droppedTakes++;
          if (window.__droppedTakes === 1) { this.close(); return; }
        }
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`,
    interact: async ({ evaluate }) => {
      await eventually(async () => Number(await evaluate('window.__droppedTakes')) >= 1, 10_000);
      await new Promise(resolve => setTimeout(resolve, 5_000));
      return await evaluate(`({ takes: window.__droppedTakes, size: document.querySelector('.pane-size')?.textContent })`);
    },
  });
  const result = shot.probe as { takes: number; size: string };
  expect(result.takes, JSON.stringify(result)).toBeGreaterThanOrEqual(2);
  expect(result.size).not.toContain('following');
}, 60_000);

it('retries the same Auto fit size after a held take is refused', async (context) => {
  const found = await findBrowser();
  if (!found) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const started = await api(daemon.port, daemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cols: 129, rows: 49,
  } });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser: found, viewerUrl: urls.at(-1)!, width: 1400, height: 900,
    drive: true, probeOnly: true, timeoutMs: 60_000,
    beforeNavigateScript: `(() => {
      window.__heldAttempts = [];
      window.__paneClients = [];
      let paneApi;
      Object.defineProperty(window, 'ShellPuppetPane', {
        configurable: true,
        get: () => paneApi,
        set: (value) => {
          paneApi = value;
          const create = value.create;
          value.create = (...args) => {
            const client = create(...args);
            window.__paneClients.push(client);
            return client;
          };
        },
      });
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"') && data.includes('"take":true')) {
          window.__heldAttempts.push(JSON.parse(data));
          if (window.__holdNextTake) {
            window.__holdNextTake = false;
            window.__heldRequest = { socket: this, data, send };
            return;
          }
        }
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`,
    interact: async ({ evaluate }) => {
      await eventually(async () => (await evaluate('window.__heldAttempts?.length')) === 1 &&
        !String(await evaluate(`document.querySelector('.pane-size')?.textContent`)).includes('following'), 10_000);
      expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
        { body: { cols: 129, rows: 49, hold: false } })).status).toBe(200);
      await eventually(async () => String(await evaluate(`document.querySelector('.pane-size')?.textContent`)).includes('following'),
        10_000);
      await evaluate(`(() => {
        window.__holdNextTake = true;
        window.__paneClients.at(-1).takeGrid(window.__heldAttempts[0].cols, window.__heldAttempts[0].rows);
      })()`);
      await eventually(async () => (await evaluate('window.__heldAttempts?.length')) === 2, 10_000);
      expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
        { body: { cols: 129, rows: 49, hold: true } })).status).toBe(200);
      await eventually(async () => String(await evaluate(`document.querySelector('.pane-size')?.textContent`)).includes('fixed'),
        10_000);
      const beforeRefusal = Number(await evaluate(`window.__dashboardDiagnostics.streams.find(x =>
        x.url.includes('/sessions/${id}/stream')).geometry.length`));
      await evaluate('window.__heldRequest.send.call(window.__heldRequest.socket, window.__heldRequest.data)');
      await eventually(async () => Number(await evaluate(`window.__dashboardDiagnostics.streams.find(x =>
        x.url.includes('/sessions/${id}/stream')).geometry.length`)) > beforeRefusal, 10_000);
      expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
        { body: { cols: 129, rows: 49, hold: false } })).status).toBe(200);
      await eventually(async () => String(await evaluate(`document.querySelector('.pane-size')?.textContent`)).includes('following'),
        10_000);
      const retried = await evaluate(`(() => {
        window.__paneClients.at(-1).autoFitGrid(80, 24, true);
        return window.__heldAttempts.slice();
      })()`);
      return retried;
    },
  });
  const attempts = shot.probe as { cols: number; rows: number }[];
  expect(attempts.length, JSON.stringify(attempts)).toBeGreaterThanOrEqual(3);
  expect(attempts[2]).toEqual(attempts[1]);
}, 120_000);

it.for(['keep', 'drop', 'dismiss', 'reload', 'pop'])(
  'a second dashboard pane follows a human fit after %s', { timeout: 120_000 }, async (action, context) => {
  const found = await findBrowser();
  if (!found) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const started = await api(daemon.port, daemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cols: 129, rows: 49,
  } });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser: found, viewerUrl: urls.at(-1)!, width: 1400, height: 900,
    drive: true, probeOnly: true, timeoutMs: 80_000,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`,
    interact: async ({ evaluate, send }) => {
      await evaluate(`document.querySelector('.pane button[aria-label="Fit"]').click()`);
      await eventually(async () => !String(await evaluate(`document.querySelector('.pane-size')?.textContent`)).includes('following'), 10_000);
      const target = await send('Target.createTarget', { url: 'about:blank' }, true) as { targetId: string };
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true) as { sessionId: string };
      const second = async (expression: string): Promise<unknown> => {
        const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
          attached.sessionId) as { result: { value?: unknown }; exceptionDetails?: { text: string } };
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
        return response.result.value;
      };
      await send('Page.enable', {}, attached.sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: dashboardDiagnosticsScript }, attached.sessionId);
      await send('Emulation.setDeviceMetricsOverride',
        { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, attached.sessionId);
      await send('Page.navigate', { url: `${new URL(urls.at(-1)!).origin}/dashboard` }, attached.sessionId);
      await eventually(async () => (await second(`!!window.ShellPuppetPane &&
        !!document.querySelector('meta[name="sp-csrf"]')`)) === true, 10_000);
      await second(`(() => {
        window.__secondPaneTakes = 0;
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
          if (typeof data === 'string' && data.includes('"type":"resize"') && data.includes('"take":true'))
            window.__secondPaneTakes++;
          return send.call(this, data);
        };
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:0;top:0;width:350px;height:250px';
        document.body.append(box);
        window.__secondPane = ShellPuppetPane.create({ container: box, sessionId: '${id}',
          dashboardProof: document.querySelector('meta[name="sp-csrf"]').content,
          onGeometryReady: () => setTimeout(() => {
            window.__secondPaneAuto = window.__secondPane.autoFitGrid();
          }, 300) });
      })()`);
      await new Promise(resolve => setTimeout(resolve, 2_000));
      if (action !== 'keep') {
        const controller = (daemon.daemon as unknown as {
          geometryController: Map<string, { close: () => void; readyState: number }>;
        }).geometryController.get(id);
        expect(controller).toBeDefined();
        if (action === 'drop') controller!.close();
        if (action === 'dismiss') await evaluate(`document.querySelector('.pane [data-action="dismiss"]').click()`);
        if (action === 'reload') await send('Page.reload');
        if (action === 'pop') await evaluate(`(() => {
          window.__releaseFrames = 0;
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function(data) {
            if (typeof data === 'string' && data.includes('"type":"release-grid"')) window.__releaseFrames++;
            return send.call(this, data);
          };
        })()`);
        if (action === 'pop') await send('Runtime.evaluate', {
          expression: 'document.querySelector(\'.pane [data-action="pop"]\').click()',
          returnByValue: true, userGesture: true,
        });
        await eventually(() => controller!.readyState === 3, 10_000);
        await new Promise(resolve => setTimeout(resolve, 3_000));
        if (action === 'pop') expect(await evaluate('window.__releaseFrames')).toBe(0);
      }
      return await second(`({ auto: window.__secondPaneAuto, takes: window.__secondPaneTakes,
        geometry: window.__dashboardDiagnostics?.streams?.filter(x => x.url.includes('/sessions/${id}/stream'))
          .flatMap(x => x.geometry).find(x => x.control === 'adopt'),
        latest: window.__dashboardDiagnostics?.streams?.filter(x => x.url.includes('/sessions/${id}/stream'))
          .flatMap(x => x.geometry).at(-1),
        streams: window.__dashboardDiagnostics?.streams?.filter(x => x.url.includes('/sessions/${id}/stream')).map(x => x.geometry),
        panes: document.querySelectorAll('.pane').length })`);
    },
  });
  const result = shot.probe as { auto: boolean; takes: number;
    geometry?: { dashboardTransferable?: boolean; control: string };
    latest?: { dashboardTransferable?: boolean; control: string } };
  expect(result.geometry?.control, JSON.stringify(result)).toBe('adopt');
  expect(result.geometry?.dashboardTransferable, JSON.stringify(result)).toBe(false);
  expect(result.auto, JSON.stringify(result)).toBe(false);
  expect(result.takes).toBe(0);
  expect(result.latest?.dashboardTransferable, JSON.stringify(result)).toBe(false);
});

let browser: string | null = null;
const FIT_SETTLE_MS = 3000 + 250 + 100;
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
    drive: true, probeOnly: true, timeoutMs: 120_000,
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
      const initial = document.getElementById('auto-fit').getAttribute('aria-pressed');
      window.__resizes.length = 0;
      document.getElementById('focus').click();
      const waitFor = async (step, read, ready) => {
        let last;
        const started = Date.now();
        while (Date.now() - started < 5000) {
          last = read();
          if (ready(last)) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Timed out waiting for ' + step + '; last observed: ' + JSON.stringify(last));
      };
      await waitFor('the Focus pane take', () => ({
        active: document.getElementById('focus').classList.contains('active'),
        resizes: window.__resizes.slice(),
      }), state => state.active && state.resizes.some(frame => frame.url.includes(${JSON.stringify(ids[0])}) && frame.frame.take));
      await new Promise(resolve => setTimeout(resolve, ${FIT_SETTLE_MS}));
      const on = window.__resizes.slice();
      document.getElementById('auto-fit').click();
      window.__resizes.length = 0;
      document.getElementById('grid').click();
      await waitFor('the settled Grid layout', () => ({
        active: document.getElementById('grid').classList.contains('active'),
        panes: [...document.querySelectorAll('.pane')].map(pane => pane.getBoundingClientRect().width),
      }), state => state.active && state.panes.length === 2 && state.panes.every(width => width > 0));
      await new Promise(resolve => setTimeout(resolve, ${FIT_SETTLE_MS}));
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

it('takes a newly arrived pane within three seconds during ten seconds of session churn', async (context) => {
  if (!browser) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1280, height: 720,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `(() => {
      window.__takes = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"window-register"')) window.__feed = this;
        if (typeof data === 'string' && data.includes('"type":"resize"'))
          window.__takes.push({ at: performance.now(), url: this.url, ...JSON.parse(data) });
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' && window.__feed ? true : null)()`,
    interact: async ({ evaluate }) => {
      await evaluate(`(() => {
        window.__churnChanges = 0;
        const change = () => {
          const index = ++window.__churnChanges;
          const id = 'churn-' + Math.ceil(index / 2);
          const frame = index % 2 === 1
            ? { type: 'session-added', session: { id, label: id } }
            : { type: 'session-removed', session: id };
          window.__feed.onmessage({ data: JSON.stringify(frame) });
        };
        change();
        window.__churnTimer = setInterval(change, 800);
      })()`);
      const started = await api(daemon.port, daemon.token, '/sessions', { body: {
        command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
        openViewer: false, cols: 100, rows: 30,
      } });
      expect(started.status).toBe(200);
      const id = String(started.body['id']);
      const measured = await evaluate(`(async () => {
        const waitFor = async (step, read, ready) => {
          let last;
          const started = performance.now();
          while (performance.now() - started < 15000) {
            last = read();
            if (ready(last)) return last;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Timed out waiting for ' + step + '; last observed: ' + JSON.stringify(last));
        };
        await waitFor('the arriving pane', () => document.querySelectorAll('.pane[data-session=${JSON.stringify(id)}]').length,
          count => count === 1);
        const arrivedAt = performance.now();
        await waitFor('13 churn changes over ten seconds', () => window.__churnChanges, count => count >= 13);
        clearInterval(window.__churnTimer);
        return { arrivedAt, changes: window.__churnChanges,
          takes: window.__takes.filter(frame => frame.url.includes(${JSON.stringify(id)}) && frame.take) };
      })()`) as { arrivedAt: number; changes: number; takes: { at: number }[] };
      return measured;
    },
  });
  const result = shot.probe as { arrivedAt: number; changes: number; takes: { at: number }[] };
  expect(result.changes).toBeGreaterThanOrEqual(13);
  expect(result.takes.length, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.takes[0]!.at - result.arrivedAt, JSON.stringify(result)).toBeLessThanOrEqual(3300);
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
      const state = (window.__focusProbe ||= { phase: 0 });
      if (state.started && Date.now() - state.started > 20000 + ${FIT_SETTLE_MS}) return JSON.stringify({ timeout: true, phase: state.phase,
        connection: document.getElementById('connection')?.textContent,
        error: document.getElementById('error-message')?.textContent,
        paneSize: document.querySelector('.pane-size')?.textContent,
        layout: document.getElementById('panes')?.dataset.layout,
        frames: window.__resizes });
      if (state.phase === 0) {
        const profile = document.getElementById('profile');
        if (document.getElementById('connection')?.textContent !== 'Connected' ||
            !profile?.querySelector('option[value="focus-shell"]')) return null;
        state.started = Date.now();
        if (!${String(enabled)}) document.getElementById('auto-fit').click();
        profile.value = 'focus-shell';
        document.getElementById('start').click();
        state.phase = 1;
        return null;
      }
      const card = document.querySelector('.pane');
      if (!card || !card.querySelector('.pane-size')?.textContent.includes('×')) return null;
      if (window.__resizes.length === 0) return null;
      if (!state.firstResizeAt) state.firstResizeAt = Date.now();
      if (Date.now() - state.firstResizeAt < ${FIT_SETTLE_MS}) return null;
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

it('clears a same-size Fit request and sends no repeat take across three relayouts', async (context) => {
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
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1400, height: 900,
    drive: true, timeoutMs: 120_000,
    probe: `(() => document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`,
    interact: async ({ evaluate }) => evaluate(`(async () => {
      const socket = window.__dashboardDiagnostics.streams.find(entry =>
        entry.url.includes('/stream') && entry.socket.readyState === 1)?.socket;
      if (!socket) return { error: 'no pane socket' };
      const takes = [];
      const geometry = [];
      const send = socket.send.bind(socket);
      socket.send = data => {
        if (typeof data === 'string' && data.includes('"take":true')) takes.push(JSON.parse(data));
        return send(data);
      };
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        try { const frame = JSON.parse(event.data); if (frame.type === 'geometry') geometry.push(frame); } catch {}
      });
      const waitForGeometry = async count => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (geometry.length >= count) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      };
      const fit = () => document.querySelector('.pane button[aria-label="Fit"]').click();
      fit();
      if (!await waitForGeometry(1)) return { error: 'first Fit was not acknowledged', takes, geometry };
      takes.length = 0;
      geometry.length = 0;
      fit();
      const acknowledged = await waitForGeometry(1);
      const sameSize = takes.length === 1 && geometry[0]?.cols === takes[0]?.cols &&
        geometry[0]?.rows === takes[0]?.rows && geometry[0]?.control === 'yours';
      takes.length = 0;
      for (let index = 0; index < 3; index++) {
        window.dispatchEvent(new Event('resize'));
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      return { acknowledged, sameSize, repeats: takes.length };
    })()`),
  });
  expect(shot.probe).toMatchObject({ acknowledged: true, sameSize: true, repeats: 0 });
}, 150_000);

it('keeps pane control through Enlarge, a closed session, and Restore in two windows', async (context) => {
  if (!browser) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const ids: string[] = [];
  for (let index = 0; index < 6; index++) {
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
      openViewer: false, cols: 129, rows: 49,
    } });
    expect(started.status).toBe(200);
    ids.push(String(started.body['id']));
  }
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1920, height: 1080,
    drive: true, probeOnly: true, timeoutMs: 120_000,
    beforeNavigateScript: `(() => {
      window.__resizes = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
         if (typeof data === 'string' && data.includes('"type":"resize"')) {
           const frame = { url: this.url, ...JSON.parse(data) };
           if (window.__delayRestoredTake && frame.take) {
             setTimeout(() => { window.__resizes.push(frame); send.call(this, data); }, 4500);
             return;
           }
           window.__resizes.push(frame);
         }
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelectorAll('.pane-size').length === 6 &&
      [...document.querySelectorAll('.pane-size')].every(node => node.textContent.includes('×')) ? true : null)()`,
    interact: async ({ evaluate, send }) => {
      const target = await send('Target.createTarget', { url: 'about:blank' }, true) as { targetId: string };
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true) as { sessionId: string };
      const evaluateSecond = async (expression: string): Promise<unknown> => {
        const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
          attached.sessionId) as { result: { value?: unknown } };
        return response.result.value;
      };
      await send('Page.enable', {}, attached.sessionId);
      await send('Emulation.setDeviceMetricsOverride',
        { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, attached.sessionId);
      await send('Page.navigate', { url: `${new URL(urls.at(-1)!).origin}/dashboard` }, attached.sessionId);
      const waitFor = async (step: string, read: () => Promise<unknown>, ready: (value: unknown) => boolean) => {
        let last: unknown;
        const started = Date.now();
        while (Date.now() - started < 20_000) {
          try { last = await read(); if (ready(last)) return; }
          catch (error) { last = String(error); }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`${step} did not settle after ${String(Date.now() - started)} ms: ${JSON.stringify(last)}`);
      };
      const share = (read: (expression: string) => Promise<unknown>) => read("document.getElementById('share-count')?.textContent");
      await waitFor('primary sharing six sessions', () => share(evaluate), value => value === '4 of 6 here, 2 windows');
      await waitFor('second window sharing six sessions', () => share(evaluateSecond), value => value === '2 of 6 here, 2 windows');
      await evaluateSecond(`(() => {
        window.__resizes = [];
        const secondSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
          if (typeof data === 'string' && data.includes('"type":"resize"'))
            window.__resizes.push({ url: this.url, ...JSON.parse(data) });
          return secondSend.call(this, data);
        };
      })()`);
      await send('Page.bringToFront');
      await evaluate(`document.querySelector('.pane[data-session="${ids[1]}"] button[aria-label="Enlarge"]').click()`);
      await waitFor('Enlarge', () => evaluate(`({ count: document.querySelectorAll('.pane').length,
        restore: !!document.querySelector('.pane button[aria-label="Restore"]') })`),
      value => (value as { count: number; restore: boolean })?.count === 1 && (value as { restore: boolean }).restore);
      expect((await api(daemon.port, daemon.token, `/sessions/${ids[0]}`, { method: 'DELETE' })).status).toBe(200);
      await evaluateSecond(`window.__resizes.length = 0`);
      await waitFor('primary sharing five sessions', () => share(evaluate), value => value === '4 of 5 here, 2 windows');
      await evaluate(`(() => { window.__resizes.length = 0; window.__delayRestoredTake = true;
        document.querySelector('.pane button[aria-label="Restore"]').click(); })()`);
      const readFirst = () => evaluate(`(() => ({ share: document.getElementById('share-count')?.textContent,
          panes: [...document.querySelectorAll('.pane')].map(card => ({ id: card.dataset.session,
            size: card.querySelector('.pane-size')?.textContent })),
          resizes: window.__resizes.slice() }))()`);
      const readSecond = () => evaluateSecond(`(() => ({
        share: document.getElementById('share-count')?.textContent,
        panes: [...document.querySelectorAll('.pane')].map(card => ({ id: card.dataset.session,
          size: card.querySelector('.pane-size')?.textContent })),
        resizes: window.__resizes.slice(),
      }))()`);
      await waitFor('Restore and primary pane takes', readFirst, value => {
        const state = value as { panes?: { id: string; size: string }[] };
        return state?.panes?.length === 4 && state.panes.every(pane => !pane.size.includes('following'));
      });
      await send('Page.bringToFront', {}, attached.sessionId);
      await waitFor('second window pane take', readSecond, value => {
        const state = value as { share?: string; panes?: { size: string }[] };
        return state?.share === '1 of 5 here, 2 windows' && state.panes?.length === 1 &&
          !state.panes[0]?.size.includes('following');
      });
      const first = await readFirst();
      const second = await readSecond();
      return { ...first as object, second };
    },
  });
  const result = shot.probe as { share: string; panes: { id: string; size: string }[];
    resizes: { url: string; cols: number; rows: number; take: boolean }[];
    second: { share: string; panes: { id: string; size: string }[];
      resizes: { url: string; cols: number; rows: number; take: boolean }[] } };
  expect(result.share).toBe('4 of 5 here, 2 windows');
  expect(result.panes.map((pane) => pane.id)).toEqual(ids.slice(1, 5));
  expect(result.panes.every((pane) => !pane.size.includes('following')), JSON.stringify(result)).toBe(true);
  expect(result.second.share).toBe('1 of 5 here, 2 windows');
  expect(result.second.panes.map((pane) => pane.id)).toEqual(ids.slice(5));
  expect(result.second.panes.every((pane) => !pane.size.includes('following')), JSON.stringify(result)).toBe(true);
  for (const id of ids.slice(1, 5)) {
    expect(result.resizes.filter((frame) => frame.url.includes(`/sessions/${id}/stream`)).length,
      JSON.stringify(result)).toBeLessThanOrEqual(1);
  }
  expect(result.second.resizes.filter((frame) => frame.url.includes(`/sessions/${ids[5]}/stream`)).length,
    JSON.stringify(result)).toBeLessThanOrEqual(1);
}, 180_000);

it('takes only the final grid when two window assignments arrive in separate steps', async (context) => {
  if (!browser) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const ids: string[] = [];
  const startSession = async () => {
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
      openViewer: false, cols: 129, rows: 49,
    } });
    expect(started.status).toBe(200);
    ids.push(String(started.body['id']));
  };
  for (let index = 0; index < 6; index++) await startSession();
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1920, height: 1080,
    drive: true, probeOnly: true, timeoutMs: 120_000,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelectorAll('.pane-size').length === 6 &&
      [...document.querySelectorAll('.pane-size')].every(node => node.textContent.includes('×')) ? true : null)()`,
    interact: async ({ evaluate, send }) => {
      // Capture the real assignment published when the second window joins.
      await evaluate(`(() => {
        const post = BroadcastChannel.prototype.postMessage;
        BroadcastChannel.prototype.postMessage = function(data) {
          if (data.type === 'window-assignment') window.__publishedAssignment = data;
          return post.call(this, data);
        };
        window.__restoreAssignmentCapture = () => { BroadcastChannel.prototype.postMessage = post; };
      })()`);
      const target = await send('Target.createTarget', { url: 'about:blank' }, true) as { targetId: string };
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true) as { sessionId: string };
      const evaluateSecond = async (expression: string): Promise<unknown> => {
        const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
          attached.sessionId) as { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result.value;
      };
      await send('Page.enable', {}, attached.sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: dashboardDiagnosticsScript }, attached.sessionId);
      await send('Emulation.setDeviceMetricsOverride',
        { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, attached.sessionId);
      await send('Page.navigate', { url: `${new URL(urls.at(-1)!).origin}/dashboard` }, attached.sessionId);
      type Grid = { cols: number; rows: number; control: string };
      type WindowState = { share: string; panes: { id: string; size: string }[];
        resizes: { url: string; cols: number; rows: number; take: boolean }[];
        streams: { url: string; readyState: number; geometry: Grid[] }[] };
      const read = async (run: (expression: string) => Promise<unknown>): Promise<WindowState> =>
        await run(`(() => {
          const state = ${dashboardTimeoutProbe};
          return { ...state, resizes: state.streams.flatMap(entry =>
            entry.resizes.map(frame => ({ url: entry.url, ...frame }))) };
        })()`) as WindowState;
      const waitFor = async (step: string, run: () => Promise<unknown>, ready: (value: unknown) => boolean) => {
        let last: unknown;
        await eventually(async () => {
          last = await run();
          return ready(last);
        }, 20_000, 100, step, () => last);
      };
      await waitFor('initial primary share', () => read(evaluate),
        value => (value as { share?: string })?.share === '4 of 6 here, 2 windows');
      await waitFor('initial second share',
        () => evaluateSecond("document.getElementById('share-count')?.textContent"),
        value => value === '2 of 6 here, 2 windows');
      const fitted = (state: WindowState): boolean => state.panes.length > 0 && state.panes.every(pane => {
        const geometry = state.streams.filter(entry => entry.readyState === 1 &&
          entry.url.includes(`/sessions/${pane.id}/stream`)).at(-1)?.geometry.at(-1);
        return geometry?.control === 'yours' && pane.size === `${geometry.cols}×${geometry.rows}`;
      });
      const waitForQuietFit = async (step: string, run: (expression: string) => Promise<unknown>) => {
        let last: WindowState | undefined;
        let signature = '';
        let quietSince = Date.now();
        await eventually(async () => {
          last = await read(run);
          const current = JSON.stringify({ share: last.share, panes: last.panes.map(pane => [pane.id, pane.size]),
            geometry: last.streams.map(entry => [entry.url, entry.readyState, entry.geometry.at(-1)]) });
          if (current !== signature) { signature = current; quietSince = Date.now(); }
          // Assignment settling is bounded at 900 ms; this quiet period means
          // no earlier fit can arrive after the test clears the traffic log.
          return fitted(last) && Date.now() - quietSince >= 1100;
        }, 20_000, 100, step, () => last);
      };
      // Chromium pauses animation frames in the background document. Give each
      // window foreground time to finish its own fit before checking both.
      await send('Page.bringToFront');
      await waitForQuietFit('settled initial primary fit', evaluate);
      await send('Page.bringToFront', {}, attached.sessionId);
      await waitForQuietFit('settled initial second fit', evaluateSecond);
      const assignment = await evaluate(`(() => {
        __restoreAssignmentCapture();
        return window.__publishedAssignment;
      })()`) as { owner: string; byWindow: Record<string, string[]> };
      expect(assignment?.owner).toBeTruthy();
      const secondId = Object.keys(assignment.byWindow).find(id => id !== assignment.owner);
      expect(secondId).toBeTruthy();
      const clearResizes = 'window.__dashboardDiagnostics.streams.forEach(entry => { entry.resizes.length = 0; })';
      await evaluate(clearResizes);
      await evaluateSecond(clearResizes);
      await evaluate(`(() => {
        const layout = ShellPuppetDashboardLayout;
        const assign = layout.assign;
        // Keep the old window's controller alive while the transferred pane
        // connects, so its first geometry explicitly reports that owner.
        const close = WebSocket.prototype.close;
        WebSocket.prototype.close = function(...args) {
          if (this.url.includes('/sessions/${ids[3]}/stream') && !this.__delayedClose) {
            this.__delayedClose = true;
            setTimeout(() => close.apply(this, args), 2500);
            return;
          }
          return close.apply(this, args);
        };
        const first = { '${assignment.owner}': ${JSON.stringify(ids.slice(0, 5))},
          '${secondId}': ${JSON.stringify(ids.slice(5))} };
        const final = { '${assignment.owner}': ${JSON.stringify([...ids.slice(0, 3), ids[4]])},
          '${secondId}': ${JSON.stringify([ids[3], ids[5]])} };
        layout.assign = (...args) => window.__stagedAssignment || assign(...args);
        window.__stagedAssignment = first;
        const channel = new BroadcastChannel('shellpuppet.dashboard');
        channel.postMessage({ type: 'window-assignment', token: 'test-two-step',
          owner: '${assignment.owner}', byWindow: first });
        setTimeout(() => {
          window.__stagedAssignment = final;
          channel.postMessage({ type: 'window-assignment', token: 'test-two-step',
            owner: '${assignment.owner}', byWindow: final });
          channel.close();
        }, 350);
      })()`);
      await send('Page.bringToFront');
      await waitFor('final primary assignment', () => read(evaluate),
        value => {
          const state = value as { share?: string; panes?: { id: string }[] };
          return state?.share === '4 of 6 here, 2 windows' &&
            JSON.stringify(state.panes?.map(pane => pane.id)) === JSON.stringify([...ids.slice(0, 3), ids[4]]);
        });
      await waitForQuietFit('settled final primary fit', evaluate);
      await send('Page.bringToFront', {}, attached.sessionId);
      // Assignment is synchronous, but a take needs a daemon round trip. A
      // fitted second window says nothing about the primary window's reply.
      await waitFor('both final assignments and acknowledged fits',
        async () => [await read(evaluate), await read(evaluateSecond)], value => {
        const [first, second] = value as [WindowState, WindowState];
        return first.share === '4 of 6 here, 2 windows' && second.share === '2 of 6 here, 2 windows' &&
          JSON.stringify(first.panes.map(pane => pane.id)) === JSON.stringify([...ids.slice(0, 3), ids[4]]) &&
          JSON.stringify(second.panes.map(pane => pane.id)) === JSON.stringify([ids[3], ids[5]]) &&
          [first, second].every(state => fitted(state) && state.resizes.filter(frame => frame.take).every(frame =>
            state.panes.find(pane => frame.url.includes(`/sessions/${pane.id}/stream`))?.size === `${frame.cols}×${frame.rows}`)) &&
          second.panes.every(pane => pane.size === second.panes[0]!.size) &&
          second.resizes.some(frame => frame.url.includes(`/sessions/${ids[3]}/stream`) && frame.take);
      });
      return { first: await read(evaluate), second: await read(evaluateSecond) };
    },
  });
  const result = shot.probe as { first: { panes: { id: string; size: string }[];
    resizes: { url: string; cols: number; rows: number; take: boolean }[] };
    second: { panes: { id: string; size: string }[];
      resizes: { url: string; cols: number; rows: number; take: boolean }[] } };
  expect(result.first.panes.map(pane => pane.id)).toEqual([...ids.slice(0, 3), ids[4]]);
  expect(result.second.panes.map(pane => pane.id)).toEqual([ids[3], ids[5]]);
  for (const state of [result.first, result.second]) {
    for (const frame of state.resizes.filter(frame => frame.take)) {
      const id = ids.find(id => frame.url.includes(`/sessions/${id}/stream`));
      expect(state.panes.find(pane => pane.id === id)?.size, JSON.stringify(result)).toBe(`${frame.cols}×${frame.rows}`);
    }
  }
  for (const id of [...ids.slice(0, 3), ids[4]])
    expect(result.first.resizes.filter(frame => frame.take && frame.url.includes(`/sessions/${id}/stream`)).length,
      JSON.stringify(result)).toBeLessThanOrEqual(1);
  for (const id of [ids[3]!, ids[5]!])
    expect(result.second.resizes.filter(frame => frame.take && frame.url.includes(`/sessions/${id}/stream`)).length,
      JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.second.resizes.filter(frame => frame.take && frame.url.includes(`/sessions/${ids[3]}/stream`)),
    JSON.stringify(result)).toHaveLength(1);
  expect(result.first.resizes.filter(frame => frame.take && frame.url.includes(`/sessions/${ids[3]}/stream`)),
    JSON.stringify(result)).toHaveLength(0);
}, 180_000);
