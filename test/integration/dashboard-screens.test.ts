/** Screen assignment is a pure fill operation. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { captureBrowserArgs } from '../../src/daemon/screenshot.js';
import { captureDashboard, dashboardDiagnosticsScript, dashboardTimeoutProbe } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';
import { afterAll, beforeAll } from 'vitest';

let browser: string | null;
let daemon: TestDaemon;
const grants: string[] = [];
const sessions: string[] = [];

async function freshUrl(): Promise<string> {
  const response = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
  expect(response.status).toBe(200);
  return grants.at(-1)!;
}

async function browserProbe(beforeNavigateScript: string, probe: string): Promise<Record<string, unknown>> {
  const shot = await captureDashboard({ browser: browser!, viewerUrl: await freshUrl(), width: 1280,
    height: 720, drive: true, timeoutMs: 30_000, beforeNavigateScript, probe });
  return JSON.parse(String(shot.probe)) as Record<string, unknown>;
}

async function multiWindowProbe(url: string): Promise<{
  before: { primary: string[]; other: string[]; childConnected: string };
  three: { primary: string[]; second: string[]; third: string[] };
  after: string[];
}> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-screen-cdp-'));
  const child = spawn(browser!, captureBrowserArgs(profile, 1280, 720), { stdio: 'ignore', windowsHide: true });
  let socket: WebSocket | undefined;
  let serial = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  try {
    const activePort = path.join(profile, 'DevToolsActivePort');
    let endpoint = '';
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const [port, target] = fs.readFileSync(activePort, 'utf8').split(/\r?\n/);
        if (port && target) { endpoint = `ws://127.0.0.1:${port}${target}`; break; }
      } catch { /* Chromium may still be writing the endpoint file. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!endpoint) throw new Error('Test browser did not expose DevTools.');
    socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      ws.once('open', () => resolve(ws)); ws.once('error', reject);
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as {
        id?: number; result?: Record<string, unknown>; error?: unknown };
      if (message.id === undefined) return;
      pending.get(message.id)?.(message.error ? { error: message.error } : message.result || {});
      pending.delete(message.id);
    });
    const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> => {
      const id = ++serial;
      const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`DevTools did not answer ${method} after 30000 ms; page did not answer`));
        }, 30_000);
        pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
      });
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      const result = await answer;
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result;
    };
    const makePage = async (pageUrl: string): Promise<{ targetId: string; sessionId: string }> => {
      const target = await send('Target.createTarget', { url: 'about:blank' });
      const targetId = String(target.targetId);
      const attached = await send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = String(attached.sessionId);
      await send('Page.enable', {}, sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: dashboardDiagnosticsScript }, sessionId);
      const rate = Number(process.env['SP_DASHBOARD_CPU_RATE'] || '1');
      if (rate > 1) await send('Emulation.setCPUThrottlingRate', { rate }, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720,
        deviceScaleFactor: 1, mobile: false }, sessionId);
      await send('Page.navigate', { url: pageUrl }, sessionId);
      return { targetId, sessionId };
    };
    const evaluate = async (sessionId: string, expression: string): Promise<unknown> => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      return (response.result as { value?: unknown } | undefined)?.value;
    };
    const ids = (sessionId: string) => evaluate(sessionId,
      `[...document.querySelectorAll('#panes .pane')].map((pane) => pane.dataset.session)`);
    const pages: string[] = [];
    const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
      const started = Date.now();
      for (let attempt = 0; attempt < 160; attempt++) {
        try { if (await condition()) return; } catch (error) {
          if (String(error).includes('DevTools did not answer')) {
            throw new Error(`${String(error)} after ${String(Date.now() - started)} ms`, { cause: error });
          }
          // Navigation may replace the execution context.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const details = await Promise.all(pages.map(async (page) => {
        try { return await evaluate(page, dashboardTimeoutProbe); }
        catch { return 'page did not answer'; }
      }));
      throw new Error(`The dashboard windows did not settle after ${String(Date.now() - started)} ms; diagnostics: ${JSON.stringify(details)}`);
    };
    const primary = await makePage(url);
    pages.push(primary.sessionId);
    await waitFor(async () => (await ids(primary.sessionId) as string[] | undefined)?.length === 3);
    const second = await makePage(`${new URL(url).origin}/dashboard#screen=second&rank=1001`);
    pages.push(second.sessionId);
    await waitFor(async () => {
      const a = await ids(primary.sessionId) as string[] | undefined;
      const b = await ids(second.sessionId) as string[] | undefined;
      return a?.length === 1 && b?.length === 2;
    }).catch(async () => { throw new Error(JSON.stringify({
      primary: await ids(primary.sessionId), other: await ids(second.sessionId),
      connection: await evaluate(second.sessionId, "document.getElementById('connection')?.textContent"),
      error: await evaluate(second.sessionId, "document.getElementById('error')?.textContent"),
    })); });
    const before = { primary: await ids(primary.sessionId) as string[],
      other: await ids(second.sessionId) as string[],
      childConnected: String(await evaluate(second.sessionId, "document.getElementById('connection')?.textContent")) };
    const third = await makePage(`${new URL(url).origin}/dashboard#screen=third&rank=1002`);
    pages.push(third.sessionId);
    await waitFor(async () => {
      const a = await ids(primary.sessionId) as string[] | undefined;
      const b = await ids(second.sessionId) as string[] | undefined;
      const c = await ids(third.sessionId) as string[] | undefined;
      return a?.length === 1 && b?.length === 1 && c?.length === 1;
    });
    const three = { primary: await ids(primary.sessionId) as string[],
      second: await ids(second.sessionId) as string[], third: await ids(third.sessionId) as string[] };
    await send('Target.closeTarget', { targetId: third.targetId });
    await waitFor(async () => (await ids(second.sessionId) as string[] | undefined)?.length === 2);
    await send('Target.closeTarget', { targetId: second.targetId });
    await waitFor(async () => (await ids(primary.sessionId) as string[] | undefined)?.length === 3);
    return { before, three, after: await ids(primary.sessionId) as string[] };
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: ++serial, method: 'Browser.close', params: {} }));
      socket.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (child.exitCode === null && child.pid) child.kill();
  }
}

beforeAll(async () => {
  browser = await findBrowser();
  daemon = await startTestDaemon({ home: makeTempHome('dashboard-screens-'),
    launcher: (url) => { grants.push(url); return Promise.resolve({ launched: true,
      mode: 'isolated-app' as const, browser: 'mock' }); } });
}, 60_000);
afterAll(async () => { await daemon.stop(); }, 120_000);

describe('dashboard screen assignment', () => {
  it('fills the first readable screen before placing panes on the next', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src/viewer/dashboard-layout.js'), 'utf8');
    const context: { ShellPuppetDashboardLayout?: { assign: (ids: string[], windows: { id: string; width: number; height: number }[]) => Record<string, string[]> } } = {};
    vm.runInNewContext(source, context);
    const windows = [
      { id: 'primary', width: 1920, height: 1080 },
      { id: 'second', width: 1920, height: 1080 },
    ];
    const five = context.ShellPuppetDashboardLayout!.assign(['a', 'b', 'c', 'd', 'e'], windows);
    const six = context.ShellPuppetDashboardLayout!.assign(['a', 'b', 'c', 'd', 'e', 'f'], windows);
    expect(JSON.parse(JSON.stringify(five))).toEqual({ primary: ['a', 'b', 'c', 'd'], second: ['e'] });
    expect(JSON.parse(JSON.stringify(six))).toEqual({ primary: ['a', 'b', 'c', 'd'], second: ['e', 'f'] });
    expect(new Set(Object.values(six).flat()).size).toBe(6);
  });
});

describe('dashboard screen controls in Chromium', () => {
  const screenA = { availLeft: 0, availTop: 0, availWidth: 1280, availHeight: 720, isPrimary: true };
  const screenB = { availLeft: 1280, availTop: 20, availWidth: 1900, availHeight: 1000 };
  const screenC = { availLeft: -1600, availTop: 40, availWidth: 1600, availHeight: 900 };
  const screenScript = `(() => {
    window.__opens = []; window.__details = 0; window.__queries = []; window.__moves = [];
    const screens = ${JSON.stringify([screenA, screenB, screenC])};
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: {
      query: async (request) => { window.__queries.push(request.name); return { state: window.__state || 'granted' }; }
    }});
    window.getScreenDetails = async () => { window.__details++; return { screens, currentScreen: screens[0] }; };
    window.open = (url, name, features) => { window.__opens.push({ url: String(url), name, features });
      return window.__block ? null : { closed: false }; };
    window.moveTo = (...args) => window.__moves.push(args);
    window.resizeTo = (...args) => window.__moves.push(args);
  })()`;

  it('asks on one Allow screens click and opens no window when the grant resolves', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await browserProbe(screenScript.replace("window.__opens = [];", "window.__state = 'prompt'; window.__opens = [];"),
      `(() => { const state = window.__probe ||= { phase: 0, start: Date.now() };
        const buttons = [...document.querySelectorAll('#screens button')];
        if (state.phase === 0 && buttons[0]?.textContent === 'Allow screens') {
          let resolve; window.getScreenDetails = () => { window.__details++; return new Promise((done) => { resolve = done; }); };
          buttons[0].click(); state.resolve = resolve; state.clickOpens = window.__opens.length;
          state.phase = 1; setTimeout(() => state.resolve({ screens: ${JSON.stringify([screenA, screenB, screenC])},
            currentScreen: ${JSON.stringify(screenA)} }), 50); return null;
        }
        if (state.phase === 1 && buttons.length === 2) return JSON.stringify({ clickOpens: state.clickOpens,
          opens: window.__opens, details: window.__details, queries: window.__queries, labels: buttons.map((b) => b.textContent) });
        if (Date.now() - state.start > 8000) return JSON.stringify({ timeout: true, labels: buttons.map((b) => b.textContent) });
        return null; })()`);
    expect(result).toEqual({ clickOpens: 0, opens: [], details: 1,
      queries: ['window-management'], labels: ['Open on screen 2', 'Open on screen 3'] });
  }, 120_000);

  it('places one window per granted click and leaves a blocked button available', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await browserProbe(screenScript,
      `(() => { const state = window.__probe ||= { phase: 0, start: Date.now() };
        const buttons = [...document.querySelectorAll('#screens button')];
        if (buttons.length !== 2 && state.phase === 0) return null;
        if (state.phase === 0) { window.__block = true; buttons[0].click();
          state.blocked = { count: window.__opens.length, buttons: document.querySelectorAll('#screens button').length,
            error: document.getElementById('error').textContent }; window.__block = false; state.phase = 1; return null; }
        buttons[0].click(); state.first = window.__opens.length; state.phase = 2;
        document.querySelector('#screens button')?.click();
        return JSON.stringify({ blocked: state.blocked, first: state.first, opens: window.__opens,
          moves: window.__moves,
          remaining: document.querySelectorAll('#screens button').length, details: window.__details }); })()`);
    expect(result.blocked).toEqual({ count: 1, buttons: 2,
      error: 'The browser blocked the window. Press the button again.' });
    expect(result.first).toBe(2);
    const opens = result.opens as { url: string; features: string }[];
    expect(opens).toHaveLength(3);
    expect(opens[1]!.features).toContain('left=1280,top=20,width=1900,height=1000');
    expect(opens[2]!.features).toContain('left=-1600,top=40,width=1600,height=900');
    expect(opens[1]!.url).toContain('left=1280');
    expect(opens.every((entry) => !entry.url.includes('dt='))).toBe(true);
    expect(result.moves).toEqual([]);
    expect(result.remaining).toBe(0);
  }, 120_000);

  for (const kind of ['missing', 'denied'] as const) it(`opens one unplaced fallback window when permission is ${kind}`, async (context) => {
    if (!browser) { context.skip(); return; }
    const before = kind === 'missing' ? `(() => { window.__opens = [];
      Object.defineProperty(window, 'getScreenDetails', { configurable: true, value: undefined });
      window.open = (url, name, features) => { window.__opens.push({ url: String(url), features }); return null; }; })()`
      : screenScript.replace("window.__opens = [];", "window.__state = 'denied'; window.__opens = [];");
    const result = await browserProbe(before, `(() => { const button = document.querySelector('#screens button');
      if (!button || button.textContent !== 'Open another window') return null;
      ${kind === 'denied' ? 'window.__block = true;' : ''} button.click();
      return JSON.stringify({ opens: window.__opens, button: button.isConnected,
        error: document.getElementById('error').textContent }); })()`);
    const opens = result.opens as { url: string; features: string }[];
    expect(opens).toHaveLength(1);
    expect(opens[0]!.features).not.toMatch(/left=|top=|width=|height=/);
    expect(result.button).toBe(true);
    expect(result.error).toBe('The browser blocked the window. Press the button again.');
  }, 120_000);

  it('assigns sessions to channel-connected windows in creation order and returns them on close', async (context) => {
    if (!browser) { context.skip(); return; }
    for (let index = 0; index < 3; index++) {
      const response = await api(daemon.port, daemon.token, '/sessions', { body: {
        command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
        openViewer: false, label: `screen-${index}` } });
      expect(response.status).toBe(200);
      sessions.push(String(response.body['id']));
    }
    const result = await multiWindowProbe(await freshUrl());
    const before = result.before;
    expect(before.primary).toHaveLength(1);
    expect(before.other).toHaveLength(2);
    expect(before.childConnected).toBe('Connected');
    expect(new Set([...before.primary, ...before.other])).toEqual(new Set(sessions));
    expect(result.three).toEqual({ primary: [sessions[0]], second: [sessions[1]], third: [sessions[2]] });
    expect(result.after).toEqual(sessions);
  }, 180_000);
});
