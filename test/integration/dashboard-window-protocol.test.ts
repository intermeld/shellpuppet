/** The daemon owns the dashboard window roster and pane assignments. */
import { expect, it } from 'vitest';
import * as http from 'node:http';
import WebSocket from 'ws';
import { api, eventually, startTestDaemon } from './helpers.js';

type State = { type: 'window-state'; designated: string; windows: string[]; assignments: Record<string, string[]> };
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

it('accepts moves only from the recorded owner and reassigns a closed window', async () => {
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
    expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
    const grantUrl = new URL(urls.at(-1)!);
    const grant = await navigation(daemon.port, grantUrl.pathname + grantUrl.search, 'none');
    expect(grant.status).toBe(303);
    const cookie = grant.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
    expect(cookie).toContain('sp_dash=');
    const page = await navigation(daemon.port, '/dashboard', 'same-origin', cookie);
    const proof = /<meta name="sp-csrf" content="([^"]*)">/.exec(page.body)?.[1];
    expect(proof).toBeTruthy();
    const connect = async (id: string, instance: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(daemon.port)}/dashboard/events`, [`sp-csrf.${proof}`], {
        headers: { cookie, origin: `http://127.0.0.1:${String(daemon.port)}`,
          'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket' },
      });
      sockets.push(ws);
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
    const closedLaunch = await fetch(`http://127.0.0.1:${String(daemon.port)}/dashboard/launch`, {
      method: 'POST',
      headers: { cookie, origin: `http://127.0.0.1:${String(daemon.port)}`,
        'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors',
        'x-shellpuppet-csrf': proof!, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'lead', window: second.pair }),
    });
    expect(closedLaunch.status).toBe(409);
  } finally {
    for (const ws of sockets) ws.terminate();
    await daemon.stop();
  }
}, 120_000);
