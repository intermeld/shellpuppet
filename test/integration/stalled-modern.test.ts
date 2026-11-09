import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { IPty } from 'node-pty';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { SessionManager } from '../../src/core/manager.js';

const run = promisify(execFile);
const modernCapture = readFileSync(new URL('../fixtures/stalls/modern-refusal.ansi', import.meta.url), 'utf8');

it('reports a sanitised modern refusal through the daemon, event, wait and input', async () => {
  const home = makeTempHome('modern-stall-');
  const td = await startTestDaemon({ home, promptScanIntervalMs: 50 });
  let output: (data: string) => void = () => {};
  let typed = '';
  const pty = {
    pid: 777777, cols: 96, rows: 30, process: 'synthetic', handleFlowControl: false,
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
      body: { command: process.execPath, shell: false, agent: 'mimo', cols: 96, rows: 30 },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const waited = run(process.execPath, [
      `${repoRoot}/dist/cli/index.js`, 'wait', id, '--stalled', '--timeout', '5000', '--json',
    ], { env: { ...process.env, SHELLPUPPET_HOME: home }, windowsHide: true, timeout: 7000 });
    output(modernCapture);
    const waitResult = JSON.parse((await waited).stdout) as Record<string, unknown>;
    expect(waitResult).toMatchObject({ matched: true, reason: 'stalled' });
    const list = await run(process.execPath, [`${repoRoot}/dist/cli/index.js`, 'list'], {
      env: { ...process.env, SHELLPUPPET_HOME: home }, windowsHide: true, timeout: 7000,
    });
    expect(list.stdout).toContain('STALLED provider-refused');
    await eventually(() => messages.some(message => message['type'] === 'session-stalled' && message['session'] === id));
    const input = await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'x' } });
    expect(input.body).toMatchObject({ ok: true });
    expect(typed).toBe('x');
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return !(listed.body['sessions'] as Record<string, unknown>[]).find(row => row['id'] === id)?.['stalled'];
    });
    expect(messages.some(message => message['type'] === 'session-stall-clear' && message['session'] === id)).toBe(true);
  } finally {
    events.close();
    await td.stop();
  }
});
