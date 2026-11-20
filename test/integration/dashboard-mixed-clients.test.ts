import { afterEach, beforeAll, expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { captureDashboard, dashboardDiagnosticsScript } from './dashboardCapture.js';
import { api, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let running: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await running?.stop(); running = null; }, 120_000);

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
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const minted = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, { body: {} });
  expect(minted.status).toBe(200);
  const viewerUrl = `${String(minted.body['viewerUrl'])}&drive=0`;
  const viewerDrives: (string | null)[] = [];
  daemon.daemon['server'].on('upgrade', (req) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === `/sessions/${id}/stream` && !req.headers['sec-websocket-protocol'])
      viewerDrives.push(url.searchParams.get('drive'));
  });
  await captureDashboard({ browser, viewerUrl: urls[0]!, width: 1400, height: 900, drive: true, probeOnly: true,
    beforeNavigateScript: `localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ autoFit: false }))`,
    probe: `document.querySelector('.pane-size')?.textContent.includes('×')`, timeoutMs: 150_000,
    interact: async ({ evaluate, send }) => {
      // All three documents share one browser. The new dashboard inherits the cookie
      // and has its own empty assignment. Only the passive viewer also sees the grid.
      const openPage = async (url: string, width: number, height: number) => {
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, true) as { targetId: string };
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, true) as { sessionId: string };
        await send('Page.enable', {}, sessionId);
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        await send('Page.addScriptToEvaluateOnNewDocument', { source: dashboardDiagnosticsScript }, sessionId);
        await send('Page.navigate', { url }, sessionId);
        const evaluatePage = async (expression: string) => {
          const response = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId) as {
            result: { value?: unknown }; exceptionDetails?: unknown };
          if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
          return response.result.value;
        };
        return { evaluatePage, resize: (w: number, h: number) => send('Emulation.setDeviceMetricsOverride',
          { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId) };
      };
      const { evaluatePage: other } = await openPage(`http://127.0.0.1:${String(daemon.port)}/dashboard`, 1200, 800);
      await eventually(async () => await other(`document.getElementById('share-count')?.textContent.includes('0 of 1 here, 2 windows')`) === true);
      const { evaluatePage: viewer, resize } = await openPage(viewerUrl, 1400, 900);
      const stream = `window.__dashboardDiagnostics?.streams.find(s => s.url.includes('/stream'))`;
      const geometry = `${stream}?.geometry.at(-1)`;
      await eventually(async () => await viewer(`!!${stream}?.geometry.length`) === true);
      expect(viewerDrives, 'passive session-stream upgrade received by the daemon').toEqual(['0']);
      expect(await viewer(`${stream}.geometry[0]`)).toMatchObject({ control: 'adopt', owned: false });
      const display = `(() => {
        const box = document.getElementById('term').getBoundingClientRect();
        const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
        return { width: screen.width, height: screen.height, availableWidth: box.width, availableHeight: box.height };
      })()`;
      const initial = await viewer(display) as { width: number };
      await resize(600, 430);
      await eventually(async () => {
        const size = await viewer(display) as { width: number; height: number; availableWidth: number; availableHeight: number };
        return size.width > 0 && size.width < initial.width && size.width <= size.availableWidth &&
          size.height > 0 && size.height <= size.availableHeight;
      }, 5000, 50, 'passive terminal fits inside its resized viewer', () => viewer(display));
      expect(await viewer(`${stream}.resizes`)).toEqual([]);
      expect(await viewer(`${geometry}`)).toMatchObject({ cols: 100, rows: 30, control: 'adopt', owned: false });
      await evaluate(`document.querySelector('.pane button[aria-label="Fit"]').click()`);
      await eventually(async () => await evaluate(`${geometry}?.control === 'yours'`) === true);
      await evaluate(`document.getElementById('auto-fit').click()`);
      const frameCount = `${stream}?.resizes.length ?? 0`;
      const before = Number(await evaluate(frameCount));
      const oldCols = Number(await evaluate(`${geometry}.cols`));
      await evaluate(`document.getElementById('panes').style.width = '1100px'; window.dispatchEvent(new Event('resize'))`);
      await eventually(async () => await evaluate(`${geometry}.cols !== ${oldCols} && ${geometry}.control === 'yours'`) === true);
      const fittedCols = Number(await evaluate(`${geometry}.cols`));
      await eventually(async () => await viewer(`${geometry}?.cols === ${fittedCols}`) === true);
      const fittedFrames = Number(await evaluate(frameCount));
      expect(fittedFrames - before).toBeGreaterThanOrEqual(1);
      expect(fittedFrames - before).toBeLessThanOrEqual(2);

      for (const [cols, rows] of [[194, 100], [210, 110]]) {
        expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`, { body: { cols, rows } })).status).toBe(200);
        const received = `${geometry}?.cols === ${cols} && ${geometry}.rows === ${rows} && ${geometry}.control === 'adopt'`;
        await eventually(async () => await evaluate(received) === true && await viewer(received) === true);
        expect(await evaluate(frameCount)).toBe(fittedFrames);
        expect(await viewer(frameCount)).toBe(0);
        expect(await other(`window.__dashboardDiagnostics.streams.filter(s => s.url.includes('/stream')).length`)).toBe(0);
      }
      return true;
    },
  });
}, 240_000);
