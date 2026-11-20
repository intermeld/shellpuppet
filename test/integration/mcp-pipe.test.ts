import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { readDaemonState } from '../../src/daemon/paths.js';
import { api, eventually, makeTempHome, removeTempHome, repoRoot, startTestDaemon } from './helpers.js';

type Status = 'connected' | 'closed' | 'failed';
type Reply = { id: number; result?: { isError?: boolean; content?: unknown }; error?: unknown };

async function withManagedAdapter(
  refuse: (status: Status, attempt: number) => boolean,
  test: (fixture: {
    startAdapter: () => Promise<{ child: ChildProcessWithoutNullStreams; list: () => Promise<void>; breakOutput: () => void }>;
    report: (adapter: string, status: Status) => Promise<void>;
    attempts: Status[];
    events: string[];
    stalled: () => Promise<unknown>;
  }) => Promise<void>,
) {
  const td = await startTestDaemon();
  const adapterHome = makeTempHome();
  const state = readDaemonState(td.home)!;
  const attempts: Status[] = [];
  const events: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const socket = new WebSocket('ws://127.0.0.1:' + td.port + '/events?token=' + td.token);
  const proxy = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/session/mcp-connection') {
        const { status } = JSON.parse(body) as { status: Status };
        attempts.push(status);
        if (refuse(status, attempts.filter(entry => entry === status).length)) {
          res.writeHead(503, { 'content-type': 'application/json' }).end('{}');
          return;
        }
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && (key === 'authorization' || key === 'content-type' || key.startsWith('x-shellpuppet-'))) headers[key] = value;
      }
      const upstream = await fetch('http://127.0.0.1:' + td.port + req.url, { method: req.method!, headers, ...(body ? { body } : {}) });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    })().catch(() => res.writeHead(502).end());
  });
  try {
    await once(socket, 'open');
    const identity = join(td.home, 'child-identity');
    const script = "require('node:fs').writeFileSync(process.argv[1], process.env.SHELLPUPPET_SESSION_TOKEN); setInterval(() => {}, 1000)";
    const started = await api(td.port, td.token, '/sessions', { body: { command: process.execPath, shell: false,
      args: ['-e', script, identity], openViewer: false } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(() => existsSync(identity) && readFileSync(identity, 'utf8').length > 0);
    const proof = readFileSync(identity, 'utf8');
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { type: string; session: string };
      if (message.session === id && ['session-stalled', 'session-stall-clear'].includes(message.type)) events.push(message.type);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    writeFileSync(join(adapterHome, 'daemon.json'), JSON.stringify({ ...state, port: (proxy.address() as AddressInfo).port }));
    const startAdapter = async () => {
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'mcp', 'index.js')], {
        windowsHide: true, stdio: 'pipe', env: { ...process.env, SHELLPUPPET_HOME: adapterHome,
          SHELLPUPPET_SESSION: id, SHELLPUPPET_SESSION_TOKEN: proof, SHELLPUPPET_DAEMON_INSTANCE: state.instanceId },
      });
      children.push(child);
      child.stderr.resume();
      child.stdin.on('error', () => {});
      const replies = new Map<number, Reply>();
      createInterface({ input: child.stdout }).on('line', line => {
        const reply = JSON.parse(line) as Reply;
        replies.set(reply.id, reply);
      });
      let sequence = 0;
      const send = (method: string, params: object, id?: number) =>
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
      const call = async (method: string, params: object) => {
        const id = ++sequence;
        send(method, params, id);
        await eventually(() => replies.has(id), 8000, 25, method + ' reply');
        const reply = replies.get(id)!;
        expect(reply.error).toBeUndefined();
        return reply;
      };
      await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pipe-test', version: '1' } });
      send('notifications/initialized', {});
      return { child, list: async () => {
        const reply = await call('tools/call', { name: 'terminal_list', arguments: {} });
        expect(reply.result?.isError).not.toBe(true);
        expect(JSON.stringify(reply.result?.content)).toContain(id);
      },
        breakOutput: () => {
          child.stdout.destroy();
          // Keep stdin open so the server must write its reply to the broken pipe.
          send('tools/list', {}, ++sequence);
        } };
    };
    const report = async (adapter: string, status: Status) => {
      const response = await api(td.port, td.token, '/session/mcp-connection', { body: { adapter, status },
        headers: { 'x-shellpuppet-session': id, 'x-shellpuppet-session-token': proof } });
      expect(response.status).toBe(200);
    };
    const stalled = async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return (listed.body['sessions'] as { id: string; stalled?: unknown }[]).find(session => session.id === id)?.stalled;
    };
    await test({ startAdapter, attempts, events, report, stalled });
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    }
    socket.close();
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await td.stop();
    removeTempHome(adapterHome);
  }
}

it('retries a refused handshake registration even when the adapter has no tools in flight', async () => {
  await withManagedAdapter((status, count) => status === 'connected' && count === 1, async ({ startAdapter, attempts }) => {
    await startAdapter();
    await eventually(() => attempts.filter(status => status === 'connected').length === 2);
  });
});

it('counts an answering replacement while its registration receives 503', async () => {
  await withManagedAdapter(status => status === 'connected', async ({ startAdapter, attempts, report, events, stalled }) => {
    const old = randomUUID();
    await report(old, 'connected');
    const working = await startAdapter();
    await working.list();
    expect(attempts).toContain('connected');
    await report(old, 'failed');
    await working.list();
    expect(await stalled()).toBeUndefined();
    expect(events).toEqual([]);
  });
});

it('retires a cleanly closed adapter after a refused close so the last failure is visible', async () => {
  await withManagedAdapter((status, count) => status === 'closed' && count === 1, async ({ startAdapter, attempts, report, events, stalled }) => {
    const closing = await startAdapter();
    await closing.list();
    await eventually(() => attempts.includes('connected'));
    const exited = once(closing.child, 'exit');
    closing.child.stdin.end();
    await exited;
    const remaining = randomUUID();
    await report(remaining, 'connected');
    await report(remaining, 'failed');
    expect.soft(attempts.filter(status => status === 'closed')).toHaveLength(2);
    expect(await stalled()).toMatchObject({ reason: 'mcp-connection-lost' });
    await eventually(() => events.includes('session-stalled'));
  });
});

it('reports a native broken output pipe to the daemon and clears the parent event on reconnect', async () => {
  await withManagedAdapter(() => false, async ({ startAdapter, attempts, events, stalled }) => {
    const first = await startAdapter();
    await first.list();
    await eventually(() => attempts.includes('connected'));
    first.breakOutput();
    await eventually(() => attempts.includes('failed') || attempts.includes('closed'), 6000, 25, 'native output pipe report');
    expect.soft(attempts).toContain('failed');
    await eventually(() => events.includes('session-stalled'), 6000, 25, 'broken pipe must publish session-stalled');
    expect(await stalled()).toMatchObject({ reason: 'mcp-connection-lost' });
    const replacement = await startAdapter();
    await replacement.list();
    await eventually(() => events.includes('session-stall-clear'));
    expect(await stalled()).toBeUndefined();
    expect(events).toEqual(['session-stalled', 'session-stall-clear']);
  });
});
