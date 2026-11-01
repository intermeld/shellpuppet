/**
 * Dashboard access credential (design §4.1, §5.1).
 *
 * The grant is one use. The cookie it becomes may open the dashboard page,
 * the session list and `/dashboard/events`. It does not open the client-token
 * routes. `/events` stays on the client token.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAuditor } from '../../src/daemon/audit.js';
import { VIEWER_GRANT_TTL_MS } from '../../src/daemon/auth.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

interface RawResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface DashDaemon extends TestDaemon {
  urls: string[];
  logPath: string;
  clock: { now: number };
}

const running: DashDaemon[] = [];

afterEach(async () => {
  const pending = running.splice(0);
  for (const daemon of pending) await daemon.stop();
});

async function startDash(extra: { clock?: boolean; maxSessions?: number } = {}): Promise<DashDaemon> {
  const home = makeTempHome('dash-cred-');
  const logPath = path.join(home, 'daemon.log');
  const urls: string[] = [];
  const clock = { now: 1_700_000_000_000 };
  const daemon = await startTestDaemon({
    home,
    logger: createFileLogger(logPath),
    audit: createAuditor(home),
    policy: { mode: 'allow-all', ...(extra.maxSessions !== undefined ? { maxSessions: extra.maxSessions } : {}) },
    promptScanIntervalMs: 600_000,
    idleCheckIntervalMs: 600_000,
    ...(extra.clock === true ? { now: () => clock.now } : {}),
    launcher: (url) => {
      urls.push(url);
      return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
    },
  });
  const wrapped = Object.assign(daemon, { urls, logPath, clock });
  running.push(wrapped);
  return wrapped;
}

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
        headers: { host: `127.0.0.1:${String(port)}`, ...headers },
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

function setCookie(headers: http.IncomingHttpHeaders): string {
  return headerList(headers['set-cookie']).join('\n');
}

function cookiePair(headers: http.IncomingHttpHeaders): string {
  const line = headerList(headers['set-cookie'])[0] ?? '';
  return line.split(';')[0] ?? '';
}

function csrfMeta(html: string): string | null {
  const match = /<meta name="sp-csrf" content="([^"]*)">/.exec(html);
  return match === null ? null : (match[1] ?? '');
}

function navigationHeaders(site: string = 'none'): Record<string, string> {
  return {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-site': site,
  };
}

function readHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'sec-fetch-site': 'same-origin',
    ...extra,
  };
}

function upgradeStatus(
  port: number,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; protocol: string | undefined }> {
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
    req.on('upgrade', (res: http.IncomingMessage, socket) => {
      const header = res.headers['sec-websocket-protocol'];
      socket.destroy();
      resolve({
        status: res.statusCode ?? 101,
        protocol: typeof header === 'string' ? header : undefined,
      });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, protocol: undefined });
    });
    req.on('error', reject);
    req.end();
  });
}

function eventsHeaders(
  port: number,
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: `127.0.0.1:${String(port)}`,
    origin: `http://127.0.0.1:${String(port)}`,
    cookie,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'websocket',
    ...extra,
  };
}

interface FeedClient {
  frames: Record<string, unknown>[];
  protocol: string;
  send: (data: string) => void;
  close: () => void;
}

function connectFeed(
  port: number,
  cookie: string,
  proof: string,
  headers: Record<string, string> = {},
): Promise<FeedClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/dashboard/events`, [`sp-csrf.${proof}`], {
      headers: eventsHeaders(port, cookie, headers),
    });
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer | string) => {
      frames.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    ws.on('open', () => {
      resolve({
        frames,
        protocol: ws.protocol,
        send: (data) => ws.send(data),
        close: () => ws.close(),
      });
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`dashboard events refused with ${String(response.statusCode)}`));
    });
    ws.on('error', reject);
  });
}

async function sessionIds(daemon: TestDaemon): Promise<string[]> {
  const list = await api(daemon.port, daemon.token, '/sessions');
  expect(list.status).toBe(200);
  return ((list.body['sessions'] as { id: string }[] | undefined) ?? []).map((session) => session.id);
}

async function startQuiet(daemon: TestDaemon, label: string): Promise<string> {
  const started = await api(daemon.port, daemon.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 200)'],
      shell: false,
      openViewer: false,
      label,
    },
  });
  expect(started.status).toBe(200);
  return String(started.body['id']);
}

async function openDashboard(daemon: DashDaemon): Promise<{ grant: string; url: string }> {
  const before = daemon.urls.length;
  const response = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ opened: true });
  expect(JSON.stringify(response.body)).not.toContain('dt=');
  expect(JSON.stringify(response.body)).not.toContain('/dashboard?');
  expect(daemon.urls).toHaveLength(before + 1);
  const url = daemon.urls.at(-1) ?? '';
  const grant = new URL(url).searchParams.get('dt') ?? '';
  expect(grant).toMatch(/^[0-9a-f]{64}$/);
  return { grant, url };
}

function textsOf(home: string, logPath: string): string {
  const auditPath = path.join(home, 'audit.log');
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return `${audit}\n${log}`;
}

function refusalLines(home: string): { method: string; path: string; reason: string }[] {
  const auditPath = path.join(home, 'audit.log');
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as {
      action: string;
      meta?: { method?: string; path?: string; reason?: string };
    })
    .filter((line) => line.action === 'refuse')
    .map((line) => ({
      method: line.meta?.method ?? '',
      path: line.meta?.path ?? '',
      reason: line.meta?.reason ?? '',
    }));
}

async function redeem(
  daemon: DashDaemon,
  grant: string,
  headers: Record<string, string> = {},
): Promise<RawResult> {
  return raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, {
    ...navigationHeaders('none'),
    ...headers,
  });
}

describe('an unauthenticated caller learns nothing and starts nothing', () => {
  it('serves an empty dashboard page and refuses the new calls', async () => {
    const daemon = await startDash();
    const id = await startQuiet(daemon, 'hidden-from-the-page');
    const page = await raw(daemon.port, 'GET', '/dashboard');
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(id);
    expect(page.body).not.toContain('dt=');
    expect(page.body).not.toContain('sp-csrf');
    expect(page.body).not.toContain(process.execPath);
    expect(page.headers['content-security-policy']).toBe(PAGE_CSP);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(setCookie(page.headers)).toBe('');

    const health = await api(daemon.port, null, '/health');
    expect(health.status).toBe(200);

    const open = await api(daemon.port, null, '/dashboard/open', { method: 'POST', body: {} });
    expect(open.status).toBe(401);
    expect(JSON.stringify(open.body)).not.toContain(id);

    const launch = await raw(daemon.port, 'POST', '/dashboard/launch', {
      'content-type': 'application/json',
    }, '{}');
    expect(launch.status).toBe(401);
    const removed = await raw(daemon.port, 'DELETE', `/sessions/${id}`);
    expect(removed.status).toBe(401);
    expect(await sessionIds(daemon)).toContain(id);

    const events = await upgradeStatus(daemon.port, '/dashboard/events');
    expect(events.status).toBe(401);
    const stream = await upgradeStatus(daemon.port, `/sessions/${id}/stream`);
    expect(stream.status).toBe(401);
    expect(await sessionIds(daemon)).toEqual([id]);
  });
});

describe('a dashboard grant works once, then it is worthless', () => {
  it('redeems on a document navigation and then neither again nor after expiry', async () => {
    const daemon = await startDash({ clock: true });
    const { grant } = await openDashboard(daemon);
    const first = await redeem(daemon, grant);
    expect(first.status).toBe(200);
    const cookieHeader = setCookie(first.headers);
    expect(cookieHeader).toMatch(/^sp_dash=[A-Za-z0-9%._~-]+; /);
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Strict');
    expect(cookieHeader).toContain('Path=/');
    expect(cookieHeader).not.toMatch(/Max-Age|Expires|Secure|Domain/i);
    const proof = csrfMeta(first.body);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body).not.toContain(grant);

    const second = await redeem(daemon, grant);
    expect(second.status).toBe(200);
    expect(setCookie(second.headers)).toBe('');
    expect(csrfMeta(second.body)).toBeNull();

    const expiredGrant = (await openDashboard(daemon)).grant;
    daemon.clock.now += VIEWER_GRANT_TTL_MS;
    const expired = await redeem(daemon, expiredGrant);
    expect(expired.status).toBe(200);
    expect(setCookie(expired.headers)).toBe('');
    expect(csrfMeta(expired.body)).toBeNull();

    const cookie = cookiePair(first.headers);
    const list = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie,
      'x-shellpuppet-csrf': proof ?? '',
    }));
    expect(list.status).toBe(200);
    expect(list.body).not.toContain('hidden-from-the-page');
    const parsed = JSON.parse(list.body) as { sessions: unknown[] };
    expect(Array.isArray(parsed.sessions)).toBe(true);
  });

  it('a failed open revokes the grant and records neither the grant nor a URL', async () => {
    const home = makeTempHome('dash-fail-');
    const logPath = path.join(home, 'daemon.log');
    const urls: string[] = [];
    const daemon = await startTestDaemon({
      home,
      logger: createFileLogger(logPath),
      audit: createAuditor(home),
      launcher: (url) => {
        urls.push(url);
        return Promise.resolve({ launched: false, mode: 'none' as const, reason: 'window did not start' });
      },
    });
    running.push(Object.assign(daemon, { urls, logPath, clock: { now: 0 } }));
    const response = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).not.toContain('dt=');
    expect(JSON.stringify(response.body)).not.toContain('/dashboard?');
    expect(urls).toHaveLength(1);
    const grant = new URL(urls[0] ?? '').searchParams.get('dt') ?? '';
    const page = await raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, navigationHeaders());
    expect(setCookie(page.headers)).toBe('');
    const written = textsOf(home, logPath);
    expect(written).not.toContain(grant);
    expect(written).not.toContain('/dashboard?');
    expect(written).not.toContain('dt=');
  });

  it('a default-browser result is not a successful open', async () => {
    const home = makeTempHome('dash-default-');
    const urls: string[] = [];
    const daemon = await startTestDaemon({
      home,
      audit: createAuditor(home),
      launcher: (url) => {
        urls.push(url);
        return Promise.resolve({ launched: true, mode: 'default-browser' as const });
      },
    });
    running.push(Object.assign(daemon, { urls, logPath: '', clock: { now: 0 } }));
    const response = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).not.toContain('/dashboard?');
    const grant = new URL(urls[0] ?? '').searchParams.get('dt') ?? '';
    const page = await raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, navigationHeaders());
    expect(setCookie(page.headers)).toBe('');
  });
});

describe('dt is redeemed only on a top-level document navigation', () => {
  it('a fetch-shaped GET does not spend the grant, and a navigation does', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const fetched = await raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, {
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-fetch-site': 'same-origin',
    });
    expect(fetched.status).toBe(200);
    expect(setCookie(fetched.headers)).toBe('');
    expect(csrfMeta(fetched.body)).toBeNull();

    const navigated = await redeem(daemon, grant);
    expect(navigated.status).toBe(200);
    expect(cookiePair(navigated.headers)).toMatch(/^sp_dash=/);
    expect(csrfMeta(navigated.body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('HEAD is a document navigation and spends the grant', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const head = await raw(daemon.port, 'HEAD', `/dashboard?dt=${grant}`, navigationHeaders());
    expect(head.status).toBe(200);
    expect(cookiePair(head.headers)).toMatch(/^sp_dash=/);
    expect(head.body).toBe('');
    const again = await redeem(daemon, grant);
    expect(setCookie(again.headers)).toBe('');
  });
});

describe('Host, Origin and Sec-Fetch-Site', () => {
  it('rejects a foreign Host on each new dashboard route, and the page still answers on its own Host', async () => {
    const daemon = await startDash();
    const evil = `attacker.example:${String(daemon.port)}`;
    for (const [method, requestPath] of [
      ['GET', '/dashboard'],
      ['POST', '/dashboard/open'],
    ] as const) {
      const response = await raw(daemon.port, method, requestPath, { host: evil });
      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    const upgrade = await upgradeStatus(daemon.port, '/dashboard/events', { host: evil });
    expect(upgrade.status).toBe(403);
    const page = await raw(daemon.port, 'GET', '/dashboard');
    expect(page.status).toBe(200);
    expect(await sessionIds(daemon)).toEqual([]);
  });

  it('a foreign Origin cannot use the cookie', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const hostile = {
      cookie,
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
      'x-shellpuppet-csrf': proof,
    };
    const list = await raw(daemon.port, 'GET', '/sessions', readHeaders(hostile));
    expect(list.status).toBe(403);
    expect(list.headers['access-control-allow-origin']).toBeUndefined();
    const upgrade = await upgradeStatus(daemon.port, '/dashboard/events', eventsHeaders(daemon.port, cookie, {
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    }));
    expect(upgrade.status).toBe(403);
    expect(await sessionIds(daemon)).toEqual([]);
  });

  it('the requests that may omit Origin are the document navigation and the same-origin read', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';

    const reloaded = await raw(daemon.port, 'GET', '/dashboard', {
      ...navigationHeaders('none'),
      cookie,
    });
    expect(reloaded.status).toBe(200);
    expect(setCookie(reloaded.headers)).toBe('');
    expect(csrfMeta(reloaded.body)).toMatch(/^[0-9a-f]{64}$/);

    const list = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie,
      'x-shellpuppet-csrf': proof,
    }));
    expect(list.status).toBe(200);

    const posted = await raw(daemon.port, 'POST', '/sessions', {
      cookie,
      'content-type': 'application/json',
      'x-shellpuppet-csrf': proof,
    }, JSON.stringify({ command: process.execPath, shell: false }));
    expect(posted.status).toBe(401);
    const socket = await upgradeStatus(daemon.port, '/dashboard/events', {
      cookie,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'websocket',
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    });
    expect(socket.status).toBe(403);

    const started = await api(daemon.port, daemon.token, '/sessions', {
      headers: {},
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        openViewer: false,
      },
    });
    expect(started.status).toBe(200);
  });

  it('another loopback port is same-site, and a missing Sec-Fetch-Site is not a document', async () => {
    const daemon = await startDash();
    const id = await startQuiet(daemon, 'loopback-port');
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const other = `http://127.0.0.1:${String(daemon.port + 1)}`;

    for (const site of [undefined, 'same-site', 'cross-site'] as const) {
      const headers: Record<string, string> = {
        cookie,
        origin: site === undefined ? `http://127.0.0.1:${String(daemon.port)}` : other,
        'x-shellpuppet-csrf': proof,
      };
      if (site !== undefined) headers['sec-fetch-site'] = site;
      const listHeaders = readHeaders(headers);
      // readHeaders sets same-origin. The absent case is this iteration, so
      // the header has to be removed rather than left as a real site.
      if (site === undefined) delete listHeaders['sec-fetch-site'];
      const list = await raw(daemon.port, 'GET', '/sessions', listHeaders);
      expect(list.status).toBe(403);
      const upgrade = await upgradeStatus(
        daemon.port,
        '/dashboard/events',
        eventsHeaders(daemon.port, cookie, {
          ...(site === undefined ? {} : { origin: other, 'sec-fetch-site': site }),
          'sec-websocket-protocol': `sp-csrf.${proof}`,
          ...(site === undefined ? { 'sec-fetch-site': '' } : {}),
        }),
      );
      // An empty header value is still not same-origin. Dropping the header
      // is the absent case, covered by the list request above and here when
      // the spread omits a real site.
      expect([401, 403]).toContain(upgrade.status);
      const stream = await upgradeStatus(daemon.port, `/sessions/${id}/stream`, eventsHeaders(daemon.port, cookie, {
        origin: other,
        'sec-fetch-site': 'same-site',
        'sec-websocket-protocol': `sp-csrf.${proof}`,
      }));
      // That other port is not this daemon's Origin, so the upgrade is
      // refused before the dashboard cookie is considered.
      expect(stream.status).toBe(403);
    }

    const allowed = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie,
      origin: `http://127.0.0.1:${String(daemon.port)}`,
      'x-shellpuppet-csrf': proof,
    }));
    expect(allowed.status).toBe(200);
    expect(await sessionIds(daemon)).toEqual([id]);
  });

  it('a cookie Origin whose hostname does not match Host is refused', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const list = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      host: `localhost:${String(daemon.port)}`,
      origin: `http://127.0.0.1:${String(daemon.port)}`,
      cookie,
      'x-shellpuppet-csrf': proof,
    }));
    expect(list.status).toBe(403);
  });

  it('refuses a forbidden Sec-Fetch-Site on the anonymous page and on a cookied same-site navigation', async () => {
    const daemon = await startDash();
    const anonymous = await raw(daemon.port, 'GET', '/dashboard', navigationHeaders('cross-site'));
    expect(anonymous.status).toBe(403);
    expect(anonymous.body).not.toContain('sp-csrf');
    expect(setCookie(anonymous.headers)).toBe('');

    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    // Another loopback port is same-site and sends its own Origin. The page
    // refuses the site before it classifies that Origin, so the reason is
    // fetch-site rather than origin.
    const sameSite = await raw(daemon.port, 'GET', '/dashboard', {
      ...navigationHeaders('same-site'),
      cookie,
      origin: `http://127.0.0.1:${String(daemon.port + 1)}`,
    });
    expect(sameSite.status).toBe(403);
    expect(sameSite.body).not.toContain('sp-csrf');
    expect(setCookie(sameSite.headers)).toBe('');
    expect(refusalLines(daemon.home).filter((line) => line.path === '/dashboard')).toEqual([
      { method: 'GET', path: '/dashboard', reason: 'fetch-site' },
      { method: 'GET', path: '/dashboard', reason: 'fetch-site' },
    ]);
  });

  it('refuses a foreign Origin before authentication on every upgrade', async () => {
    const daemon = await startDash();
    const id = await startQuiet(daemon, 'origin-before-auth');
    const foreign = { origin: 'http://evil.example' };

    const streamBare = await upgradeStatus(daemon.port, `/sessions/${id}/stream`, foreign);
    expect(streamBare.status).toBe(403);
    const streamBad = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream?token=not-the-token`,
      foreign,
    );
    expect(streamBad.status).toBe(403);
    const streamToken = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream?token=${daemon.token}`,
      foreign,
    );
    expect(streamToken.status).toBe(403);
    const missing = await upgradeStatus(
      daemon.port,
      `/sessions/s999999/stream?token=${daemon.token}`,
      foreign,
    );
    expect(missing.status).toBe(403);

    expect((await upgradeStatus(daemon.port, '/events', foreign)).status).toBe(403);
    expect((await upgradeStatus(daemon.port, '/events?token=not-the-token', foreign)).status).toBe(403);
    expect((await upgradeStatus(daemon.port, '/dashboard/events', foreign)).status).toBe(403);

    // A missing Origin is not a foreign one. A bad credential is still 401,
    // and that 401 still hides whether the session exists.
    expect((await upgradeStatus(daemon.port, `/sessions/s999999/stream?token=not-the-token`)).status).toBe(401);
    expect((await upgradeStatus(daemon.port, '/dashboard/events')).status).toBe(401);
  });

  it("a client-token HTTP request still ignores Origin, which is today's bearer rule", async () => {
    const daemon = await startDash();
    const started = await raw(daemon.port, 'POST', '/sessions', {
      authorization: `Bearer ${daemon.token}`,
      origin: 'http://evil.example',
      'content-type': 'application/json',
    }, JSON.stringify({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 200)'],
      shell: false,
      openViewer: false,
    }));
    expect(started.status).toBe(200);
  });
});

describe('the document proof', () => {
  it('refuses a missing or wrong proof on HTTP and on the socket', async () => {
    const daemon = await startDash();
    const id = await startQuiet(daemon, 'proof-target');
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const flipped = proof.endsWith('a')
      ? `${proof.slice(0, 63)}b`
      : `${proof.slice(0, 63)}a`;
    expect(flipped).toHaveLength(64);

    const missing = await raw(daemon.port, 'GET', '/sessions', readHeaders({ cookie }));
    expect(missing.status).toBe(403);
    const wrong = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie,
      'x-shellpuppet-csrf': flipped,
    }));
    expect(wrong.status).toBe(403);

    const headerOnly = await upgradeStatus(daemon.port, '/dashboard/events', eventsHeaders(daemon.port, cookie, {
      'x-shellpuppet-csrf': proof,
    }));
    expect(headerOnly.status).toBe(403);
    const wrongProtocol = await upgradeStatus(daemon.port, '/dashboard/events', eventsHeaders(daemon.port, cookie, {
      'sec-websocket-protocol': `sp-csrf.${flipped}`,
    }));
    expect(wrongProtocol.status).toBe(403);

    const stream = await upgradeStatus(daemon.port, `/sessions/${id}/stream`, eventsHeaders(daemon.port, cookie, {
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    }));
    expect(stream.status).toBe(401);

    const feed = await connectFeed(daemon.port, cookie, proof);
    expect(feed.protocol).toBe(`sp-csrf.${proof}`);
    await eventually(() => feed.frames.some((frame) => frame['type'] === 'hello'));
    feed.close();
  });

  it('a reload and a second document each receive a proof, and the ring keeps the eight newest', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const first = await redeem(daemon, grant);
    const cookie = cookiePair(first.headers);
    const proofs = [csrfMeta(first.body) ?? ''];
    for (let i = 0; i < 8; i += 1) {
      const next = await raw(daemon.port, 'GET', '/dashboard', { ...navigationHeaders('same-origin'), cookie });
      expect(next.status).toBe(200);
      expect(setCookie(next.headers)).toBe('');
      expect(next.body).not.toContain('sp-csrf" content=""');
      const proof = csrfMeta(next.body) ?? '';
      expect(proof).toMatch(/^[0-9a-f]{64}$/);
      proofs.push(proof);
    }
    expect(new Set(proofs).size).toBe(9);
    const oldest = await upgradeStatus(daemon.port, '/dashboard/events', eventsHeaders(daemon.port, cookie, {
      'sec-websocket-protocol': `sp-csrf.${proofs[0]}`,
    }));
    expect(oldest.status).toBe(403);
    const kept = await connectFeed(daemon.port, cookie, proofs[1] ?? '');
    kept.close();
    const newest = await connectFeed(daemon.port, cookie, proofs[8] ?? '');
    newest.close();
  });

  it('any script that can read this origin can act as the dashboard, and HttpOnly is not the control', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const viewer = await raw(daemon.port, 'GET', '/view', { cookie });
    expect(viewer.status).toBe(200);
    expect(viewer.body).not.toContain('sp-csrf');
    const dashboard = await raw(daemon.port, 'GET', '/dashboard', {
      ...navigationHeaders('same-origin'),
      cookie,
    });
    const proof = csrfMeta(dashboard.body);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    const list = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie,
      'x-shellpuppet-csrf': proof ?? '',
    }));
    expect(list.status).toBe(200);
  });
});

describe('a planted cookie must not shadow sp_dash', () => {
  it('tries every sp_dash value, and a planted value alone does not authenticate', async () => {
    const daemon = await startDash();
    const id = await startQuiet(daemon, 'planted-dash');
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const both = `sp_dash=planted-by-another-port; ${cookie}`;
    const list = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie: both,
      'x-shellpuppet-csrf': proof,
    }));
    expect(list.status).toBe(200);
    expect(list.body).toContain(id);
    const alone = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie: 'sp_dash=planted-by-another-port',
      'x-shellpuppet-csrf': proof,
    }));
    expect(alone.status).toBe(401);
    const garbled = await raw(daemon.port, 'GET', '/sessions', readHeaders({
      cookie: `sp_dash=%zz; ${cookie}`,
      'x-shellpuppet-csrf': proof,
    }));
    expect(garbled.status).toBe(200);

    const upgrade = await connectFeed(daemon.port, both, proof);
    upgrade.close();
    const refused = await upgradeStatus(daemon.port, '/dashboard/events', eventsHeaders(daemon.port, 'sp_dash=planted-by-another-port', {
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    }));
    expect(refused.status).toBe(401);
  });
});

describe('the cookie does not open the routes outside this step', () => {
  it('refuses shutdown, screenshot, start, viewer mint, environment, kill, the stream and /events', async () => {
    const daemon = await startDash();
    const id = await startQuiet(daemon, 'closed-routes');
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const authed = readHeaders({ cookie, 'x-shellpuppet-csrf': proof });

    const shutdown = await raw(daemon.port, 'POST', '/daemon/shutdown', authed, '{}');
    expect(shutdown.status).toBe(401);
    const shot = await raw(daemon.port, 'POST', `/sessions/${id}/screenshot`, authed, '{}');
    expect(shot.status).toBe(401);
    const start = await raw(daemon.port, 'POST', '/sessions', {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ command: process.execPath, shell: false }));
    expect(start.status).toBe(401);
    const viewer = await raw(daemon.port, 'POST', `/sessions/${id}/viewer`, authed, '{}');
    expect(viewer.status).toBe(401);
    const environment = await raw(daemon.port, 'GET', '/environment', authed);
    expect(environment.status).toBe(401);
    const killed = await raw(daemon.port, 'DELETE', `/sessions/${id}`, authed);
    expect(killed.status).toBe(401);
    expect(await sessionIds(daemon)).toContain(id);

    const typed = await raw(daemon.port, 'POST', `/sessions/${id}/input`, {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ text: 'echo secret' }));
    expect(typed.status).toBe(401);
    const key = await raw(daemon.port, 'POST', `/sessions/${id}/key`, {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ key: 'enter' }));
    expect(key.status).toBe(401);

    const stream = await upgradeStatus(daemon.port, `/sessions/${id}/stream`, eventsHeaders(daemon.port, cookie, {
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    }));
    expect(stream.status).toBe(401);
    const events = await upgradeStatus(daemon.port, '/events', eventsHeaders(daemon.port, cookie, {
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    }));
    expect(events.status).toBe(401);
    const eventsToken = await upgradeStatus(daemon.port, `/events?token=${daemon.token}`);
    expect(eventsToken.status).toBe(101);

    const environmentAsClient = await api(daemon.port, daemon.token, '/environment');
    expect(environmentAsClient.status).toBe(200);
  });

  it('a client token can still shut the daemon down, and the cookie cannot', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const refused = await raw(daemon.port, 'POST', '/daemon/shutdown', readHeaders({
      cookie,
      'x-shellpuppet-csrf': proof,
    }), '{}');
    expect(refused.status).toBe(401);
    const health = await api(daemon.port, null, '/health');
    expect(health.status).toBe(200);
    const stopped = await api(daemon.port, daemon.token, '/daemon/shutdown', { method: 'POST', body: {} });
    expect(stopped.status).toBe(200);
  });
});

describe('/dashboard/events', () => {
  it('refuses an otherwise valid upgrade whose Sec-Fetch-Mode is cors', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const upgrade = await upgradeStatus(
      daemon.port,
      '/dashboard/events',
      eventsHeaders(daemon.port, cookiePair(page.headers), {
        'sec-fetch-mode': 'cors',
        'sec-websocket-protocol': `sp-csrf.${csrfMeta(page.body) ?? ''}`,
      }),
    );
    expect(upgrade.status).toBe(403);
    expect(upgrade.protocol).toBeUndefined();
  });

  it('echoes no subprotocol offered on /events or a session stream', async () => {
    const daemon = await startDash();
    const id = await startQuiet(daemon, 'protocol-echo');
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const offered = `sp-csrf.${csrfMeta(page.body) ?? ''}`;
    const events = await upgradeStatus(daemon.port, `/events?token=${daemon.token}`, {
      'sec-websocket-protocol': offered,
    });
    expect(events.status).toBe(101);
    expect(events.protocol).toBeUndefined();
    const stream = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream?token=${daemon.token}`,
      { 'sec-websocket-protocol': offered },
    );
    expect(stream.status).toBe(101);
    expect(stream.protocol).toBeUndefined();
  });

  it('is cookie-only and outbound only, and /events is unchanged', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';

    const byToken = await upgradeStatus(daemon.port, `/dashboard/events?token=${daemon.token}`);
    expect(byToken.status).toBe(401);

    const before = await sessionIds(daemon);
    const feed = await connectFeed(daemon.port, cookie, proof);
    await eventually(() => feed.frames.some((frame) => frame['type'] === 'snapshot'));
    feed.send('echo planted-keystroke');
    feed.send(JSON.stringify({ type: 'resize', cols: 40, rows: 12 }));
    feed.send(JSON.stringify({ type: 'launch', profile: 'shell' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await sessionIds(daemon)).toEqual(before);

    const id = await startQuiet(daemon, 'feed-added');
    await eventually(() => feed.frames.some((frame) =>
      frame['type'] === 'session-added' &&
      (frame['session'] as { id?: string } | undefined)?.id === id));
    const addedAt = feed.frames.findIndex((frame) =>
      frame['type'] === 'session-added' &&
      (frame['session'] as { id?: string } | undefined)?.id === id);
    expect(feed.frames.slice(0, addedAt).some((frame) =>
      frame['type'] === 'session-updated' &&
      (frame['session'] as { id?: string } | undefined)?.id === id)).toBe(false);
    const cols = await api(daemon.port, daemon.token, `/sessions/${id}`);
    expect(cols.status).toBe(404);
    const snapshot = await api(daemon.port, daemon.token, `/sessions/${id}/snapshot`);
    expect(snapshot.body['cols']).not.toBe(40);
    feed.close();
  });

  it('sends hello, a snapshot, then one removal, and a late joiner sees a prompt', async () => {
    const home = makeTempHome('dash-feed-');
    const urls: string[] = [];
    const daemon = await startTestDaemon({
      home,
      audit: createAuditor(home),
      policy: { mode: 'allow-all' },
      promptScanIntervalMs: 50,
      promptStallMs: 400,
      idleCheckIntervalMs: 40,
      exitedGraceMs: 80,
      launcher: (url) => {
        urls.push(url);
        return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
      },
    });
    const wrapped = Object.assign(daemon, { urls, logPath: path.join(home, 'daemon.log'), clock: { now: 0 } });
    running.push(wrapped);

    const open = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
    expect(open.status).toBe(200);
    const grant = new URL(urls[0] ?? '').searchParams.get('dt') ?? '';
    const page = await raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, navigationHeaders());
    const cookie = cookiePair(page.headers);
    const proof = csrfMeta(page.body) ?? '';
    const feed = await connectFeed(daemon.port, cookie, proof);
    await eventually(() => feed.frames[0]?.['type'] === 'hello' && feed.frames[1]?.['type'] === 'snapshot');
    expect(feed.frames[0]?.['version']).toBe((await api(daemon.port, null, '/health')).body['version']);

    const id = await startQuiet(daemon, 'ordered');
    await eventually(() => feed.frames.some((frame) => frame['type'] === 'session-added' &&
      (frame['session'] as { id?: string }).id === id));
    const resized = await api(daemon.port, daemon.token, `/sessions/${id}/resize`, { body: { cols: 70, rows: 20 } });
    expect(resized.status).toBe(200);
    await eventually(() => feed.frames.some((frame) => frame['type'] === 'session-updated' &&
      (frame['session'] as { id?: string }).id === id));
    const added = feed.frames.findIndex((frame) => frame['type'] === 'session-added' &&
      (frame['session'] as { id?: string }).id === id);
    const updated = feed.frames.findIndex((frame) => frame['type'] === 'session-updated' &&
      (frame['session'] as { id?: string }).id === id);
    expect(added).toBeGreaterThanOrEqual(0);
    expect(updated).toBeGreaterThan(added);

    await api(daemon.port, daemon.token, `/sessions/${id}`, { method: 'DELETE' });
    await eventually(() => feed.frames.filter((frame) => frame['type'] === 'session-removed' && frame['session'] === id).length === 1);

    const events = new WebSocket(`ws://127.0.0.1:${String(daemon.port)}/events?token=${daemon.token}`);
    const eventFrames: Record<string, unknown>[] = [];
    events.on('message', (data: Buffer | string) => {
      eventFrames.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      events.on('open', () => resolve());
      events.on('error', reject);
    });

    const script = [
      "console.log(' Permission Required');",
      "console.log(' Allow this command to run?');",
      "console.log('  \\u276F 1. Allow once');",
      "console.log('    2. No');",
      'setInterval(() => {}, 200);',
    ].join(' ');
    const prompting = await api(daemon.port, daemon.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', script],
        shell: false,
        openViewer: false,
        label: 'prompting-on-events',
      },
    });
    const promptId = String(prompting.body['id']);
    await eventually(() => eventFrames.some((frame) => frame['type'] === 'prompt-stall' && frame['session'] === promptId), 10_000);
    const stall = eventFrames.find((frame) => frame['type'] === 'prompt-stall' && frame['session'] === promptId);
    expect(String(stall?.['question'])).toMatch(/allow this command/i);
    expect(stall?.['options']).toEqual(['1. Allow once', '2. No']);
    expect(feed.frames.some((frame) => frame['type'] === 'prompt-stall')).toBe(false);

    const late = await connectFeed(daemon.port, cookie, proof);
    await eventually(() => late.frames.some((frame) => frame['type'] === 'snapshot' &&
      Array.isArray(frame['sessions']) &&
      (frame['sessions'] as { id: string; waitingOnPrompt?: unknown }[]).some((session) =>
        session.id === promptId && session.waitingOnPrompt !== undefined)));
    late.close();
    feed.close();
    events.close();
  });

  it('a connected dashboard suppresses the per-session window, and a later start opens one', async () => {
    const daemon = await startDash({ maxSessions: 2 });
    const { grant } = await openDashboard(daemon);
    const page = await redeem(daemon, grant);
    const feed = await connectFeed(daemon.port, cookiePair(page.headers), csrfMeta(page.body) ?? '');
    await eventually(() => feed.frames.some((frame) => frame['type'] === 'hello'));
    const before = daemon.urls.length;
    const first = await api(daemon.port, daemon.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        label: 'no-window',
      },
    });
    expect(first.status).toBe(200);
    expect(first.body['viewerUrl']).toBeUndefined();
    expect(JSON.stringify(first.body)).not.toContain('/view?');
    expect(daemon.urls).toHaveLength(before);

    feed.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await api(daemon.port, daemon.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        label: 'with-window',
      },
    });
    expect(second.status).toBe(200);
    expect(second.body['viewerUrl']).toBeUndefined();
    expect(daemon.urls.length).toBe(before + 1);
    expect(daemon.urls.at(-1)).toContain('/view?');
    expect(daemon.urls.at(-1)).toContain('vt=');

    const third = await api(daemon.port, daemon.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        openViewer: false,
      },
    });
    expect(third.status).toBe(403);
    expect(await sessionIds(daemon)).toHaveLength(2);
  });
});

describe('audit', () => {
  it('records the mint and the redemption, and a refusal, without the grant', async () => {
    const daemon = await startDash();
    const { grant } = await openDashboard(daemon);
    await redeem(daemon, grant);
    const refused = await raw(daemon.port, 'GET', '/dashboard', {
      ...navigationHeaders('none'),
      origin: 'http://evil.example',
      cookie: 'sp_dash=nope',
    });
    expect(refused.status).toBe(403);
    const auditPath = path.join(daemon.home, 'audit.log');
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      actor: string;
      action: string;
      meta?: Record<string, unknown>;
    });
    expect(lines.some((line) => line.action === 'grant-mint')).toBe(true);
    expect(lines.some((line) => line.action === 'grant-redeem' && line.actor === 'dashboard')).toBe(true);
    expect(lines.some((line) => line.action === 'refuse' && line.actor === 'dashboard')).toBe(true);
    const written = textsOf(daemon.home, daemon.logPath);
    expect(written).not.toContain(grant);
    expect(written).not.toContain('/dashboard?');
    expect(written).not.toContain('dt=');
  });
});
