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

async function ensureSessions(): Promise<void> {
  if (sessions.length > 0) return;
  for (let index = 0; index < 3; index++) {
    const response = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
      openViewer: false, label: `screen-${index}` } });
    expect(response.status).toBe(200);
    sessions.push(String(response.body['id']));
  }
}

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

async function rosterProbe(script: string, beforeNavigate = ''): Promise<Record<string, unknown>> {
  const shot = await captureDashboard({ browser: browser!, viewerUrl: await freshUrl(), width: 1280,
    height: 720, drive: true, timeoutMs: 30_000,
    beforeNavigateScript: `(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"window-register"')) window.__rosterFeed = this;
        return send.call(this, data);
      };
      ${beforeNavigate}
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' && window.__rosterFeed ? true : null)()`,
    interact: async ({ evaluate }) => evaluate(script),
  });
  return shot.probe as Record<string, unknown>;
}

async function rosterSteps(steps: string): Promise<Record<string, unknown>> {
  return rosterProbe(`(async () => {
    const share = () => document.getElementById('share-count')?.textContent || '';
    const waitFor = async (step, ready) => {
      let last;
      const started = performance.now();
      while (performance.now() - started < 5000) {
        last = share();
        if (ready(last)) return last;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for ' + step + '; last observed: ' + JSON.stringify(last));
    };
    const channel = new BroadcastChannel('shellpuppet.dashboard');
    const roster = (id, instance) => ({ type: 'window-roster', token: 'test-roster',
      window: { id, instance, document: 'test-roster', rank: 1000, openedAt: Date.now(), key: null, width: 1280, height: 720 } });
    const notice = (id, instance) => window.__rosterFeed.onmessage({
      data: JSON.stringify({ type: 'window-gone', id, instance }) });
    const barrier = () => new Promise(resolve => {
      const marker = 'test-barrier-' + Math.random();
      const observer = new BroadcastChannel('shellpuppet.dashboard');
      observer.onmessage = event => {
        if (event.data?.type !== marker) return;
        observer.close(); resolve();
      };
      channel.postMessage({ type: marker, token: 'test-roster' });
    });
    try { ${steps} } catch (error) { return { error: String(error) }; }
    finally { channel.close(); }
  })()`);
}

async function multiWindowProbe(url: string, lostSocket?: 'primary' | 'other', dragCheck = false, held = false,
  sameScreen = false, reconnect = false, missedNotice = false, watchedChild?: { duplicateLeaves: boolean }): Promise<{
  before: { primary: string[]; other: string[]; childConnected: string };
  after: string[];
  paused: { primary: string[]; other: string[]; toolbar: string[] };
  closeMs: number;
  failureMs?: number;
  survivor?: string[];
  departure?: { victimClosed: boolean; noticeReceived: boolean; share: string };
  recovered?: { primary: string[]; other: string[]; oldInstance: string; newInstance: string;
    peers: string[]; afterLate: { primary: string[]; other: string[]; peers: string[] } };
  missed?: { before: string; after: string; oldInstance: string; newInstance: string };
  oversized: { note: string; horizontal: number; vertical: number; left: number; top: number };
  movedFit: { before: string; after: string; resizes: { cols: number; rows: number; take: boolean }[];
    donorStreams: string[] };
  dragIsolation?: { firstBefore: number; firstAfter: number; secondBefore: number; secondAfter: number;
    firstStored: string | null; secondStored: string | null };
  watched?: { before: { primary: string[]; child: string[]; duplicate: string[] };
    left?: { primary: string[]; child: string[] }; returned?: { primary: string[]; child: string[]; duplicate: string[] };
    after: { primary: string[]; duplicate: string[] }; observed: string[] };
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
    const makePage = async (pageUrl: string, width = 1280, beforeNavigate = ''): Promise<{ targetId: string; sessionId: string }> => {
      const target = await send('Target.createTarget', { url: 'about:blank' });
      const targetId = String(target.targetId);
      const attached = await send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = String(attached.sessionId);
      await send('Page.enable', {}, sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: dashboardDiagnosticsScript }, sessionId);
      if (beforeNavigate) await send('Page.addScriptToEvaluateOnNewDocument', { source: beforeNavigate }, sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        window.__resizeFrames = [];
        const nativeSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
          if (typeof data === 'string' && data.includes('"type":"resize"'))
            window.__resizeFrames.push({ url: this.url, ...JSON.parse(data) });
          return nativeSend.call(this, data);
        };
      })()` }, sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const nativeInterval = window.setInterval.bind(window);
        window.setInterval = (callback, delay, ...args) => nativeInterval(() => {
          if (delay !== 1000 || !window.__pauseRoster) callback(...args);
        }, delay);
        const NativeChannel = window.BroadcastChannel;
        window.BroadcastChannel = class extends NativeChannel {
          postMessage(data) {
            if (data.type === 'window-roster') window.__lastRoster = data;
            return super.postMessage(data);
          }
        };
        const witness = new NativeChannel('shellpuppet.dashboard');
        witness.onmessage = event => {
          if (event.data?.type === 'test-roster-barrier') window.__staleBarrier = true;
        };
      })()` }, sessionId);
      const rate = Number(process.env['SP_DASHBOARD_CPU_RATE'] || '1');
      if (rate > 1) await send('Emulation.setCPUThrottlingRate', { rate }, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width, height: 720,
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
    const waitFor = async (condition: () => Promise<boolean>, step = 'dashboard windows'): Promise<void> => {
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
      throw new Error(`The ${step} did not settle after ${String(Date.now() - started)} ms; diagnostics: ${JSON.stringify(details)}`);
    };
    const sharedPage = new URL(url);
    sharedPage.hash = 'screen=shared-screen&rank=1000';
    const sharedUrl = sharedPage.toString();
    const primary = await makePage(sameScreen ? sharedUrl : url, 1280,
      watchedChild ? "Object.defineProperty(window, 'getScreenDetails', { configurable: true, value: undefined });" : '');
    pages.push(primary.sessionId);
    await waitFor(async () => (await ids(primary.sessionId) as string[] | undefined)?.length === 3);
    if (watchedChild) {
      await waitFor(async () => await evaluate(primary.sessionId,
        "document.querySelector('#screens button')?.textContent === 'Open another window'") === true);
      const button = await evaluate(primary.sessionId,
        "document.querySelector('#screens button').getBoundingClientRect().toJSON()") as { x: number; y: number; width: number; height: number };
      const x = button.x + button.width / 2;
      const y = button.y + button.height / 2;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, primary.sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, primary.sessionId);
      let childTarget: { targetId: string; url: string } | undefined;
      await waitFor(async () => {
        const targets = await send('Target.getTargets') as { targetInfos?: { targetId: string; url: string }[] };
        childTarget = targets.targetInfos?.find((target) => target.url.includes('/dashboard#screen='));
        return childTarget !== undefined;
      });
      const childAttached = await send('Target.attachToTarget', { targetId: childTarget!.targetId, flatten: true });
      const childPage = { targetId: childTarget!.targetId, sessionId: String(childAttached.sessionId) };
      pages.push(childPage.sessionId);
      await send('Page.enable', {}, childPage.sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720,
        deviceScaleFactor: 1, mobile: false }, childPage.sessionId);
      const duplicateUrl = childTarget!.url;
      let duplicate = await makePage(duplicateUrl, 1600);
      pages.push(duplicate.sessionId);
      const ownership = async () => ({ primary: await ids(primary.sessionId) as string[],
        child: await ids(childPage.sessionId) as string[], duplicate: await ids(duplicate.sessionId) as string[] });
      await waitFor(async () => {
        const state = await ownership();
        return JSON.stringify(state) === JSON.stringify({
          primary: sessions.slice(0, 1), child: sessions.slice(1, 2), duplicate: sessions.slice(2),
        });
      }).catch(async (error: unknown) => {
        throw new Error(`Initial session ownership did not settle: ${JSON.stringify(await ownership())}`, { cause: error });
      });
      const initial = await ownership();
      let left: { primary: string[]; child: string[] } | undefined;
      let returned: typeof initial | undefined;
      if (watchedChild.duplicateLeaves) {
        await send('Target.closeTarget', { targetId: duplicate.targetId });
        pages.splice(pages.indexOf(duplicate.sessionId), 1);
        await waitFor(async () => JSON.stringify({ primary: await ids(primary.sessionId), child: await ids(childPage.sessionId) }) ===
          JSON.stringify({ primary: sessions.slice(0, 2), child: sessions.slice(2) }));
        left = { primary: await ids(primary.sessionId) as string[], child: await ids(childPage.sessionId) as string[] };
        duplicate = await makePage(duplicateUrl, 1600);
        pages.push(duplicate.sessionId);
        await waitFor(async () => JSON.stringify(await ownership()) === JSON.stringify(initial));
        returned = await ownership();
      }
      await evaluate(primary.sessionId, `(() => {
        window.__observedShares = [document.getElementById('share-count')?.textContent || ''];
        new MutationObserver(() => window.__observedShares.push(document.getElementById('share-count')?.textContent || ''))
          .observe(document.getElementById('share-count'), { childList: true, characterData: true, subtree: true });
      })()`);
      await send('Target.closeTarget', { targetId: childPage.targetId });
      pages.splice(pages.indexOf(childPage.sessionId), 1);
      await waitFor(async () => JSON.stringify({ primary: await ids(primary.sessionId), duplicate: await ids(duplicate.sessionId) }) ===
        JSON.stringify({ primary: sessions.slice(0, 1), duplicate: sessions.slice(1) }));
      const afterChild = { primary: await ids(primary.sessionId) as string[],
        duplicate: await ids(duplicate.sessionId) as string[] };
      const observed = await evaluate(primary.sessionId, 'window.__observedShares') as string[];
      return { before: { primary: [], other: [], childConnected: '' }, after: [],
        paused: { primary: [], other: [], toolbar: [] }, closeMs: 0,
        oversized: { note: '', horizontal: 0, vertical: 0, left: 0, top: 0 },
        movedFit: { before: '', after: '', resizes: [], donorStreams: [] },
        watched: { before: initial, ...(left ? { left } : {}), ...(returned ? { returned } : {}),
          after: afterChild, observed } };
    }
    await waitFor(async () => String(await evaluate(primary.sessionId,
      "document.querySelector('.pane[data-session=s3] .pane-size')?.textContent")).includes('×'));
    const initialSize = String(await evaluate(primary.sessionId,
      "document.querySelector('.pane[data-session=s3] .pane-size')?.textContent"));
    const second = await makePage(sameScreen ? `${new URL(url).origin}/dashboard#screen=shared-screen&rank=1000`
      : `${new URL(url).origin}/dashboard`, 1600);
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
    await waitFor(async () => String(await evaluate(second.sessionId,
      "document.querySelector('.pane[data-session=s3] .pane-size')?.textContent")).includes('×'));
    if (held) {
      await waitFor(async () => await evaluate(second.sessionId,
        "document.querySelector('.pane[data-session=s3] .pane-overflow-note')?.hidden === false") === true);
    } else {
      await waitFor(async () => {
        const size = String(await evaluate(second.sessionId,
          "document.querySelector('.pane[data-session=s3] .pane-size')?.textContent"));
        const frames = await evaluate(second.sessionId,
          "window.__resizeFrames.filter(frame => frame.url.includes('/sessions/s3/stream'))") as
            { take: boolean }[] | undefined;
        return size !== initialSize && !size.includes('following') && frames?.some((frame) => frame.take) === true;
      });
    }
    const movedFit = { before: initialSize,
      after: String(await evaluate(second.sessionId,
        "document.querySelector('.pane[data-session=s3] .pane-size')?.textContent")),
      resizes: await evaluate(second.sessionId,
        "window.__resizeFrames.filter(frame => frame.url.includes('/sessions/s3/stream'))") as
          { cols: number; rows: number; take: boolean }[],
      donorStreams: await evaluate(primary.sessionId,
        "window.__dashboardDiagnostics.streams.filter(entry => entry.socket.readyState === 1 && entry.url.includes('/sessions/s3/stream')).map(entry => entry.url)") as string[] };
    let dragIsolation;
    if (dragCheck) {
      await evaluate(second.sessionId, "document.getElementById('focus').click()");
      await new Promise((resolve) => setTimeout(resolve, 350));
      const firstBefore = Number(await evaluate(primary.sessionId,
        "document.querySelector('.pane').getBoundingClientRect().width"));
      const secondBefore = Number(await evaluate(second.sessionId,
        "document.getElementById('strip').getBoundingClientRect().width"));
      const box = await evaluate(second.sessionId,
        "document.querySelector('.pane-divider[data-axis=focus]').getBoundingClientRect().toJSON()") as
        { x: number; y: number; width: number; height: number };
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, second.sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 150, y, button: 'left', buttons: 1 }, second.sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 150, y, button: 'left', clickCount: 1 }, second.sessionId);
      dragIsolation = {
        firstBefore,
        firstAfter: Number(await evaluate(primary.sessionId, "document.querySelector('.pane').getBoundingClientRect().width")),
        secondBefore,
        secondAfter: Number(await evaluate(second.sessionId, "document.getElementById('strip').getBoundingClientRect().width")),
        firstStored: await evaluate(primary.sessionId, "sessionStorage.getItem('shellpuppet.dashboard.tracks')") as string | null,
        secondStored: await evaluate(second.sessionId, "sessionStorage.getItem('shellpuppet.dashboard.tracks')") as string | null,
      };
    }
    const oversized = await evaluate(second.sessionId, `(() => {
      const card = document.querySelector('.pane[data-session=s3]');
      const wrap = card.querySelector('.pane-wrap');
      return { note: card.querySelector('.pane-overflow-note').hidden ? '' : card.querySelector('.pane-overflow-note').textContent,
        horizontal: wrap.scrollWidth - wrap.clientWidth, vertical: wrap.scrollHeight - wrap.clientHeight,
        left: wrap.scrollLeft, top: wrap.scrollTop };
    })()`) as { note: string; horizontal: number; vertical: number; left: number; top: number };
    const extra = reconnect ? await makePage(`${new URL(url).origin}/dashboard`, 1920) : null;
    if (extra) {
      pages.push(extra.sessionId);
      await waitFor(async () => (await Promise.all(pages.map((page) => evaluate(page,
        "document.getElementById('share-count')?.textContent")))).every((count) =>
        String(count).includes('3 windows')));
    }
    if (missedNotice && extra) {
      const beforeMissed = String(await evaluate(extra.sessionId,
        "document.getElementById('share-count')?.textContent"));
      await evaluate(extra.sessionId, `(() => { const socket = window.__dashboardDiagnostics.streams.find(
        entry => entry.url.endsWith('/dashboard/events'))?.socket;
        if (!socket) throw new Error('No observing dashboard socket');
        socket.onclose = null; socket.close(); })()`);
      await waitFor(async () => String(await evaluate(primary.sessionId,
        "document.getElementById('share-count')?.textContent")).includes('2 windows'));
      const oldInstance = ((await evaluate(second.sessionId, 'window.__lastRoster')) as
        { window: { instance: string } }).window.instance;
      await evaluate(second.sessionId, `(() => { const socket = window.__dashboardDiagnostics.streams.find(
        entry => entry.url.endsWith('/dashboard/events'))?.socket;
        if (!socket) throw new Error('No reconnecting dashboard socket');
        socket.close(); })()`);
      await waitFor(async () => {
        const latest = await evaluate(second.sessionId, 'window.__lastRoster') as { window?: { instance?: string } };
        return latest?.window?.instance !== oldInstance;
      });
      const newInstance = ((await evaluate(second.sessionId, 'window.__lastRoster')) as
        { window: { instance: string } }).window.instance;
      await evaluate(second.sessionId, `(() => { const channel = new BroadcastChannel('shellpuppet.dashboard');
        channel.postMessage({ type: 'test-roster-barrier' }); channel.close(); })()`);
      await waitFor(async () => await evaluate(extra.sessionId, 'window.__staleBarrier') === true);
      return { before, movedFit, oversized, after: [], paused: { primary: [], other: [], toolbar: [] }, closeMs: 0,
        missed: { before: beforeMissed, after: String(await evaluate(extra.sessionId,
          "document.getElementById('share-count')?.textContent")), oldInstance, newInstance } };
    }
    if (lostSocket) {
      const victim = lostSocket === 'primary' ? primary : second;
      const survivor = lostSocket === 'primary' ? second : primary;
      const stale = await evaluate(victim.sessionId, 'window.__lastRoster') as { window: { id: string; instance: string } };
      await evaluate(victim.sessionId, `(() => {
        window.__pauseRoster = true;
        const socket = window.__dashboardDiagnostics.streams.find(entry => entry.url.endsWith('/dashboard/events'))?.socket;
        if (!socket) throw new Error('No dashboard socket');
        if (!${reconnect}) socket.onclose = null;
        socket.close();
      })()`);
      const failedAt = Date.now();
      let departure: { victimClosed: boolean; noticeReceived: boolean; share: string } | undefined;
      if (reconnect) await waitFor(async () => String(await evaluate(survivor.sessionId,
        "document.getElementById('share-count')?.textContent")).includes('2 windows'));
      else await waitFor(async () => {
        const victimClosed = await evaluate(victim.sessionId,
          "window.__dashboardDiagnostics.streams.find(entry => entry.url.endsWith('/dashboard/events'))?.socket.readyState === 3") === true;
        const observed = await evaluate(survivor.sessionId, `(() => ({
          noticeReceived: window.__dashboardDiagnostics.streams.some(entry => entry.gone.some(frame =>
            frame.id === ${JSON.stringify(stale.window.id)} && frame.instance === ${JSON.stringify(stale.window.instance)})),
          share: document.getElementById('share-count')?.textContent,
        }))()`) as { noticeReceived: boolean; share: string };
        departure = { victimClosed, ...observed };
        // Assert the close notice caused the return, rather than timing a
        // browser/daemon/DevTools round trip on a loaded runner.
        return victimClosed && observed.noticeReceived && observed.share === '3 of 3 here, 1 window' &&
          JSON.stringify(await ids(survivor.sessionId)) === JSON.stringify(sessions);
      }, 'socket departure notice and returned panes');
      const failureMs = Date.now() - failedAt;
      if (reconnect) {
        const oldInstance = (stale as { window: { instance: string } }).window.instance;
        await waitFor(async () => {
          const latest = await evaluate(victim.sessionId, 'window.__lastRoster') as { window?: { instance?: string } };
          const a = await ids(primary.sessionId) as string[] | undefined;
          const b = await ids(second.sessionId) as string[] | undefined;
          const peers = await Promise.all([primary.sessionId, extra!.sessionId].map((page) => evaluate(page,
            "document.getElementById('share-count')?.textContent")));
          return latest?.window?.instance !== oldInstance && a?.length === 1 && b?.length === 2 &&
            peers.every((count) => String(count).includes('3 windows'));
        });
        const newInstance = ((await evaluate(victim.sessionId, 'window.__lastRoster')) as
          { window: { instance: string } }).window.instance;
        const recovered = { primary: await ids(primary.sessionId) as string[],
          other: await ids(second.sessionId) as string[], oldInstance, newInstance,
          peers: await Promise.all([primary.sessionId, extra!.sessionId].map((page) => evaluate(page,
            "document.getElementById('share-count')?.textContent"))) as string[],
          afterLate: { primary: [] as string[], other: [] as string[], peers: [] as string[] } };
        await evaluate(victim.sessionId, `(() => { const channel = new BroadcastChannel('shellpuppet.dashboard');
          channel.postMessage(${JSON.stringify(stale)});
          channel.postMessage({ type: 'test-roster-barrier' }); channel.close(); })()`);
        await waitFor(async () => await evaluate(survivor.sessionId, 'window.__staleBarrier') === true);
        recovered.afterLate = { primary: await ids(primary.sessionId) as string[],
          other: await ids(second.sessionId) as string[],
          peers: await Promise.all([primary.sessionId, extra!.sessionId].map((page) => evaluate(page,
            "document.getElementById('share-count')?.textContent"))) as string[] };
        return { before, movedFit, oversized, after: [], paused: { primary: [], other: [], toolbar: [] },
          closeMs: 0, failureMs, recovered };
      }
      await evaluate(victim.sessionId, `(() => { const channel = new BroadcastChannel('shellpuppet.dashboard');
        channel.postMessage(${JSON.stringify(stale)});
        channel.postMessage({ type: 'test-roster-barrier' }); channel.close(); })()`);
      await waitFor(async () => await evaluate(survivor.sessionId, 'window.__staleBarrier') === true);
      return { before, movedFit, oversized, after: [], paused: { primary: [], other: [], toolbar: [] }, closeMs: 0,
        failureMs, departure, survivor: await ids(survivor.sessionId) as string[] };
    }
    await evaluate(second.sessionId, 'window.__pauseRoster = true');
    await new Promise((resolve) => setTimeout(resolve, 5400));
    const paused = { primary: await ids(primary.sessionId) as string[], other: await ids(second.sessionId) as string[],
      toolbar: await Promise.all(pages.map((page) => evaluate(page,
        "document.getElementById('share-count')?.textContent"))) as string[] };
    await evaluate(second.sessionId, 'window.__pauseRoster = false');
    await waitFor(async () => (await ids(primary.sessionId) as string[] | undefined)?.length === 1);
    const closedAt = Date.now();
    await send('Target.closeTarget', { targetId: second.targetId });
    await waitFor(async () => (await ids(primary.sessionId) as string[] | undefined)?.length === 3);
    const closeMs = Date.now() - closedAt;
    return { before, after: await ids(primary.sessionId) as string[], paused, closeMs, movedFit, oversized,
      ...(dragIsolation ? { dragIsolation } : {}) };
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
  it('accepts a still-connected window when it advertises after roster silence', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await rosterSteps(`
      channel.postMessage(roster('silent-window', 'i-old'));
      const before = await waitFor('the second window roster', value => value.includes('2 windows'));
      const nativeNow = Date.now;
      Date.now = () => nativeNow() + 181000;
      let removed;
      try { removed = await waitFor('the 180 second roster timeout', value => value.includes('1 window')); }
      finally { Date.now = nativeNow; }
      channel.postMessage(roster('silent-window', 'i-old'));
      const returned = await waitFor('the returning window roster', value => value.includes('2 windows'));
      return { before, removed, returned };
    `);
    expect(result.error).toBeUndefined();
    expect(result.before, JSON.stringify(result)).toContain('2 windows');
    expect(result.removed).toContain('1 window');
    expect(result.returned).toContain('2 windows');
  }, 60_000);

  it('keeps a closed instance out when another socket claims its window id, then accepts a reload', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await rosterSteps(`
      channel.postMessage(roster('closed-window', 'i-old'));
      await waitFor('the original window roster', value => value.includes('2 windows'));
      notice('closed-window', 'i-old');
      await waitFor('the closed window removal', value => value.includes('1 window'));
      window.__rosterFeed.onmessage({ data: JSON.stringify({ type: 'window-live', id: 'closed-window' }) });
      channel.postMessage(roster('closed-window', 'i-old'));
      await barrier();
      const afterLate = share();
      channel.postMessage(roster('closed-window', 'i-new'));
      const afterReload = await waitFor('the new document instance', value => value.includes('2 windows'));
      return { afterLate, afterReload };
    `);
    expect(result.error).toBeUndefined();
    expect(result.afterLate).toContain('1 window');
    expect(result.afterReload).toContain('2 windows');
  }, 60_000);

  it('retains only the 64 most recent closed window instances', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await rosterSteps(`
      for (let index = 1; index <= 100; index++) notice('closed-' + index, 'i-instance');
      channel.postMessage(roster('closed-37', 'i-instance'));
      await barrier();
      const retained = share();
      channel.postMessage(roster('closed-36', 'i-instance'));
      const evicted = await waitFor('the oldest evicted tombstone roster', value => value.includes('2 windows'));
      return { retained, evicted };
    `);
    expect(result.error).toBeUndefined();
    expect(result.retained, JSON.stringify(result)).toContain('1 window');
    expect(result.evicted).toContain('2 windows');
  }, 60_000);

  it('forgets closed window instances after ten minutes', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await rosterSteps(`
      notice('expired-window', 'i-instance');
      const nativeNow = Date.now;
      Date.now = () => nativeNow() + 601000;
      try {
        channel.postMessage(roster('expired-window', 'i-instance'));
        const returned = await waitFor('the expired tombstone roster', value => value.includes('2 windows'));
        return { returned };
      } finally { Date.now = nativeNow; }
    `);
    expect(result.error).toBeUndefined();
    expect(result.returned, JSON.stringify(result)).toContain('2 windows');
  }, 60_000);

  it('replaces a reconnecting document while the observing feed is closed', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await rosterSteps(`
      const feed = window.__rosterFeed;
      feed.onclose = null;
      feed.close();
      const first = roster('reconnecting-window', 'i-first');
      first.window.document = 'same-document';
      first.window.openedAt = 1000;
      channel.postMessage(first);
      const before = await waitFor('the original document', value => value.includes('2 windows'));
      const second = roster('reconnecting-window', 'i-second');
      second.window.document = 'same-document';
      second.window.openedAt = 1001;
      channel.postMessage(second);
      await barrier();
      return { before, after: share() };
    `);
    expect(result.error).toBeUndefined();
    expect(result.after, JSON.stringify(result)).toContain('2 windows');
  }, 60_000);

  for (const duplicateLeaves of [false, true]) it(`keeps a live duplicate when its watched child closes, duplicate leaves first ${String(duplicateLeaves)}`, async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    const result = (await multiWindowProbe(await freshUrl(), undefined, false, false, false, false, false,
      { duplicateLeaves })).watched!;
    expect(result.before).toEqual({ primary: sessions.slice(0, 1), child: sessions.slice(1, 2),
      duplicate: sessions.slice(2) });
    if (duplicateLeaves) {
      expect(result.left).toEqual({ primary: sessions.slice(0, 2), child: sessions.slice(2) });
      expect(result.returned).toEqual(result.before);
    }
    expect(result.after).toEqual({ primary: sessions.slice(0, 1), duplicate: sessions.slice(1) });
    expect(result.observed.some((value) => value.includes('1 window')), JSON.stringify(result)).toBe(false);
  }, 180_000);

  it('bounds one document to one roster entry after 70 reconnects', async (context) => {
    if (!browser) { context.skip(); return; }
    const result = await rosterSteps(`
      for (let index = 0; index < 70; index++) {
        const message = roster('flapping-window', 'i-' + index.toString(36));
        message.window.document = 'same-document';
        message.window.openedAt = 1000 + index;
        channel.postMessage(message);
      }
      await barrier();
      return { after: share() };
    `);
    expect(result.error).toBeUndefined();
    expect(result.after, JSON.stringify(result)).toContain('2 windows');
  }, 60_000);

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

  it('updates screen registration after a separately opened window moves', async (context) => {
    if (!browser) { context.skip(); return; }
    const script = `(() => {
      const screens = ${JSON.stringify([screenA, screenB, screenC])};
      const details = new EventTarget();
      details.screens = screens; details.currentScreen = screens[0];
      window.__screenDetails = details;
      window.__rosters = [];
      const NativeChannel = window.BroadcastChannel;
      window.BroadcastChannel = class extends NativeChannel {
        postMessage(data) {
          if (data.type === 'window-roster') window.__rosters.push(data.window);
          return super.postMessage(data);
        }
      };
      Object.defineProperty(navigator, 'permissions', { configurable: true,
        value: { query: async () => ({ state: 'granted' }) } });
      window.getScreenDetails = async () => details;
    })()`;
    const result = await browserProbe(script, `(() => {
      const state = window.__moveProbe ||= { phase: 0, start: Date.now() };
      if (state.phase === 0 && document.querySelectorAll('#screens button').length === 2) {
        window.__screenDetails.currentScreen = window.__screenDetails.screens[1];
        window.__screenDetails.dispatchEvent(new Event('currentscreenchange'));
        state.phase = 1;
      }
      const key = window.__rosters.at(-1)?.key;
      if (state.phase === 1 && key === '1280,20,1900,1000')
        return JSON.stringify({ labels: [...document.querySelectorAll('#screens button')].map(button => button.textContent), key });
      if (Date.now() - state.start > 3000)
        return JSON.stringify({ timeout: true, labels: [...document.querySelectorAll('#screens button')].map(button => button.textContent), key });
      return null;
    })()`);
    expect(result).toEqual({ labels: ['Open on screen 1', 'Open on screen 3'], key: '1280,20,1900,1000' });
  }, 120_000);

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
            error: document.getElementById('error-message').textContent }; window.__block = false; state.phase = 1; return null; }
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
        error: document.getElementById('error-message').textContent }); })()`);
    const opens = result.opens as { url: string; features: string }[];
    expect(opens).toHaveLength(1);
    expect(opens[0]!.features).not.toMatch(/left=|top=|width=|height=/);
    expect(result.button).toBe(true);
    expect(result.error).toBe('The browser blocked the window. Press the button again.');
  }, 120_000);

  it('assigns sessions to channel-connected windows in creation order and returns them on close', async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    const result = await multiWindowProbe(await freshUrl());
    const before = result.before;
    expect(before.primary).toEqual([sessions[0]]);
    expect(before.other).toEqual(sessions.slice(1));
    expect(before.childConnected).toBe('Connected');
    expect(new Set([...before.primary, ...before.other])).toEqual(new Set(sessions));
    expect(result.paused.primary).toEqual([sessions[0]]);
    expect(result.paused.other).toEqual(sessions.slice(1));
    expect(result.paused.toolbar).toEqual(['1 of 3 here, 2 windows', '2 of 3 here, 2 windows']);
    expect(result.movedFit.after, JSON.stringify(result.movedFit)).not.toBe(result.movedFit.before);
    expect(result.movedFit.resizes.some((frame) => frame.take === true), JSON.stringify(result.movedFit)).toBe(true);
    expect(result.movedFit.donorStreams).toEqual([]);
    expect(result.closeMs).toBeLessThan(2000);
    expect(result.after).toEqual(sessions);
  }, 180_000);

  it('shares sessions between live documents with the same screen id and returns them on close', async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    const result = await multiWindowProbe(await freshUrl(), undefined, false, false, true);
    expect(result.before.primary).toHaveLength(1);
    expect(result.before.other).toHaveLength(2);
    expect(new Set([...result.before.primary, ...result.before.other])).toEqual(new Set(sessions));
    expect(result.after).toEqual(sessions);
  }, 180_000);

  it('restores a live document after its feed reconnects and rejects its old roster', async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    const result = await multiWindowProbe(await freshUrl(), 'other', false, false, false, true);
    expect(result.failureMs).toBeLessThan(2000);
    expect(result.recovered?.newInstance).not.toBe(result.recovered?.oldInstance);
    expect(result.recovered?.primary).toEqual([sessions[0]]);
    expect(result.recovered?.other).toEqual(sessions.slice(1));
    expect(result.recovered?.peers).toHaveLength(2);
    expect(result.recovered?.peers.every((count) => count.includes('3 windows'))).toBe(true);
    expect(result.recovered?.afterLate).toEqual({ primary: result.recovered?.primary,
      other: result.recovered?.other, peers: result.recovered?.peers });
  }, 180_000);

  it('keeps one entry for a reconnecting document when an observing feed misses the close notice', async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    const result = await multiWindowProbe(await freshUrl(), undefined, false, false, false, true, true);
    expect(result.missed?.before).toContain('3 windows');
    expect(result.missed?.newInstance).not.toBe(result.missed?.oldInstance);
    expect(result.missed?.after, JSON.stringify(result.missed)).toContain('3 windows');
  }, 180_000);

  it('keeps a drag in the window where it happened', async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    const result = await multiWindowProbe(await freshUrl(), undefined, true);
    const drag = result.dragIsolation!;
    expect(drag.secondAfter).toBeGreaterThan(drag.secondBefore + 100);
    expect(drag.firstAfter).toBeCloseTo(drag.firstBefore, 0);
    expect(drag.firstStored).toBeNull();
    expect(drag.secondStored).toContain('focusStrip');
  }, 180_000);

  for (const lost of ['primary', 'other'] as const) it(`returns sessions after the ${lost} dashboard socket closes without pagehide`, async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    const result = await multiWindowProbe(await freshUrl(), lost);
    expect(result.departure, JSON.stringify(result)).toEqual({
      victimClosed: true, noticeReceived: true, share: '3 of 3 here, 1 window',
    });
    expect(result.survivor, JSON.stringify(result)).toEqual(sessions);
  }, 180_000);

  it('starts a moved held oversized pane at the receiver origin with its overflow controls', async (context) => {
    if (!browser) { context.skip(); return; }
    await ensureSessions();
    expect((await api(daemon.port, daemon.token, `/sessions/${sessions[2]}/resize`,
      { body: { cols: 220, rows: 115, hold: true } })).status).toBe(200);
    const result = await multiWindowProbe(await freshUrl(), undefined, false, true);
    expect(result.oversized.note).toContain('Shift+wheel');
    expect(Math.max(result.oversized.horizontal, result.oversized.vertical)).toBeGreaterThan(0);
    expect([result.oversized.left, result.oversized.top]).toEqual([0, 0]);
  }, 180_000);
});
