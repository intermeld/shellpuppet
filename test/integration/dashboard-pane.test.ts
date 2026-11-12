/**
 * Dashboard pane protocol (design §5, §5.1).
 *
 * A dashboard stream carries `sp_dash` and the `sp-csrf` subprotocol.
 * The dashboard credential is always passive, whatever the query says.
 * `take: true` is its only resize. `drive=0` is the opt-out for a viewer
 * or client-token socket, and `drive=false` is not a spelling.
 * The single-session viewer is unchanged. A read-only viewer cookie is not
 * a dashboard credential. The echoed subprotocol names the dashboard
 * credential, not a client token that also offers the proof.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAuditor } from '../../src/daemon/audit.js';
import {
  api,
  connectWs,
  connectWsWithCookie,
  eventually,
  makeTempHome,
  redeemViewerUrl,
  startTestDaemon,
} from './helpers.js';
import type { TestDaemon } from './helpers.js';

interface AuditLine {
  actor: string;
  action: string;
  session?: string;
  meta?: Record<string, unknown>;
}

interface PaneDaemon extends TestDaemon {
  urls: string[];
}

interface PaneClient {
  protocol: string;
  controls: () => Record<string, unknown>[];
  send: (data: string) => void;
  close: () => void;
  waitForControl: (
    predicate: (control: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
}

const ECHO = [
  'process.stdin.setRawMode?.(true);',
  'process.stdin.resume();',
  "process.stdout.write('ECHO READY\\r\\n');",
  "process.stdin.on('data', (b) => process.stdout.write('GOT[' + b.toString('utf8') + ']\\r\\n'));",
  'setInterval(() => {}, 1000);',
].join('\n');

const running: PaneDaemon[] = [];

afterEach(async () => {
  const pending = running.splice(0);
  await Promise.all(pending.map((daemon) => daemon.stop()));
}, 120_000);

async function startPane(): Promise<PaneDaemon> {
  const home = makeTempHome('dash-pane-');
  const urls: string[] = [];
  const daemon = await startTestDaemon({
    home,
    audit: createAuditor(home),
    policy: { mode: 'allow-all' },
    promptScanIntervalMs: 600_000,
    idleCheckIntervalMs: 600_000,
    launcher: (url) => {
      urls.push(url);
      return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
    },
  });
  const wrapped = Object.assign(daemon, { urls });
  running.push(wrapped);
  return wrapped;
}

function auditOf(home: string): AuditLine[] {
  const file = path.join(home, 'audit.log');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text === '') return [];
  return text.split('\n').map((line) => JSON.parse(line) as AuditLine);
}

function raw(
  port: number,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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

function csrfMeta(html: string): string {
  const match = /<meta name="sp-csrf" content="([^"]*)">/.exec(html);
  return match?.[1] ?? '';
}

async function startGrid(daemon: PaneDaemon, label: string, echo = false): Promise<string> {
  const started = await api(daemon.port, daemon.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', echo ? ECHO : 'setInterval(() => {}, 200)'],
      shell: false,
      openViewer: false,
      label,
      cols: 120,
      rows: 34,
    },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return String(started.body['id']);
}

async function openDashboard(daemon: PaneDaemon): Promise<{ cookie: string; proof: string }> {
  const before = daemon.urls.length;
  const opened = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
  expect(opened.status).toBe(200);
  expect(daemon.urls).toHaveLength(before + 1);
  const grant = new URL(daemon.urls.at(-1) ?? '').searchParams.get('dt') ?? '';
  // One navigation spends the grant. A second fetch would find it already redeemed.
  const redeemed = await raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-site': 'none',
  });
  expect(redeemed.status).toBe(303);
  const cookie = (headerList(redeemed.headers['set-cookie'])[0] ?? '').split(';')[0] ?? '';
  const page = await raw(daemon.port, 'GET', '/dashboard', {
    'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin', cookie,
  });
  expect(page.status).toBe(200);
  const proof = csrfMeta(page.body);
  expect(cookie).toMatch(/^sp_dash=/);
  expect(proof).toMatch(/^[0-9a-f]{64}$/);
  return { cookie, proof };
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

function streamHeaders(port: number, cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    cookie,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'websocket',
    ...extra,
  };
}

function connectDash(
  port: number,
  sessionId: string,
  cookie: string,
  proof: string,
  query = 'drive=0',
): Promise<PaneClient> {
  return new Promise((resolve, reject) => {
    const suffix = query === '' ? '' : `?${query}`;
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/sessions/${sessionId}/stream${suffix}`,
      [`sp-csrf.${proof}`],
      { headers: streamHeaders(port, cookie) },
    );
    const controls: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) return;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      try {
        controls.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // A non-JSON text frame is terminal bytes, not a control.
      }
    });
    const poll = (
      predicate: (control: Record<string, unknown>) => boolean,
      timeoutMs: number,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolvePoll, rejectPoll) => {
        const startedAt = Date.now();
        const check = (): void => {
          const found = controls.find(predicate);
          if (found !== undefined) {
            resolvePoll(found);
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            rejectPoll(new Error('WS did not receive a matching control message in time'));
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });
    ws.on('open', () => {
      resolve({
        protocol: ws.protocol,
        controls: () => controls,
        send: (data) => ws.send(data),
        close: () => ws.close(),
        waitForControl: (predicate, timeoutMs = 15_000) => poll(predicate, timeoutMs),
      });
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`dashboard stream refused with ${String(response.statusCode)}`));
    });
    ws.on('error', reject);
  });
}

async function gridOf(daemon: PaneDaemon, id: string): Promise<{ cols: number; rows: number; screen: string }> {
  const snapshot = await api(daemon.port, daemon.token, `/sessions/${id}/snapshot`);
  expect(snapshot.status).toBe(200);
  return {
    cols: Number(snapshot.body['cols']),
    rows: Number(snapshot.body['rows']),
    screen: String(snapshot.body['screen']),
  };
}

it('transfers a dashboard grid only after its controller releases it', async () => {
  const daemon = await startPane();
  const id = await startGrid(daemon, 'window-transfer');
  const heldId = await startGrid(daemon, 'held-transfer');
  const foreignId = await startGrid(daemon, 'foreign-transfer');
  const { cookie, proof } = await openDashboard(daemon);
  const sockets: { close: () => void }[] = [];
  try {
    const first = await connectDash(daemon.port, id, cookie, proof);
    sockets.push(first);
    first.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31, take: true }));
    await first.waitForControl(frame => frame.type === 'geometry' && frame.control === 'yours' && frame.cols === 101);

    const second = await connectDash(daemon.port, id, cookie, proof);
    sockets.push(second);
    const adopted = await second.waitForControl(frame => frame.type === 'geometry' && frame.cols === 101);
    expect(adopted).toMatchObject({ control: 'adopt', owned: true, dashboardTransferable: false });
    second.send(JSON.stringify({ type: 'release-grid' }));
    first.send(JSON.stringify({ type: 'resize', cols: 102, rows: 32, take: true }));
    const stillOwned = await second.waitForControl(frame => frame.type === 'geometry' && frame.cols === 102);
    expect(stillOwned).toMatchObject({ control: 'adopt', dashboardTransferable: false });

    first.send(JSON.stringify({ type: 'release-grid' }));
    const offered = await second.waitForControl(frame => frame.type === 'geometry' &&
      frame.cols === 102 && frame.dashboardTransferable === true);
    expect(offered).toMatchObject({ control: 'adopt', owned: true });
    second.send(JSON.stringify({ type: 'resize', cols: 103, rows: 33, take: true }));
    const taken = await second.waitForControl(frame => frame.type === 'geometry' && frame.cols === 103);
    expect(taken).toMatchObject({ control: 'yours', dashboardTransferable: false });

    expect((await api(daemon.port, daemon.token, `/sessions/${heldId}/resize`,
      { body: { cols: 120, rows: 34, hold: true } })).status).toBe(200);
    const held = await connectDash(daemon.port, heldId, cookie, proof);
    sockets.push(held);
    expect(await held.waitForControl(frame => frame.type === 'geometry')).toMatchObject({
      control: 'held', dashboardTransferable: false,
    });
    const beforeRefusal = held.controls().length;
    held.send(JSON.stringify({ type: 'resize', cols: 110, rows: 30, take: true }));
    await eventually(() => held.controls().length > beforeRefusal, 10_000);
    expect(held.controls().at(-1)).toMatchObject({ type: 'geometry', control: 'held', cols: 120 });
    expect((await gridOf(daemon, heldId))).toMatchObject({ cols: 120, rows: 34 });

    const viewer = await connectWs(daemon.port, foreignId, daemon.token);
    sockets.push(viewer);
    await viewer.waitForControl(frame => frame.type === 'geometry' && frame.control === 'yours');
    const other = await connectDash(daemon.port, foreignId, cookie, proof);
    sockets.push(other);
    expect(await other.waitForControl(frame => frame.type === 'geometry')).toMatchObject({
      control: 'adopt', owned: true, dashboardTransferable: false,
    });
  } finally {
    for (const socket of sockets) socket.close();
  }
}, 120_000);

it('keeps a follower on the human grid when the controller socket drops', async () => {
  const daemon = await startPane();
  const id = await startGrid(daemon, 'dropped-controller');
  const { cookie, proof } = await openDashboard(daemon);
  const first = await connectDash(daemon.port, id, cookie, proof);
  const follower = await connectDash(daemon.port, id, cookie, proof);
  try {
    first.send(JSON.stringify({ type: 'resize', cols: 178, rows: 52, take: true }));
    await first.waitForControl(frame => frame.type === 'geometry' && frame.control === 'yours' && frame.cols === 178);
    await follower.waitForControl(frame => frame.type === 'geometry' && frame.control === 'adopt' && frame.cols === 178);
    first.close();
    await eventually(() => !(daemon.daemon as unknown as { geometryController: Map<string, unknown> })
      .geometryController.has(id), 10_000);
    expect(follower.controls().filter(frame => frame.type === 'geometry').at(-1)).toMatchObject({
      cols: 178, rows: 52, control: 'adopt', dashboardTransferable: false,
    });
    expect(await gridOf(daemon, id)).toMatchObject({ cols: 178, rows: 52 });
    const page = await raw(daemon.port, 'GET', '/dashboard', {
      'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin', cookie,
    });
    expect(page.status).toBe(200);
    const newcomer = await connectDash(daemon.port, id, cookie, csrfMeta(page.body));
    try {
      expect(await newcomer.waitForControl(frame => frame.type === 'geometry')).toMatchObject({
        cols: 178, rows: 52, control: 'adopt', owned: true, dashboardTransferable: false,
      });
    } finally { newcomer.close(); }
    const restored = await connectDash(daemon.port, id, cookie, proof);
    try {
      expect(await restored.waitForControl(frame => frame.type === 'geometry')).toMatchObject({
        cols: 178, rows: 52, control: 'yours', dashboardTransferable: false,
      });
      expect(follower.controls().filter(frame => frame.type === 'geometry').at(-1))
        .toMatchObject({ control: 'adopt', dashboardTransferable: false });
    } finally { restored.close(); }
  } finally { first.close(); follower.close(); }
}, 120_000);

it('does not offer a transferred grid after the original controller returns', async () => {
  const daemon = await startPane();
  const id = await startGrid(daemon, 'restored-controller');
  const { cookie, proof } = await openDashboard(daemon);
  const first = await connectDash(daemon.port, id, cookie, proof);
  const follower = await connectDash(daemon.port, id, cookie, proof);
  try {
    first.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31, take: true }));
    await first.waitForControl(frame => frame.type === 'geometry' && frame.control === 'yours' && frame.cols === 101);
    await follower.waitForControl(frame => frame.type === 'geometry' && frame.control === 'adopt' && frame.cols === 101);
    first.send(JSON.stringify({ type: 'release-grid' }));
    await follower.waitForControl(frame => frame.type === 'geometry' && frame.dashboardTransferable === true);
    first.close();
    await eventually(() => !(daemon.daemon as unknown as { geometryController: Map<string, unknown> })
      .geometryController.has(id), 10_000);
    const restored = await connectDash(daemon.port, id, cookie, proof);
    try {
      expect(await restored.waitForControl(frame => frame.type === 'geometry')).toMatchObject({
        control: 'yours', dashboardTransferable: false,
      });
      await eventually(() => follower.controls().filter(frame => frame.type === 'geometry').at(-1)
        ?.dashboardTransferable === false, 10_000);
      const later = await connectDash(daemon.port, id, cookie, proof);
      try {
        expect(await later.waitForControl(frame => frame.type === 'geometry')).toMatchObject({
          cols: 101, rows: 31, control: 'adopt', dashboardTransferable: false,
        });
      } finally { later.close(); }
    } finally { restored.close(); }
  } finally { first.close(); follower.close(); }
}, 120_000);

function resizes(home: string, id: string): AuditLine[] {
  return auditOf(home).filter((line) => line.action === 'resize' && line.session === id);
}

describe('drive=0 does not take the grid', () => {
  it('adopts 120 by 34, ignores a resize without take, and does not inherit the controller', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'passive-pane');
    const { cookie, proof } = await openDashboard(daemon);
    const planted = `sp_dash=planted-by-another-port; ${cookie}`;
    const pane = await connectDash(daemon.port, id, planted, proof);
    expect(pane.protocol).toBe(`sp-csrf.${proof}`);
    const geometry = await pane.waitForControl((control) => control['type'] === 'geometry');
    expect(geometry['control']).toBe('adopt');
    expect(geometry['cols']).toBe(120);
    expect(geometry['rows']).toBe(34);

    pane.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stayed = await gridOf(daemon, id);
    expect(stayed.cols).toBe(120);
    expect(stayed.rows).toBe(34);
    expect(pane.controls().filter((control) => control['type'] === 'geometry')).toEqual([geometry]);
    expect(resizes(daemon.home, id)).toEqual([]);
    expect(auditOf(daemon.home).some((line) => line.action === 'input' && line.session === id)).toBe(false);

    const driver = await connectWs(daemon.port, id, daemon.token);
    const driving = await driver.waitForControl((control) => control['type'] === 'geometry');
    expect(driving['control']).toBe('yours');
    const closes = (): number =>
      auditOf(daemon.home).filter((line) => line.action === 'ws-close' && line.session === id).length;
    const closedBefore = closes();
    driver.close();
    await eventually(() => closes() > closedBefore);

    const next = await connectWs(daemon.port, id, daemon.token);
    const inherited = await next.waitForControl((control) => control['type'] === 'geometry');
    expect(inherited['control']).toBe('yours');
    expect(pane.controls().some((control) => control['type'] === 'geometry' && control['control'] === 'yours')).toBe(
      false,
    );
    const after = await gridOf(daemon, id);
    expect(after.cols).toBe(120);
    expect(after.rows).toBe(34);
    expect(resizes(daemon.home, id)).toEqual([]);
    next.close();
    pane.close();
  });
});

describe('a dashboard stream is passive without drive=0', () => {
  it('adopts on connect, ignores a plain resize, and take still changes the grid', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'passive-without-drive');
    const { cookie, proof } = await openDashboard(daemon);

    const pane = await connectDash(daemon.port, id, cookie, proof, '');
    expect(pane.protocol).toBe(`sp-csrf.${proof}`);
    const geometry = await pane.waitForControl((control) => control['type'] === 'geometry');
    expect(geometry['control']).toBe('adopt');
    expect(geometry['cols']).toBe(120);
    expect(geometry['rows']).toBe(34);

    pane.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stayed = await gridOf(daemon, id);
    expect(stayed.cols).toBe(120);
    expect(stayed.rows).toBe(34);
    expect(pane.controls().filter((control) => control['type'] === 'geometry')).toEqual([geometry]);
    expect(resizes(daemon.home, id)).toEqual([]);

    pane.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40, take: true }));
    const took = await pane.waitForControl(
      (control) => control['type'] === 'geometry' && control['cols'] === 100 && control['control'] === 'yours',
    );
    expect(took['rows']).toBe(40);
    await eventually(async () => (await gridOf(daemon, id)).cols === 100);
    const changed = await gridOf(daemon, id);
    expect(changed).toMatchObject({ cols: 100, rows: 40 });
    const lines = resizes(daemon.home, id);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.actor).toBe('dashboard');
    expect(lines[0]?.meta).toMatchObject({ cols: 100, rows: 40, hold: false });
    const closes = (): number =>
      auditOf(daemon.home).filter((line) => line.action === 'ws-close' && line.session === id).length;
    const closedBefore = closes();
    pane.close();
    await eventually(() => closes() > closedBefore);

    // The same document keeps its grid when a covered pane reconnects.
    // The query still cannot widen a dashboard credential, and a plain
    // resize still does not move the grid.
    const forced = await connectDash(daemon.port, id, cookie, proof, 'drive=1');
    const again = await forced.waitForControl((control) => control['type'] === 'geometry');
    expect(again['control']).toBe('yours');
    expect(again['cols']).toBe(100);
    expect(again['rows']).toBe(40);
    forced.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const held = await gridOf(daemon, id);
    expect(held).toMatchObject({ cols: 100, rows: 40 });
    expect(resizes(daemon.home, id)).toHaveLength(1);
    forced.close();
  });

  it('keeps the assigned dashboard as driver through a covered pane and lets another window take it', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'two-windows');
    const first = await openDashboard(daemon);
    const secondPage = await raw(daemon.port, 'GET', '/dashboard', {
      'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin',
      cookie: first.cookie,
    });
    expect(secondPage.status).toBe(200);
    const second = { cookie: first.cookie, proof: csrfMeta(secondPage.body) };
    const original = await connectDash(daemon.port, id, first.cookie, first.proof);
    await original.waitForControl((frame) => frame['type'] === 'geometry');
    original.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40, take: true }));
    await original.waitForControl((frame) => frame['type'] === 'geometry' && frame['control'] === 'yours');
    original.close();
    await eventually(() => auditOf(daemon.home).filter((line) => line.action === 'ws-close' && line.session === id).length > 0);

    const other = await connectDash(daemon.port, id, second.cookie, second.proof);
    expect((await other.waitForControl((frame) => frame['type'] === 'geometry'))['control']).toBe('adopt');
    const restored = await connectDash(daemon.port, id, first.cookie, first.proof);
    expect((await restored.waitForControl((frame) => frame['type'] === 'geometry'))['control']).toBe('yours');
    expect(resizes(daemon.home, id)).toHaveLength(1);

    other.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40, take: true }));
    await other.waitForControl((frame) => frame['type'] === 'geometry' && frame['control'] === 'yours');
    await restored.waitForControl((frame) => frame['type'] === 'geometry' && frame['control'] === 'adopt');
    other.close();
    restored.close();
  });

  it('forgets a dashboard controller when its programme exits naturally', async () => {
    const daemon = await startPane();
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', "setTimeout(() => process.exit(0), 1500)"],
      shell: false, openViewer: false, cols: 120, rows: 34,
    } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const { cookie, proof } = await openDashboard(daemon);
    const first = await connectDash(daemon.port, id, cookie, proof);
    await first.waitForControl((frame) => frame['type'] === 'geometry');
    first.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40, take: true }));
    await first.waitForControl((frame) => frame['type'] === 'geometry' && frame['control'] === 'yours');
    first.close();
    await eventually(async () => (await api(daemon.port, daemon.token, `/sessions/${id}/snapshot`)).body['exited'] === true);
    const reconnect = await connectDash(daemon.port, id, cookie, proof);
    expect((await reconnect.waitForControl((frame) => frame['type'] === 'geometry'))['control']).toBe('adopt');
    reconnect.close();
  });

  it('acknowledges a current controller taking its existing grid', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'same-size-take');
    const { cookie, proof } = await openDashboard(daemon);
    const pane = await connectDash(daemon.port, id, cookie, proof);
    await pane.waitForControl((frame) => frame['type'] === 'geometry');
    pane.send(JSON.stringify({ type: 'resize', cols: 120, rows: 34, take: true }));
    await pane.waitForControl((frame) => frame['type'] === 'geometry' && frame['control'] === 'yours');
    pane.send(JSON.stringify({ type: 'resize', cols: 120, rows: 34, take: true }));
    await pane.waitForControl((frame) => frame['type'] === 'geometry' && frame['control'] === 'yours' &&
      pane.controls().filter((item) => item['type'] === 'geometry').length === 3);
    expect(resizes(daemon.home, id)).toEqual([]);
    pane.close();
  });
});

describe('the echoed subprotocol names the dashboard credential', () => {
  it('a client token selects no protocol even when the cookie and a live proof are offered', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'echo-credential');
    const { cookie, proof } = await openDashboard(daemon);
    const protocol = { 'sec-websocket-protocol': `sp-csrf.${proof}` };

    const client = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream?token=${daemon.token}`,
      streamHeaders(daemon.port, cookie, protocol),
    );
    expect(client.status).toBe(101);
    expect(client.protocol).toBeUndefined();

    const dashboard = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream`,
      streamHeaders(daemon.port, cookie, protocol),
    );
    expect(dashboard.status).toBe(101);
    expect(dashboard.protocol).toBe(`sp-csrf.${proof}`);
  });
});

describe('Fit, Enlarge and Restore are the resize', () => {
  it('restores the grid but preserves a departed dashboard owner for reconnect', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'wider-dashboard-departure');
    const { cookie, proof } = await openDashboard(daemon);
    const passive = await connectWs(daemon.port, id, daemon.token, {}, { drive: false });
    await passive.waitForControl(c => c['type'] === 'geometry');
    const pane = await connectDash(daemon.port, id, cookie, proof);
    pane.send(JSON.stringify({ type: 'resize', cols: 120, rows: 34, take: true }));
    await pane.waitForControl(c => c['type'] === 'geometry' && c['control'] === 'yours');
    const pending = api(daemon.port, daemon.token, `/sessions/${id}/snapshot?wider=140x40&widerTimeout=1000`);
    await passive.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140 && c['temporary'] === true);
    pane.close();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body['restored']).toBe(true);
    expect(await passive.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 120 && c['temporary'] !== true))
      .toMatchObject({ rows: 34, control: 'adopt', owned: false });
    const remembered = await connectDash(daemon.port, id, cookie, proof);
    expect(await remembered.waitForControl(c => c['type'] === 'geometry')).toMatchObject({
      cols: 120, rows: 34, control: 'yours', owned: true,
    });
    remembered.close();
    passive.close();
  });

  it.each(['dashboard take', 'viewer resize', 'pop-out handover'])('keeps a %s made during a wider read', async (action) => {
    const daemon = await startPane();
    const id = await startGrid(daemon, `wider-${action.replace(' ', '-')}`);
    const { cookie, proof } = await openDashboard(daemon);
    const viewer = await connectWs(daemon.port, id, daemon.token);
    expect(await viewer.waitForControl(c => c['type'] === 'geometry')).toMatchObject({ control: 'yours' });
    const pane = await connectDash(daemon.port, id, cookie, proof);
    expect(await pane.waitForControl(c => c['type'] === 'geometry')).toMatchObject({ control: 'adopt' });
    if (action === 'pop-out handover') {
      pane.send(JSON.stringify({ type: 'resize', cols: 120, rows: 34, take: true }));
      await pane.waitForControl(c => c['type'] === 'geometry' && c['control'] === 'yours');
    }
    const pending = api(daemon.port, daemon.token, `/sessions/${id}/snapshot?wider=140x40&widerTimeout=1000`);
    await pane.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140 && c['temporary'] === true);
    let popped: PaneClient | undefined;
    if (action === 'dashboard take') pane.send(JSON.stringify({ type: 'resize', cols: 140, rows: 40, take: true }));
    else if (action === 'viewer resize') viewer.ws.send(JSON.stringify({ type: 'resize', cols: 150, rows: 45 }));
    else {
      pane.close();
      popped = await connectDash(daemon.port, id, cookie, proof);
      popped.send(JSON.stringify({ type: 'resize', cols: 150, rows: 45, take: true }));
      await popped.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 150 && c['control'] === 'yours');
    }
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body['restored']).toBe(false);
    expect(await gridOf(daemon, id)).toMatchObject(action === 'dashboard take'
      ? { cols: 140, rows: 40 } : { cols: 150, rows: 45 });
    if (action === 'dashboard take') {
      expect(await pane.waitForControl(c => c['type'] === 'geometry' && c['control'] === 'yours' && c['cols'] === 140))
        .toMatchObject({ rows: 40 });
    }
    viewer.close();
    pane.close();
    popped?.close();
  });

  it('take changes the PTY, tells every watcher, restores, and clamps above 400 by 150', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'take-pane');
    const { cookie, proof } = await openDashboard(daemon);
    const watcher = await connectWs(daemon.port, id, daemon.token);
    await watcher.waitForControl((control) => control['type'] === 'geometry' && control['control'] === 'yours');
    const pane = await connectDash(daemon.port, id, cookie, proof);
    await pane.waitForControl((control) => control['type'] === 'geometry' && control['control'] === 'adopt');

    pane.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40, take: true }));
    const took = await pane.waitForControl(
      (control) => control['type'] === 'geometry' && control['cols'] === 100 && control['control'] === 'yours',
    );
    const told = await watcher.waitForControl(
      (control) => control['type'] === 'geometry' && control['cols'] === 100 && control['control'] === 'adopt',
    );
    expect(took['rows']).toBe(40);
    expect(told['rows']).toBe(40);
    await eventually(async () => (await gridOf(daemon, id)).cols === 100);
    const changed = await gridOf(daemon, id);
    expect(changed).toMatchObject({ cols: 100, rows: 40 });
    const first = resizes(daemon.home, id);
    expect(first).toHaveLength(1);
    expect(first[0]?.actor).toBe('dashboard');
    expect(first[0]?.meta).toMatchObject({ cols: 100, rows: 40, hold: false });

    pane.send(JSON.stringify({ type: 'resize', cols: 120, rows: 34, take: true }));
    await eventually(async () => (await gridOf(daemon, id)).cols === 120);
    const restored = await gridOf(daemon, id);
    expect(restored).toMatchObject({ cols: 120, rows: 34 });
    await watcher.waitForControl(
      (control) => control['type'] === 'geometry' && control['cols'] === 120 && control['control'] === 'adopt',
    );

    pane.send(JSON.stringify({ type: 'resize', cols: 480, rows: 180, take: true }));
    const clamped = await pane.waitForControl(
      (control) => control['type'] === 'geometry' && control['cols'] === 400 && control['control'] === 'yours',
    );
    expect(clamped['rows']).toBe(150);
    await watcher.waitForControl(
      (control) => control['type'] === 'geometry' && control['cols'] === 400 && control['rows'] === 150,
    );
    await eventually(async () => (await gridOf(daemon, id)).cols === 400);
    const wide = await gridOf(daemon, id);
    expect(wide).toMatchObject({ cols: 400, rows: 150 });
    const lines = resizes(daemon.home, id);
    expect(lines.map((line) => line.actor)).toEqual(['dashboard', 'dashboard', 'dashboard']);
    expect(lines[2]?.meta).toMatchObject({ cols: 400, rows: 150, hold: false });
    watcher.close();
    pane.close();
  });
});

describe('the single-session viewer still drives as it does today', () => {
  it('a first read-write viewer becomes the controller and a resize without take applies', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'viewer-drives');
    const minted = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, { body: {} });
    expect(minted.status).toBe(200);
    const cookie = await redeemViewerUrl(String(minted.body['viewerUrl']));
    const viewer = await connectWsWithCookie(daemon.port, id, cookie);
    const geometry = await viewer.waitForControl((control) => control['type'] === 'geometry');
    expect(geometry['control']).toBe('yours');
    viewer.ws.send(JSON.stringify({ type: 'resize', cols: 96, rows: 28 }));
    await eventually(async () => (await gridOf(daemon, id)).cols === 96);
    const resized = await gridOf(daemon, id);
    expect(resized).toMatchObject({ cols: 96, rows: 28 });
    const lines = resizes(daemon.home, id);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.actor).toBe('viewer');
    viewer.close();
  });

  it('drive=false is not a passive spelling, so the first read-write viewer still drives', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'drive-false-spelling');
    // connectWs places this string after `token=`. The hex token contains no
    // `&`, so the query is `token=<client>&drive=false`.
    const viewer = await connectWs(daemon.port, id, `${daemon.token}&drive=false`);
    const geometry = await viewer.waitForControl((control) => control['type'] === 'geometry');
    expect(geometry['control']).toBe('yours');
    viewer.close();
  });

  it('a read-only viewer never drives, and take does not promote it', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'viewer-readonly', true);
    const { proof } = await openDashboard(daemon);
    const minted = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, { body: { readOnly: true } });
    expect(minted.status).toBe(200);
    const cookie = await redeemViewerUrl(String(minted.body['viewerUrl']));
    const viewer = await connectWsWithCookie(daemon.port, id, cookie);
    const identity = await viewer.waitForControl((control) => control['type'] === 'identity');
    expect(identity['readOnly']).toBe(true);
    const geometry = await viewer.waitForControl((control) => control['type'] === 'geometry');
    expect(geometry['control']).toBe('adopt');
    await eventually(async () => (await gridOf(daemon, id)).screen.includes('ECHO READY'));

    viewer.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }));
    viewer.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30, take: true }));
    viewer.ws.send('ro-secret');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stayed = await gridOf(daemon, id);
    expect(stayed.cols).toBe(120);
    expect(stayed.rows).toBe(34);
    expect(stayed.screen).not.toContain('ro-secret');
    expect(resizes(daemon.home, id)).toEqual([]);
    expect(auditOf(daemon.home).some((line) => line.action === 'input' && line.session === id)).toBe(false);

    // A live proof without sp_dash is not a dashboard credential either.
    const offered = await upgradeStatus(daemon.port, `/sessions/${id}/stream`, streamHeaders(daemon.port, cookie, {
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    }));
    expect(offered.status).toBe(101);
    expect(offered.protocol).not.toBe(`sp-csrf.${proof}`);
    viewer.close();
  });
});

describe('the dashboard types', () => {
  it('sends a key on the stream and audits actor dashboard', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'dash-types', true);
    const { cookie, proof } = await openDashboard(daemon);
    const pane = await connectDash(daemon.port, id, cookie, proof);
    expect(pane.protocol).toBe(`sp-csrf.${proof}`);
    await eventually(async () => (await gridOf(daemon, id)).screen.includes('ECHO READY'));
    pane.send('dash-key');
    await eventually(async () => (await gridOf(daemon, id)).screen.includes('GOT[dash-key]'));
    await eventually(() =>
      auditOf(daemon.home).some(
        (line) => line.action === 'input' && line.actor === 'dashboard' && line.session === id,
      ),
    );
    const input = auditOf(daemon.home).filter((line) => line.action === 'input' && line.session === id);
    expect(input.every((line) => line.actor === 'dashboard')).toBe(true);
    expect(input[0]?.meta?.['chars']).toBe('dash-key'.length);
    pane.close();
  });
});

describe('a read-only link does not become the dashboard', () => {
  it('launch with only the read-only viewer cookie starts nothing', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'viewer-launch');
    const minted = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, { body: { readOnly: true } });
    const cookie = await redeemViewerUrl(String(minted.body['viewerUrl']));
    const before = await api(daemon.port, daemon.token, '/sessions');
    const launch = await raw(daemon.port, 'POST', '/dashboard/launch', {
      cookie,
      origin: `http://127.0.0.1:${String(daemon.port)}`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'content-type': 'application/json',
    }, JSON.stringify({ profile: 'shell' }));
    expect(launch.status).toBe(401);
    const after = await api(daemon.port, daemon.token, '/sessions');
    expect(after.body['sessions']).toEqual(before.body['sessions']);
  });
});

describe('stream refusals', () => {
  it('refuses a stream without the proof, with only the header, or with a wrong proof', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'proof-refused');
    const { cookie, proof } = await openDashboard(daemon);
    const flipped = proof.endsWith('a') ? `${proof.slice(0, 63)}b` : `${proof.slice(0, 63)}a`;

    const missing = await upgradeStatus(daemon.port, `/sessions/${id}/stream`, streamHeaders(daemon.port, cookie));
    expect(missing.status).toBe(403);
    const headerOnly = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream`,
      streamHeaders(daemon.port, cookie, { 'x-shellpuppet-csrf': proof }),
    );
    expect(headerOnly.status).toBe(403);
    const wrong = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream`,
      streamHeaders(daemon.port, cookie, { 'sec-websocket-protocol': `sp-csrf.${flipped}` }),
    );
    expect(wrong.status).toBe(403);
    expect(auditOf(daemon.home).filter((line) => line.action === 'ws-connect' && line.session === id)).toEqual([]);
  });

  it('refuses a foreign Origin, a same-site port, and a missing Origin', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'origin-refused');
    const { cookie, proof } = await openDashboard(daemon);
    const protocol = { 'sec-websocket-protocol': `sp-csrf.${proof}` };

    const foreign = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream`,
      streamHeaders(daemon.port, cookie, {
        ...protocol,
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
      }),
    );
    expect(foreign.status).toBe(403);
    const sameSite = await upgradeStatus(
      daemon.port,
      `/sessions/${id}/stream`,
      streamHeaders(daemon.port, cookie, {
        ...protocol,
        origin: `http://127.0.0.1:${String(daemon.port + 1)}`,
        'sec-fetch-site': 'same-site',
      }),
    );
    expect(sameSite.status).toBe(403);
    const absent = await upgradeStatus(daemon.port, `/sessions/${id}/stream`, {
      cookie,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'websocket',
      ...protocol,
    });
    expect(absent.status).toBe(403);
    expect(auditOf(daemon.home).filter((line) => line.action === 'ws-connect' && line.session === id)).toEqual([]);
  });

  it("a viewer cookie for another session is refused, and it is not a dashboard credential", async () => {
    const daemon = await startPane();
    const here = await startGrid(daemon, 'scope-here');
    const there = await startGrid(daemon, 'scope-there');
    const { proof } = await openDashboard(daemon);
    const minted = await api(daemon.port, daemon.token, `/sessions/${there}/viewer`, { body: { readOnly: true } });
    const cookie = await redeemViewerUrl(String(minted.body['viewerUrl']));
    const refused = await upgradeStatus(
      daemon.port,
      `/sessions/${here}/stream`,
      streamHeaders(daemon.port, cookie, { 'sec-websocket-protocol': `sp-csrf.${proof}` }),
    );
    expect(refused.status).toBe(401);
    expect(auditOf(daemon.home).some((line) => line.action === 'input' && line.session === here)).toBe(false);
  });
});

describe('the cookie still opens nothing else', () => {
  it('leaves shutdown, screenshot, start, viewer mint, environment, HTTP input, HTTP key and /events shut, kills with one DELETE, and starts no unknown profile', async () => {
    const daemon = await startPane();
    const id = await startGrid(daemon, 'closed-routes');
    const { cookie, proof } = await openDashboard(daemon);
    const authed = {
      cookie,
      origin: `http://127.0.0.1:${String(daemon.port)}`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'x-shellpuppet-csrf': proof,
    };

    expect((await raw(daemon.port, 'POST', '/daemon/shutdown', authed, '{}')).status).toBe(401);
    expect((await raw(daemon.port, 'POST', `/sessions/${id}/screenshot`, authed, '{}')).status).toBe(401);
    expect((await raw(daemon.port, 'POST', '/sessions', {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ command: process.execPath, shell: false }))).status).toBe(401);
    expect((await raw(daemon.port, 'POST', `/sessions/${id}/viewer`, authed, '{}')).status).toBe(401);
    expect((await raw(daemon.port, 'GET', '/environment', authed)).status).toBe(401);
    expect((await raw(daemon.port, 'POST', `/sessions/${id}/input`, {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ text: 'echo secret' }))).status).toBe(401);
    expect((await raw(daemon.port, 'POST', `/sessions/${id}/key`, {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ key: 'enter' }))).status).toBe(401);
    // Launch is an existing dashboard route; this daemon has no such profile.
    expect((await raw(daemon.port, 'POST', '/dashboard/launch', {
      ...authed,
      'content-type': 'application/json',
    }, JSON.stringify({ profile: 'shell' }))).status).toBe(400);
    const events = await upgradeStatus(daemon.port, '/events', streamHeaders(daemon.port, cookie, {
      'sec-websocket-protocol': `sp-csrf.${proof}`,
    }));
    expect(events.status).toBe(401);

    const health = await api(daemon.port, null, '/health');
    expect(health.status).toBe(200);
    const killed = await raw(daemon.port, 'DELETE', `/sessions/${id}`, authed);
    expect(killed.status).toBe(200);
    const list = await api(daemon.port, daemon.token, '/sessions');
    const ids = ((list.body['sessions'] as { id: string }[] | undefined) ?? []).map((session) => session.id);
    expect(ids).toEqual([]);
  });
});

describe('a remembered dashboard grid stays with its dashboard while the socket is away', () => {
  for (const kind of ['client', 'viewer'] as const) {
    it(`a ${kind} socket that arrives follows it until a deliberate resize`, async () => {
      const daemon = await startPane();
      const id = await startGrid(daemon, `remembered-${kind}`);
      const { cookie, proof } = await openDashboard(daemon);
      const owner = await connectDash(daemon.port, id, cookie, proof);
      owner.send(JSON.stringify({ type: 'resize', cols: 178, rows: 52, take: true }));
      await owner.waitForControl((frame) => frame['type'] === 'geometry' && frame['control'] === 'yours' &&
        frame['cols'] === 178);
      owner.close();
      await eventually(() => !(daemon.daemon as unknown as { geometryController: Map<string, unknown> })
        .geometryController.has(id), 10_000);
      let arrival;
      if (kind === 'client') {
        arrival = await connectWs(daemon.port, id, daemon.token);
      } else {
        const minted = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, { body: {} });
        arrival = await connectWsWithCookie(daemon.port, id, await redeemViewerUrl(String(minted.body['viewerUrl'])));
      }
      try {
        expect(await arrival.waitForControl((frame) => frame['type'] === 'geometry')).toMatchObject({
          cols: 178, rows: 52, control: 'adopt',
        });
        // A resize the arriving page sends is its deliberate act, and still wins.
        arrival.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
        await eventually(async () => (await gridOf(daemon, id)).cols === 100);
        expect(await arrival.waitForControl((frame) => frame['type'] === 'geometry' &&
          frame['control'] === 'yours')).toMatchObject({ cols: 100, rows: 30 });
      } finally { arrival.close(); }
    }, 120_000);
  }
});
