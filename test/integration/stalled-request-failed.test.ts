import type { IPty } from 'node-pty';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { SessionManager } from '../../src/core/manager.js';
import { requestFailed } from '../fixtures/stalls/request-failed.mjs';

it('reports and clears a sanitised request failure through the daemon', async () => {
  const home = makeTempHome('request-stall-');
  const td = await startTestDaemon({ home, promptScanIntervalMs: 50 });
  let output: (data: string) => void = () => {};
  let typed = '';
  const pty = {
    pid: 777778, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), resize() {}, write(data: string) { typed += data; },
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
      body: { command: process.execPath, shell: false, agent: 'mimo', cols: 80, rows: 24 },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const waiting = api(td.port, td.token, `/sessions/${id}/wait?stalled=true&timeout=5000`);
    output(requestFailed());
    expect((await waiting).body).toMatchObject({ matched: true, reason: 'stalled',
      stalled: { reason: 'request-failed', description: 'The model request failed.' } });
    const list = await api(td.port, td.token, '/sessions');
    expect((list.body['sessions'] as Record<string, unknown>[]).find(row => row['id'] === id)?.['stalled'])
      .toMatchObject({ reason: 'request-failed' });
    await eventually(() => messages.some(message => message['type'] === 'session-stalled' && message['session'] === id));
    expect(JSON.stringify(messages.find(message => message['type'] === 'session-stalled'))).not.toContain('Example connection');
    const input = await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'x' } });
    expect(input.body).toMatchObject({ ok: true });
    expect(typed).toBe('x');
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return !(listed.body['sessions'] as Record<string, unknown>[]).find(row => row['id'] === id)?.['stalled'];
    });
    output(requestFailed({ failure: 'Example service unavailable.' }));
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return (listed.body['sessions'] as Record<string, unknown>[]).find(row => row['id'] === id)?.['stalled'] !== undefined;
    });
    output('\x1b[2J\x1b[H  ┃  Continue the example.\r\n     Working on it.\r\n   esc to interrupt');
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return (listed.body['sessions'] as Record<string, unknown>[]).find(row => row['id'] === id)?.['stalled'] === undefined;
    });
    expect(messages.filter(message => message['type'] === 'session-stall-clear' && message['session'] === id)).toHaveLength(2);
  } finally {
    events.close();
    await td.stop();
  }
});
