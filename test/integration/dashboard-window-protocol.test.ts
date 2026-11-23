/** The daemon owns the dashboard window roster and pane assignments. */
import { expect, it, vi } from 'vitest';
import * as http from 'node:http';
import WebSocket from 'ws';
import * as auth from '../../src/daemon/auth.js';
import { api, eventually, startTestDaemon } from './helpers.js';

type State = { type: 'window-state'; designated: string; windows: string[]; assignments: Record<string, string[]>; move?: { before?: string } };
const pair = (id: string, instance: string) => JSON.stringify([id, instance]);
const navigation = (port: number, route: string, site: string, cookie = ''): Promise<{
  status: number; headers: http.IncomingHttpHeaders; body: string }> => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers: {
    host: `127.0.0.1:${String(port)}`, 'sec-fetch-site': site,
    'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...(cookie ? { cookie } : {}),
  } }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8') }));
  });
  request.on('error', reject);
  request.end();
});

type Peer = { ws: WebSocket; states: State[]; pair: string };
interface Fixture {
  authorise: () => Promise<void>;
  openDocument: () => Promise<void>;
  socket: (route: string) => WebSocket;
  connect: (id: string, instance: string) => Promise<Peer>;
  closedLaunch: (source: string) => Promise<Response>;
  sessionId: string;
}
async function withDashboard(check: (fixture: Fixture) => Promise<void>) {
  const urls: string[] = [];
  const daemon = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const sockets: WebSocket[] = [];
  try {
    const session = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false, openViewer: false,
    } });
    expect(session.status).toBe(200);
    const sessionId = String(session.body['id']);
    let cookie = '';
    let proof: string | undefined;
    const openDocument = async () => {
      const page = await navigation(daemon.port, '/dashboard', 'same-origin', cookie);
      proof = /<meta name="sp-csrf" content="([^"]*)">/.exec(page.body)?.[1];
      expect(proof).toBeTruthy();
    };
    const authorise = async () => {
      expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
      const grantUrl = new URL(urls.at(-1)!);
      const grant = await navigation(daemon.port, grantUrl.pathname + grantUrl.search, 'none');
      expect(grant.status).toBe(303);
      cookie = grant.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
      expect(cookie).toContain('sp_dash=');
      await openDocument();
    };
    await authorise();
    const socket = (route: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(daemon.port)}${route}`, [`sp-csrf.${proof}`], {
        headers: { cookie, origin: `http://127.0.0.1:${String(daemon.port)}`,
          'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket' },
      });
      sockets.push(ws);
      return ws;
    };
    const connect = async (id: string, instance: string) => {
      const ws = socket('/dashboard/events');
      const states: State[] = [];
      ws.on('message', (raw) => {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
        const frame = JSON.parse(bytes.toString('utf8')) as State;
        if (frame.type === 'window-state') states.push(frame);
      });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ type: 'window-register', id, instance }));
      await eventually(() => states.length > 0, 10_000);
      return { ws, states, pair: pair(id, instance) };
    };
    const closedLaunch = (source: string) => fetch(`http://127.0.0.1:${String(daemon.port)}/dashboard/launch`, {
      method: 'POST',
      headers: { cookie, origin: `http://127.0.0.1:${String(daemon.port)}`,
        'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors',
        'x-shellpuppet-csrf': proof!, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'lead', window: source }),
    });
    await check({ sessionId, socket, connect, authorise, openDocument, closedLaunch });
  } finally {
    for (const ws of sockets) ws.terminate();
    await daemon.stop();
  }
}

it('compares the launching document with the registered window in constant time', () =>
  withDashboard(async ({ connect, openDocument, closedLaunch }) => {
    const owner = await connect('owner-window', 'i-first');
    await openDocument();
    const neighbour = await connect('next-window', 'i-next');
    const compared = vi.spyOn(auth, 'tokensEqual');
    try {
      expect((await closedLaunch(owner.pair)).status).toBe(409);
      expect(compared).toHaveBeenCalledWith(owner.ws.protocol, neighbour.ws.protocol);
    } finally { compared.mockRestore(); }
  }), 120_000);

it('compares the document proofs in constant time when offering and redirecting a grid', () =>
  withDashboard(async ({ sessionId, socket, connect, openDocument }) => {
    const owner = await connect('owner-window', 'i-first');
    const pane = socket(`/sessions/${sessionId}/stream`);
    const geometry: Record<string, unknown>[] = [];
    pane.on('message', (data: Buffer, binary) => {
      if (binary) return;
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (frame.type === 'geometry') geometry.push(frame);
    });
    await eventually(() => geometry.length > 0);
    pane.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30, take: true }));
    await eventually(() => geometry.at(-1)?.control === 'yours');
    await openDocument();
    const next = await connect('next-window', 'i-next');
    const compared = vi.spyOn(auth, 'tokensEqual');
    try {
      pane.send(JSON.stringify({ type: 'release-grid' }));
      await eventually(() => geometry.at(-1)?.dashboardTransferable === true);
      expect(compared).toHaveBeenCalledWith(owner.ws.protocol, pane.protocol);
      compared.mockClear();
      next.ws.send(JSON.stringify({ type: 'window-move', session: sessionId, source: owner.pair, target: next.pair }));
      await eventually(() => geometry.at(-1)?.dashboardTransferable === false);
      expect(compared).toHaveBeenCalledWith(owner.ws.protocol, next.ws.protocol);
    } finally { compared.mockRestore(); }
  }), 120_000);

it('accepts moves only from the recorded owner and reassigns a closed window', () =>
  withDashboard(async ({ connect, sessionId, closedLaunch }) => {
    const first = await connect('first-window', 'i-first');
    expect(first.states.at(-1)).toMatchObject({ designated: first.pair,
      assignments: { [first.pair]: [sessionId] } });
    const second = await connect('second-window', 'i-second');
    await eventually(() => first.states.at(-1)?.windows.length === 2, 10_000);
    expect(second.states.at(-1)?.assignments[second.pair] ?? []).toEqual([]);

    second.ws.send(JSON.stringify({ type: 'window-move', session: sessionId,
      source: first.pair, target: second.pair }));
    await eventually(() => second.states.at(-1)?.assignments[second.pair]?.includes(sessionId) === true, 10_000);
    expect(second.states.at(-1)?.assignments[first.pair]).toEqual([]);

    const before = first.states.length;
    first.ws.send(JSON.stringify({ type: 'window-move', session: sessionId,
      source: first.pair, target: first.pair }));
    first.ws.send(JSON.stringify({ type: 'window-focus' }));
    await eventually(() => first.states.length > before, 10_000);
    expect(first.states.at(-1)?.assignments[second.pair]).toEqual([sessionId]);

    const third = await connect('third-window', 'i-third');
    await eventually(() => first.states.at(-1)?.windows.length === 3, 10_000);
    const thirdPartyMove = first.states.length;
    third.ws.send(JSON.stringify({ type: 'window-move', session: sessionId,
      source: second.pair, target: first.pair }));
    third.ws.send(JSON.stringify({ type: 'window-focus' }));
    await eventually(() => first.states.length > thirdPartyMove, 10_000);
    expect(first.states.at(-1)?.assignments[second.pair]).toEqual([sessionId]);
    second.ws.send(JSON.stringify({ type: 'window-designate' }));
    await eventually(() => first.states.at(-1)?.designated === second.pair, 10_000);
    const focusedAt = first.states.length;
    first.ws.send(JSON.stringify({ type: 'window-focus' }));
    await eventually(() => first.states.length > focusedAt, 10_000);
    second.ws.close();
    await eventually(() => first.states.at(-1)?.windows.length === 2, 10_000);
    expect(first.states.at(-1)).toMatchObject({ designated: first.pair,
      assignments: { [first.pair]: [sessionId] } });
    expect(first.states.at(-1)?.assignments[second.pair]).toBeUndefined();
    expect(first.states.at(-1)?.assignments[third.pair] ?? []).toEqual([]);
    expect((await closedLaunch(second.pair)).status).toBe(409);
  }), 120_000);

it('removes the previous credential before assigning the replacement window', () =>
  withDashboard(async ({ authorise, connect, sessionId }) => {
    const old = await connect('old-window', 'i-old');
    await authorise();
    const next = await connect('next-window', 'i-next');
    expect(next.states.at(-1)).toMatchObject({ windows: [next.pair], designated: next.pair,
      assignments: { [next.pair]: [sessionId] } });
    await eventually(() => old.ws.readyState === WebSocket.CLOSED);
  }), 120_000);

it('keeps all twelve documents connected and their panes assigned as windows open', () =>
  withDashboard(async ({ openDocument, connect, sessionId }) => {
    const first = await connect('first-window', 'i-first');
    const peers = [first];
    for (let index = 2; index <= 12; index++) {
      await openDocument();
      const peer = await connect(`window-${index}`, `instance-${index}`);
      peers.push(peer);
      expect(peer.states.at(-1)).toMatchObject({ windows: peers.map(p => p.pair),
        designated: first.pair, assignments: { [first.pair]: [sessionId] } });
    }
    expect(peers.every(peer => peer.ws.readyState === WebSocket.OPEN)).toBe(true);
  }), 120_000);

it('keeps the original window and its session through repeated reloads of a neighbour', () =>
  withDashboard(async ({ openDocument, connect, sessionId }) => {
    const first = await connect('first-window', 'i-first');
    for (let index = 0; index < 10; index++) {
      await openDocument();
      const neighbour = await connect('second-window', `instance-${index}`);
      expect(neighbour.states.at(-1)).toMatchObject({ windows: [first.pair, neighbour.pair],
        designated: first.pair, assignments: { [first.pair]: [sessionId] } });
      neighbour.ws.close();
      await eventually(() => first.states.at(-1)?.windows.length === 1);
    }
  }), 120_000);

it('prefers the focused survivor to a later background registration', () =>
  withDashboard(async ({ connect }) => {
    const designated = await connect('first-window', 'i-first');
    const focused = await connect('focused-window', 'i-focused');
    const count = focused.states.length;
    focused.ws.send(JSON.stringify({ type: 'window-focus' }));
    await eventually(() => focused.states.length > count);
    await connect('background-window', 'i-background');
    designated.ws.close();
    await eventually(() => focused.states.at(-1)?.windows.includes(designated.pair) === false);
    expect(focused.states.at(-1)?.designated).toBe(focused.pair);
  }), 120_000);

it('acknowledges an append when the requested anchor is absent', () =>
  withDashboard(async ({ connect, sessionId }) => {
    const source = await connect('first-window', 'i-first');
    const target = await connect('second-window', 'i-second');
    target.ws.send(JSON.stringify({ type: 'window-move', source: source.pair, target: target.pair,
      session: sessionId, before: 'departed-pane' }));
    await eventually(() => target.states.at(-1)?.assignments[target.pair]?.includes(sessionId) === true);
    expect(target.states.at(-1)?.move).toEqual({ target: target.pair, session: sessionId });
  }), 120_000);
