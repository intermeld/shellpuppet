import type { IPty } from 'node-pty';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { SessionManager } from '../../src/core/manager.js';
import { outputLimit } from '../fixtures/stalls/output-limit.mjs';
import { serverLost } from '../fixtures/stalls/server-lost.mjs';
import { clippedError } from '../fixtures/stalls/clipped-error.mjs';

for (const [agent, reason, screen] of [
  ['mimo', 'output-limit', outputLimit()],
  ['opencode', 'server-lost', serverLost()],
  ['mimo', 'error', clippedError()],
] as const) it(`reports and clears ${reason} through the daemon`, async () => {
  const home = makeTempHome('shape-stall-');
  const td = await startTestDaemon({ home, promptScanIntervalMs: 50 });
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 777779, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), resize() {}, write() {},
    clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const manager = (td.daemon as unknown as { manager: SessionManager }).manager;
  const deps = (manager as unknown as { sessionDeps: { spawn?: () => IPty; platform?: string; pidWaitMs?: number } }).sessionDeps;
  deps.spawn = () => pty;
  deps.platform = 'linux';
  deps.pidWaitMs = 0;
  const messages: Record<string, unknown>[] = [];
  const events = new WebSocket(`ws://127.0.0.1:${td.port}/events?token=${td.token}`);
  try {
    events.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, shell: false, agent, cols: 80, rows: 24 },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const waiting = api(td.port, td.token, `/sessions/${id}/wait?stalled=true&timeout=5000`);
    output(screen);
    expect((await waiting).body).toMatchObject({ matched: true, reason: 'stalled', stalled: { reason } });
    await eventually(() => messages.some(message => message['type'] === 'session-stalled' && message['session'] === id));
    const list = await api(td.port, td.token, '/sessions');
    expect((list.body['sessions'] as Record<string, unknown>[]).find(row => row['id'] === id)?.['stalled'])
      .toMatchObject({ reason });
    output('\x1b[2J\x1b[H  ┃  Continue the example.\r\n     Working on it.');
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return (listed.body['sessions'] as Record<string, unknown>[]).find(row => row['id'] === id)?.['stalled'] === undefined;
    });
    expect(messages.filter(message => message['type'] === 'session-stall-clear' && message['session'] === id)).toHaveLength(1);
  } finally {
    events.close();
    await td.stop();
  }
});
