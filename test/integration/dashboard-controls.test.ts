/**
 * Dashboard human controls (design §5.1, ADR-009).
 *
 * Typing stays in the focused pane until Ctrl+Shift+A. The follow-up keys,
 * bound or not, stay out of the session. Kill is one DELETE with the same
 * origin and document proof as launch. Copy writes the session id and makes
 * no request. Restart repeats a profile this page started. Layout memory
 * stays in the browser.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAuditor } from '../../src/daemon/audit.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import type { LauncherConfig } from '../../src/daemon/launchProfiles.js';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

interface RawResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface AuditLine {
  actor?: string;
  action?: string;
  session?: string;
  meta?: { reason?: string };
}

interface PageDaemon extends TestDaemon {
  urls: string[];
}

const running: PageDaemon[] = [];
const tempDirs: string[] = [];
let browser: string | null = null;

beforeAll(async () => {
  browser = await findBrowser();
}, 60_000);

afterEach(async () => {
  const pending = running.splice(0);
  for (const daemon of pending) await daemon.stop();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a folder a killed process ran in for a moment.
    }
  }
}, 120_000);

function raw(
  port: number,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        // Content-Length frames the body. Without it Node writes those bytes
        // after the headers, so the request arrives empty and a DELETE kills.
        headers: {
          host: `127.0.0.1:${String(port)}`,
          ...headers,
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function headerList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cookiePair(headers: http.IncomingHttpHeaders): string {
  const line = headerList(headers['set-cookie'])[0] ?? '';
  return line.split(';')[0] ?? '';
}

function csrfMeta(html: string): string {
  const match = /<meta name="sp-csrf" content="([^"]*)">/.exec(html);
  return match?.[1] ?? '';
}

function auditEntries(home: string): AuditLine[] {
  const file = path.join(home, 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditLine);
}

function profilesOf(entries: unknown[]): LauncherConfig {
  const { config, problems } = parseDaemonConfig({ launcher: { profiles: entries } });
  expect(problems).toEqual([]);
  if (config.launcher === undefined) throw new Error('launcher did not parse');
  return config.launcher;
}

async function sessionIds(daemon: TestDaemon): Promise<string[]> {
  const list = await api(daemon.port, daemon.token, '/sessions');
  expect(list.status).toBe(200);
  return ((list.body['sessions'] as { id: string }[] | undefined) ?? []).map((session) => session.id);
}

async function startPageDaemon(extra: { launcher?: LauncherConfig } = {}): Promise<PageDaemon> {
  const home = makeTempHome('dash-controls-');
  const urls: string[] = [];
  const daemon = await startTestDaemon({
    home,
    logger: createFileLogger(path.join(home, 'daemon.log')),
    audit: createAuditor(home),
    ...(extra.launcher !== undefined ? { launchProfiles: extra.launcher } : {}),
    exitedGraceMs: 600_000,
    idleCheckIntervalMs: 600_000,
    promptScanIntervalMs: 600_000,
    launcher: (url) => {
      urls.push(url);
      return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
    },
  });
  const wrapped = Object.assign(daemon, { urls });
  running.push(wrapped);
  return wrapped;
}

async function freshDashboardUrl(daemon: PageDaemon): Promise<string> {
  const before = daemon.urls.length;
  const opened = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
  expect(opened.status).toBe(200);
  expect(daemon.urls).toHaveLength(before + 1);
  return daemon.urls.at(-1) ?? '';
}

async function openDashboard(daemon: PageDaemon): Promise<{ cookie: string; proof: string; url: string }> {
  const before = daemon.urls.length;
  const opened = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
  expect(opened.status).toBe(200);
  expect(daemon.urls).toHaveLength(before + 1);
  const url = daemon.urls.at(-1) ?? '';
  const grant = new URL(url).searchParams.get('dt') ?? '';
  const page = await raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-site': 'none',
  });
  expect(page.status).toBe(200);
  const cookie = cookiePair(page.headers);
  const proof = csrfMeta(page.body);
  expect(cookie).toMatch(/^sp_dash=/);
  expect(proof).toMatch(/^[0-9a-f]{64}$/);
  return { cookie, proof, url };
}

function originHeaders(port: number, cookie: string, proof: string): Record<string, string> {
  return {
    cookie,
    'x-shellpuppet-csrf': proof,
    origin: `http://127.0.0.1:${String(port)}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}

function upgradeStatus(
  port: number,
  requestPath: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: {
        host: `127.0.0.1:${String(port)}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function startLive(daemon: TestDaemon, label: string, program = 'setInterval(() => {}, 1000)'): Promise<string> {
  const started = await api(daemon.port, daemon.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', program],
      shell: false,
      openViewer: false,
      label,
      cols: 100,
      rows: 30,
    },
  });
  expect(started.status).toBe(200);
  return String(started.body['id']);
}

const instrument = `(() => {
  window.__sent = [];
  window.__fetches = [];
  window.__timeouts = [];
  window.__copied = [];
  window.__confirms = [];
  window.__sockets = [];
  const Native = window.WebSocket;
  const send = Native.prototype.send;
  Native.prototype.send = function(data) {
    window.__sent.push(typeof data === 'string' ? data : '[binary]');
    return send.call(this, data);
  };
  window.WebSocket = new Proxy(Native, {
    construct(Target, args) {
      const socket = new Target(...args);
      window.__sockets.push({ socket: socket, url: String(args[0]) });
      return socket;
    }
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(url, init) {
    const method = (init && init.method) || 'GET';
    const body = init && typeof init.body === 'string' ? init.body : null;
    window.__fetches.push({ url: String(url), method: String(method).toUpperCase(), body: body });
    return nativeFetch(url, init);
  };
  const nativeTimeout = window.setTimeout.bind(window);
  window.setTimeout = function(fn, delay) {
    if (typeof delay === 'number') window.__timeouts.push(delay);
    return nativeTimeout(fn, delay);
  };
  const writeText = (text) => {
    window.__copied.push(String(text));
    return Promise.resolve();
  };
  try {
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, writable: true, value: writeText });
  } catch (error) {
    window.__copied.push('stub-failed');
  }
  window.confirm = () => { window.__confirms.push('confirm'); return false; };
})()`;

describe('the cookie kills only with the proof and the right origin', () => {
  it('refuses a kill that lacks the proof, the origin or a JSON body, and leaves every other route shut', async () => {
    const daemon = await startPageDaemon();
    const id = await startLive(daemon, 'closed');
    const { cookie, proof } = await openDashboard(daemon);
    const port = daemon.port;
    const authed = originHeaders(port, cookie, proof);
    const wrong = proof.replace(/[0-9a-f]/, (char) => (char === 'a' ? 'b' : 'a'));

    const noCookie = await raw(port, 'DELETE', `/sessions/${id}`, {
      'x-shellpuppet-csrf': proof,
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(noCookie.status).toBe(401);

    const missingProof = await raw(port, 'DELETE', `/sessions/${id}`, {
      cookie,
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(missingProof.status).toBe(403);
    const wrongProof = await raw(port, 'DELETE', `/sessions/${id}`, { ...authed, 'x-shellpuppet-csrf': wrong });
    expect(wrongProof.status).toBe(403);

    const missingOrigin = await raw(port, 'DELETE', `/sessions/${id}`, {
      cookie,
      'x-shellpuppet-csrf': proof,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    });
    expect(missingOrigin.status).toBe(403);
    const foreignOrigin = await raw(port, 'DELETE', `/sessions/${id}`, {
      ...authed,
      origin: 'http://evil.example',
    });
    expect(foreignOrigin.status).toBe(403);
    const crossSite = await raw(port, 'DELETE', `/sessions/${id}`, {
      ...authed,
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.status).toBe(403);

    const notJson = await raw(port, 'DELETE', `/sessions/${id}`, authed, 'not-json');
    expect(notJson.status).toBe(400);

    expect((await raw(port, 'POST', '/daemon/shutdown', authed, '{}')).status).toBe(401);
    expect((await raw(port, 'POST', `/sessions/${id}/screenshot`, authed, '{}')).status).toBe(401);
    expect((await raw(port, 'POST', '/sessions', authed, JSON.stringify({ command: process.execPath }))).status).toBe(401);
    expect((await raw(port, 'POST', `/sessions/${id}/viewer`, authed, '{}')).status).toBe(401);
    expect((await raw(port, 'GET', '/environment', authed)).status).toBe(401);
    expect((await raw(port, 'POST', `/sessions/${id}/input`, authed, JSON.stringify({ text: 'echo secret' }))).status).toBe(401);
    expect((await raw(port, 'POST', `/sessions/${id}/key`, authed, JSON.stringify({ key: 'enter' }))).status).toBe(401);
    expect((await raw(port, 'POST', '/dashboard/launch', {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ profile: 'nope', command: 'calc.exe' }))).status).toBe(400);
    expect(await upgradeStatus(port, '/events', {
      cookie,
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    })).toBe(401);

    expect(await sessionIds(daemon)).toEqual([id]);
    const reasons = auditEntries(daemon.home)
      .filter((line) => line.action === 'refuse')
      .map((line) => line.meta?.reason);
    expect(reasons).toEqual(expect.arrayContaining(['proof', 'origin', 'fetch-site', 'body']));
    const killLines = auditEntries(daemon.home).filter((line) => line.action === 'kill');
    expect(killLines).toEqual([]);
  });

  it('kills with one DELETE when the cookie, proof and origin all match, and a client token stays a client kill', async () => {
    const daemon = await startPageDaemon();
    const id = await startLive(daemon, 'target');
    const other = await startLive(daemon, 'client-owned');
    const { cookie, proof } = await openDashboard(daemon);
    const headers = originHeaders(daemon.port, cookie, proof);

    const killed = await raw(daemon.port, 'DELETE', `/sessions/${id}`, headers);
    expect(killed.status).toBe(200);
    expect(JSON.parse(killed.body)).toEqual({ ok: true, killed: id });
    expect(killed.headers['access-control-allow-origin']).toBeUndefined();
    expect(await sessionIds(daemon)).toEqual([other]);
    const again = await raw(daemon.port, 'DELETE', `/sessions/${id}`, headers);
    expect(again.status).toBe(404);
    expect(again.body).toContain(`No such session: ${id}`);

    const dashboardKills = auditEntries(daemon.home).filter((line) => line.action === 'kill' && line.session === id);
    expect(dashboardKills).toEqual([expect.objectContaining({ actor: 'dashboard', action: 'kill', session: id })]);

    const byClient = await raw(daemon.port, 'DELETE', `/sessions/${other}`, {
      authorization: `Bearer ${daemon.token}`,
      cookie,
      'x-shellpuppet-csrf': proof,
      origin: `http://127.0.0.1:${String(daemon.port)}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(byClient.status).toBe(200);
    expect(await sessionIds(daemon)).toEqual([]);
    const clientKills = auditEntries(daemon.home).filter((line) => line.action === 'kill' && line.session === other);
    expect(clientKills).toEqual([expect.objectContaining({ actor: 'client', action: 'kill', session: other })]);
  });
});

describe('human controls in the browser', () => {
  it('keeps the prefix and an unbound follow-up out of the session, copies the id, and kills once', async (context) => {
    if (!browser) { context.skip(); return; }
    const daemon = await startPageDaemon();
    const first = await startLive(daemon, 'first');
    const second = await startLive(daemon, 'second');
    const url = await freshDashboardUrl(daemon);
    const shot = await captureViewer({
      browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
      probe: `(() => { try {
        const state = (window.__controlsProbe ||= { started: Date.now(), acted: false });
        const firstId = ${JSON.stringify(first)};
        const secondId = ${JSON.stringify(second)};
        const card = (id) => document.querySelector('[data-session="' + id + '"]');
        const ready = document.getElementById('connection')?.textContent === 'Connected'
          && card(firstId) && card(secondId)
          && (card(firstId).querySelector('.pane-size')?.textContent || '').includes('\\u00d7')
          && (card(secondId).querySelector('.pane-size')?.textContent || '').includes('\\u00d7')
          && card(firstId).querySelector('textarea');
        if (!state.acted) {
          if (!ready) {
            if (Date.now() - state.started > 12000) return JSON.stringify({ ok: false, phase: 'ready',
              connection: document.getElementById('connection')?.textContent,
              panes: [...document.querySelectorAll('.pane')].map((pane) => pane.dataset.session) });
            return null;
          }
          const feed = window.__sockets.find((entry) => entry.url.endsWith('/dashboard/events'))?.socket;
          feed.onmessage({ data: JSON.stringify({ type: 'session-updated', session: {
            id: secondId, label: 'second', cols: 100, rows: 30,
            waitingOnPrompt: { question: 'ready', options: [], waitingMs: 20000, alerted: true } } }) });
          const boxes = () => [...document.querySelectorAll('.pane')].map((pane) => {
            const box = pane.getBoundingClientRect();
            return [box.x, box.y, box.width, box.height];
          });
          const before = boxes();
          const area = card(firstId).querySelector('textarea');
          area.focus();
          const press = (init, keyCode) => {
            const event = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
            if (keyCode) {
              Object.defineProperty(event, 'keyCode', { get: () => keyCode });
              Object.defineProperty(event, 'which', { get: () => keyCode });
            }
            area.dispatchEvent(event);
          };
          const mark = window.__sent.length;
          press({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }, 65);
          press({ key: 'j', code: 'KeyJ' }, 74);
          const afterJump = boxes();
          const jumped = document.querySelector('.pane.selected')?.dataset.session || '';
          press({ key: 'p', code: 'KeyP' }, 80);
          const pins = JSON.parse(localStorage.getItem('shellpuppet.dashboard') || '{}').pins || [];
          press({ key: 'f', code: 'KeyF' }, 70);
          press({ key: 'c', code: 'KeyC', ctrlKey: true }, 67);
          const duringNav = window.__sent.slice(mark);
          press({ key: 'Escape', code: 'Escape' }, 27);
          const markSlash = window.__sent.length;
          press({ key: '\\\\', code: 'Backslash', ctrlKey: true }, 220);
          const slash = window.__sent.slice(markSlash);
          const copy = card(firstId).querySelector('[data-action="copy"]');
          const fetchesBefore = window.__fetches.length;
          const sentBefore = window.__sent.length;
          if (copy) copy.click();
          const kill = card(firstId).querySelector('[data-action="kill"]');
          state.stash = {
            duringNav, afterJump, before, jumped, pins, slash,
            copied: window.__copied.slice(),
            copyFetches: window.__fetches.length - fetchesBefore,
            copySends: window.__sent.length - sentBefore,
            killInHead: kill ? kill.closest('.pane-head') !== null : null,
            help: document.getElementById('help')?.textContent || '',
            shortcut: document.getElementById('shortcut-help')?.textContent || '',
          };
          state.acted = true;
          state.at = Date.now();
          if (kill) kill.click();
          else return JSON.stringify(Object.assign({ ok: true, deletes: 0, paneGone: false, confirms: window.__confirms.slice() }, state.stash));
          return null;
        }
        const gone = card(firstId) === null;
        if (!gone && Date.now() - state.at < 25000) return null;
        if (gone && state.goneAt === undefined) { state.goneAt = Date.now(); return null; }
        if (gone && Date.now() - state.goneAt < 500) return null;
        const deletes = window.__fetches.filter((entry) => entry.method === 'DELETE' && entry.url.indexOf('/sessions/') !== -1);
        return JSON.stringify(Object.assign({
          ok: true, deletes: deletes.length, paneGone: gone, confirms: window.__confirms.slice(),
        }, state.stash));
      } catch (error) { return JSON.stringify({ ok: false, error: String(error) }); } })()`,
    });
    const result = JSON.parse(String(shot.probe)) as {
      ok: boolean; phase?: string; duringNav?: string[]; before?: number[][]; afterJump?: number[][];
      jumped?: string; pins?: string[]; slash?: string[]; copied?: string[]; copyFetches?: number;
      copySends?: number; killInHead?: boolean | null; help?: string; shortcut?: string;
      deletes?: number; paneGone?: boolean; confirms?: string[];
    };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const duringInput = (result.duringNav ?? []).filter((entry) => !entry.startsWith('{') && !entry.startsWith('\u001b'));
    const auditDeadline = Date.now() + 3_000;
    for (;;) {
      const lines = auditEntries(daemon.home);
      if (lines.some((line) => line.action === 'input' || line.action === 'kill') || Date.now() > auditDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const inputs = auditEntries(daemon.home).filter((line) => line.action === 'input');
    const kills = auditEntries(daemon.home).filter((line) => line.action === 'kill' && line.session === first);
    expect({
      duringInput,
      slash: result.slash,
      jumped: result.jumped,
      rects: JSON.stringify(result.before) === JSON.stringify(result.afterJump),
      pins: result.pins,
      fit: (result.duringNav ?? []).some((entry) => entry.includes('"type":"resize"') && entry.includes('"take":true')),
      copied: result.copied,
      copyFetches: result.copyFetches,
      copySends: result.copySends,
      deletes: result.deletes,
      killInHead: result.killInHead,
      paneGone: result.paneGone,
      confirms: result.confirms,
      shortcut: result.shortcut,
      helpListsBackslash: (result.help ?? '').includes('Ctrl+\\'),
      inputs: inputs.map((line) => ({ actor: line.actor, session: line.session })),
      kills: kills.map((line) => ({ actor: line.actor, session: line.session })),
    }).toEqual({
      duringInput: [],
      slash: ['\u001c'],
      jumped: second,
      rects: true,
      pins: [second],
      fit: true,
      copied: [first],
      copyFetches: 0,
      copySends: 0,
      deletes: 1,
      killInHead: false,
      paneGone: true,
      confirms: [],
      shortcut: 'Ctrl+Shift+A',
      helpListsBackslash: false,
      inputs: [{ actor: 'dashboard', session: first }],
      kills: [{ actor: 'dashboard', session: first }],
    });
  }, 180_000);

  it('starts a profile with its folder, restarts that and not an agent session, and pops a pane out', async (context) => {
    if (!browser) { context.skip(); return; }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-controls-work-'));
    tempDirs.push(workDir);
    const daemon = await startPageDaemon({
      launcher: profilesOf([
        {
          name: 'hold', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false,
          cwd: 'ask', folders: [{ name: 'work', path: workDir }], open: 'grid', label: 'Hold',
        },
        {
          name: 'focus-shell', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
          shell: false, cwd: workDir, open: 'focus',
        },
        {
          name: 'pop-shell', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
          shell: false, cwd: workDir, open: 'window',
        },
      ]),
    });
    const agent = await startLive(daemon, 'agent-ended', 'process.exit(0)');
    await eventually(async () => {
      const list = await api(daemon.port, daemon.token, '/sessions');
      const session = ((list.body['sessions'] as { id: string; exited?: boolean; exitCode?: number | null }[] | undefined) ?? [])
        .find((entry) => entry.id === agent);
      return session?.exited === true && session.exitCode === 0;
    }, 15_000);
    const url = await freshDashboardUrl(daemon);
    const shot = await captureViewer({
      browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
      probe: `(() => { try {
        const state = (window.__startProbe ||= { phase: 0, started: Date.now() });
        const agentId = ${JSON.stringify(agent)};
        const timedOut = () => Date.now() - state.started > 12000;
        const fail = (detail) => JSON.stringify(Object.assign({ ok: false, phase: state.phase, detail: detail,
          error: document.getElementById('error')?.textContent || '',
          fetches: window.__fetches, opens: window.__opened || [] }));
        const card = (id) => document.querySelector('[data-session="' + id + '"]');
        const launches = () => { try { return JSON.parse(localStorage.getItem('shellpuppet.dashboard.launches') || '{}'); } catch (e) { return {}; } };
        const bodies = () => window.__fetches.filter((entry) => entry.url.indexOf('/dashboard/launch') !== -1 && entry.method === 'POST').map((entry) => entry.body);
        const resetTimer = () => { state.started = Date.now(); };
        if (state.phase === 0) {
          const launcher = document.getElementById('launcher');
          const restart = card(agentId)?.querySelector('[data-action="restart"]');
          const ended = card(agentId)?.querySelector('.pane-state')?.textContent || '';
          if (!launcher || launcher.hidden || !restart || ended !== 'Ended (code 0)') {
            if (timedOut()) return fail({ launcher: launcher ? !launcher.hidden : null, ended, hidden: restart ? restart.hidden : null });
            return null;
          }
          if (restart.hidden !== true) return fail({ hidden: restart.hidden });
          state.agentHidden = true;
          state.layoutBefore = document.getElementById('panes').dataset.layout;
          document.getElementById('profile').value = 'hold';
          document.getElementById('profile').dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('folder').value = 'work';
          document.getElementById('start').click();
          state.phase = 1; resetTimer(); return null;
        }
        if (state.phase === 1) {
          const hold = Object.keys(launches()).find((id) => launches()[id].profile === 'hold');
          const ended = hold ? (card(hold)?.querySelector('.pane-state')?.textContent || '') : '';
          const restart = hold ? card(hold)?.querySelector('[data-action="restart"]') : null;
          if (!hold || ended !== 'Ended (code 0)' || !restart || restart.hidden) {
            if (timedOut()) return fail({ hold, ended, bodies: bodies() });
            return null;
          }
          state.hold = hold;
          state.layoutAfterGrid = document.getElementById('panes').dataset.layout;
          restart.click();
          state.phase = 2; resetTimer(); return null;
        }
        if (state.phase === 2) {
          if (bodies().length < 2) { if (timedOut()) return fail({ bodies: bodies() }); return null; }
          state.deletesBefore = window.__fetches.filter((entry) => entry.method === 'DELETE').length;
          card(state.hold).querySelector('[data-action="dismiss"]').click();
          state.phase = 3; resetTimer(); return null;
        }
        if (state.phase === 3) {
          if (card(state.hold)) { if (timedOut()) return fail({ hold: state.hold }); return null; }
          state.longTimers = window.__timeouts.filter((delay) => delay >= 60000);
          state.deletesAfter = window.__fetches.filter((entry) => entry.method === 'DELETE').length;
          document.getElementById('profile').value = 'focus-shell';
          document.getElementById('profile').dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('start').click();
          state.phase = 4; resetTimer(); return null;
        }
        if (state.phase === 4) {
          const focus = Object.keys(launches()).find((id) => launches()[id].profile === 'focus-shell');
          const main = document.querySelector('#main-pane .pane')?.dataset.session || '';
          if (!focus || document.getElementById('panes').dataset.layout !== 'focus' || main !== focus) {
            if (timedOut()) return fail({ focus, main, layout: document.getElementById('panes').dataset.layout, bodies: bodies() });
            return null;
          }
          state.orderBefore = JSON.parse(localStorage.getItem('shellpuppet.dashboard') || '{}').order;
          window.__opened = [];
          window.open = (url) => { window.__opened.push(String(url)); return { closed: false }; };
          document.getElementById('profile').value = 'pop-shell';
          document.getElementById('profile').dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('start').click();
          state.phase = 5; resetTimer(); return null;
        }
        if (state.phase === 5) {
          const pop = Object.keys(launches()).find((id) => launches()[id].profile === 'pop-shell');
          if (!pop || window.__opened.length !== 1 || card(pop)) {
            if (timedOut()) return fail({ pop, opens: window.__opened, present: pop ? card(pop) !== null : null });
            return null;
          }
          state.pop = pop;
          const channel = new BroadcastChannel('shellpuppet.dashboard');
          channel.postMessage({ type: 'pop-release', id: pop, token: 'not-ours' });
          state.phase = 6; resetTimer(); return null;
        }
        const back = card(state.pop) !== null;
        if (!back) { if (timedOut()) return fail({ pop: state.pop }); return null; }
        const pref = JSON.parse(localStorage.getItem('shellpuppet.dashboard') || '{}');
        return JSON.stringify({
          ok: true,
          agentHidden: state.agentHidden,
          layoutBefore: state.layoutBefore,
          layoutAfterGrid: state.layoutAfterGrid,
          hold: state.hold,
          bodies: bodies(),
          longTimers: state.longTimers,
          deletesBefore: state.deletesBefore,
          deletesAfter: state.deletesAfter,
          orderBefore: state.orderBefore,
          orderAfter: pref.order,
          prefKeys: Object.keys(pref).sort(),
          opened: window.__opened,
          pop: state.pop,
          back: back,
        });
      } catch (error) { return JSON.stringify({ ok: false, error: String(error) }); } })()`,
    });
    const result = JSON.parse(String(shot.probe)) as {
      ok: boolean; agentHidden?: boolean; layoutBefore?: string; layoutAfterGrid?: string;
      bodies?: string[]; longTimers?: number[]; deletesBefore?: number; deletesAfter?: number;
      orderBefore?: string[]; orderAfter?: string[]; prefKeys?: string[]; opened?: string[]; pop?: string;
    };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const bodies = (result.bodies ?? []).map((body) => JSON.parse(body) as Record<string, unknown>);
    expect(bodies).toEqual([
      { profile: 'hold', folder: 'work' },
      { profile: 'hold', folder: 'work' },
      { profile: 'focus-shell' },
      { profile: 'pop-shell' },
    ]);
    expect(bodies.every((body) => body['command'] === undefined && body['env'] === undefined)).toBe(true);
    expect(result.agentHidden).toBe(true);
    expect(result.layoutBefore).toBe('grid');
    expect(result.layoutAfterGrid).toBe('grid');
    expect(result.longTimers).toEqual([]);
    expect(result.deletesBefore).toBe(0);
    expect(result.deletesAfter).toBe(0);
    expect(result.opened).toEqual([`http://127.0.0.1:${String(daemon.port)}/dashboard#pop=${result.pop ?? ''}`]);
    expect(result.opened?.[0]).not.toContain('dt=');
    expect(result.orderAfter).toEqual([...(result.orderBefore ?? []), result.pop]);
    expect(result.orderAfter).toContain(result.pop);
    expect(result.prefKeys).toEqual(['mode', 'order', 'pins', 'prefix']);
  }, 180_000);

  it('restores mode, order and pin from the browser and writes nothing to the daemon home', async (context) => {
    if (!browser) { context.skip(); return; }
    const daemon = await startPageDaemon();
    const first = await startLive(daemon, 'layout-first');
    const second = await startLive(daemon, 'layout-second');
    const beforeNames = fs.readdirSync(daemon.home).sort();
    const beforeConfig = fs.readFileSync(path.join(daemon.home, 'config.json'));
    const url = await freshDashboardUrl(daemon);
    const shot = await captureViewer({
      browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
      probe: `(() => { try {
        const marker = localStorage.getItem('shellpuppet.controls.probe');
        const cards = () => [...document.querySelectorAll('.pane')];
        if (marker === 'reloading') {
          if (document.getElementById('connection')?.textContent !== 'Connected' || cards().length !== 2) return null;
          return JSON.stringify({
            ok: true,
            layout: document.getElementById('panes').dataset.layout,
            pref: JSON.parse(localStorage.getItem('shellpuppet.dashboard') || '{}'),
            ids: cards().map((pane) => pane.dataset.session),
            connection: document.getElementById('connection').textContent,
          });
        }
        const started = window.__layoutStarted || (window.__layoutStarted = Date.now());
        const ready = document.getElementById('connection')?.textContent === 'Connected' && cards().length === 2
          && cards().every((pane) => (pane.querySelector('.pane-size')?.textContent || '').includes('\\u00d7'));
        if (!ready) {
          if (Date.now() - started > 12000) return JSON.stringify({ ok: false, phase: 'ready', count: cards().length });
          return null;
        }
        const firstId = ${JSON.stringify(first)};
        const secondId = ${JSON.stringify(second)};
        document.getElementById('grid').click();
        document.querySelector('[data-session="' + firstId + '"] button[aria-label="Pin"]').click();
        const feed = window.__sockets.find((entry) => entry.url.endsWith('/dashboard/events'));
        if (feed) feed.socket.close();
        localStorage.setItem('shellpuppet.dashboard', JSON.stringify({
          mode: 'grid', order: ['gone-session', secondId, firstId], pins: [firstId], prefix: 'a',
        }));
        localStorage.setItem('shellpuppet.controls.probe', 'reloading');
        setTimeout(() => location.reload(), 30);
        return null;
      } catch (error) { return JSON.stringify({ ok: false, error: String(error) }); } })()`,
    });
    const result = JSON.parse(String(shot.probe)) as {
      ok: boolean; layout?: string; ids?: string[]; connection?: string;
      pref?: { mode?: string; order?: string[]; pins?: string[]; prefix?: string };
    };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.connection).toBe('Connected');
    expect(result.layout).toBe('grid');
    expect(result.ids).toEqual([second, first]);
    expect(result.pref).toEqual({ mode: 'grid', order: [second, first], pins: [first], prefix: 'a' });
    expect(result.pref?.order).not.toContain('gone-session');
    expect(fs.readdirSync(daemon.home).sort()).toEqual(beforeNames);
    expect(fs.readFileSync(path.join(daemon.home, 'config.json'))).toEqual(beforeConfig);
    expect(fs.existsSync(path.join(daemon.home, 'dashboard.json'))).toBe(false);
  }, 180_000);

  it('makes a popped-out document full screen from its own button', async (context) => {
    if (!browser) { context.skip(); return; }
    const daemon = await startPageDaemon();
    const id = await startLive(daemon, 'pop-target');
    const url = await freshDashboardUrl(daemon);
    const shot = await captureViewer({
      browser, viewerUrl: url, width: 1280, height: 720,
      drive: true, timeoutMs: 90_000,
      beforeNavigateScript: `(() => { if (!location.hash.startsWith('#pop=')) history.replaceState(null, '', location.pathname + location.search + '#pop=' + encodeURIComponent(${JSON.stringify(id)})); })()`,
      probe: `(() => {
        const button = document.getElementById('fullscreen');
        const started = window.__fsStarted || (window.__fsStarted = Date.now());
        if (!button || button.hidden) {
          if (Date.now() - started > 8000) return JSON.stringify({ ok: false, hash: location.hash, hidden: button ? button.hidden : null });
          return null;
        }
        document.documentElement.requestFullscreen = () => { window.__fullscreen = ['request']; return Promise.resolve(); };
        button.click();
        return JSON.stringify({ ok: true, text: button.textContent, calls: window.__fullscreen || [], hash: location.hash });
      })()`,
    });
    const result = JSON.parse(String(shot.probe)) as { ok: boolean; text?: string; calls?: string[]; hash?: string };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.text).toBe('Full screen');
    expect(result.calls).toEqual(['request']);
    expect(result.hash).toBe(`#pop=${encodeURIComponent(id)}`);
  }, 120_000);
});
