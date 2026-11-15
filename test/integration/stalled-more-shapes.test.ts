import type { IPty } from 'node-pty';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { SessionManager } from '../../src/core/manager.js';
import type { FeedFrame, SessionFeed } from '../../src/daemon/sessionFeed.js';
import { outputLimit } from '../fixtures/stalls/output-limit.mjs';
import { serverLost } from '../fixtures/stalls/server-lost.mjs';
import { clippedError } from '../fixtures/stalls/clipped-error.mjs';

it('clears the parent prompt alert when the dialog is still detectable beneath a settled banner', async () => {
  const td = await startTestDaemon({ promptScanIntervalMs: 50, promptStallMs: 0 });
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 777780, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
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
  const rows = Array.from({ length: 24 }, () => '');
  rows[11] = '  ┃  △ Permission required';
  rows[13] = '  ┃  $ example command';
  rows[20] = '  ┃   Allow once   Always allow   Reject';
  const prompt = '\x1b[2J\x1b[H' + rows.join('\r\n');
  const fixture = readFileSync(new URL('../fixtures/stalls/server-lost-over-permission.ansi', import.meta.url), 'utf8');
  try {
    events.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, shell: false, agent: 'opencode', cols: 80, rows: 24,
    } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    output(prompt);
    await eventually(() => messages.some(m => m['type'] === 'prompt-stall' && m['session'] === id));
    output(fixture + '\x1b[16;1H  ┃  △ Permission required\x1b[K');
    expect((await api(td.port, td.token, `/sessions/${id}/wait?stalled=true&timeout=5000`)).body)
      .toMatchObject({ matched: true, reason: 'stalled', stalled: { reason: 'server-lost' } });
    const stalledMatchedAt = Date.now();
    await eventually(() => messages.some(m => m['type'] === 'prompt-clear' && m['session'] === id), 250, 20);
    expect(Date.now() - stalledMatchedAt).toBeLessThan(300);
    const list = (await api(td.port, td.token, '/sessions')).body['sessions'] as Record<string, unknown>[];
    expect(list.find(s => s['id'] === id)?.['waitingOnPrompt']).toBeUndefined();
    output(prompt);
    await eventually(async () => {
      const listed = (await api(td.port, td.token, '/sessions')).body['sessions'] as Record<string, unknown>[];
      const row = listed.find(s => s['id'] === id);
      return row?.['stalled'] === undefined && row?.['waitingOnPrompt'] !== undefined;
    });
  } finally {
    events.close();
    await td.stop();
  }
});

it('puts a lost server above a live permission prompt in stalled state and restores waiting after reconnecting', async () => {
  const td = await startTestDaemon({ promptScanIntervalMs: 50, promptStallMs: 100 });
  const messages: Record<string, unknown>[] = [];
  const feedFrames: FeedFrame[] = [];
  const unsubscribe = (td.daemon as unknown as { sessionFeed: SessionFeed }).sessionFeed.subscribe(frame => feedFrames.push(frame));
  const events = new WebSocket(`ws://127.0.0.1:${td.port}/events?token=${td.token}`);
  let id: string | null = null;
  try {
    events.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [path.join(repoRoot, 'test/fixtures/stalls/replay-server-lost.mjs')],
      shell: false, agent: 'opencode', cols: 80, rows: 24,
    } });
    expect(started.status).toBe(200);
    id = String(started.body['id']);
    await eventually(async () => {
      const list = await api(td.port, td.token, '/sessions');
      return Boolean((list.body['sessions'] as Record<string, unknown>[]).find(s => s['id'] === id)?.['waitingOnPrompt']);
    }, 10_000);
    expect(feedFrames.some(frame => frame.type === 'session-updated' && frame.session.id === id &&
      frame.session.waitingOnPrompt !== undefined)).toBe(true);
    expect((await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=1000`)).body)
      .toMatchObject({ matched: true, reason: 'prompt' });
    await eventually(() => messages.some(m => m['type'] === 'prompt-stall' && m['session'] === id), 10_000);
    await api(td.port, td.token, `/sessions/${id}/key`, { body: { key: 'enter' } });
    const stalled = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&stalled=true&timeout=5000`);
    expect(stalled.body).toMatchObject({ matched: true, reason: 'stalled', stalled: { reason: 'server-lost' } });
    const listed = (await api(td.port, td.token, '/sessions')).body['sessions'] as Record<string, unknown>[];
    expect(listed.find(s => s['id'] === id)).toMatchObject({ stalled: { reason: 'server-lost' } });
    expect(listed.find(s => s['id'] === id)?.['waitingOnPrompt']).toBeUndefined();
    const waiting = (await api(td.port, td.token, '/sessions?waitingOnly=true')).body['sessions'] as Record<string, unknown>[];
    expect(waiting.some(s => s['id'] === id)).toBe(false);
    expect((await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=0`)).body)
      .toMatchObject({ matched: false, reason: 'timeout' });
    const across = await api(td.port, td.token, `/sessions/wait?prompt=true&stalled=true&session=${id}&timeout=1000`);
    expect(across.body).toMatchObject({ matched: true, reason: 'stalled' });
    await eventually(() => feedFrames.some(frame => frame.type === 'session-updated' &&
      frame.session.id === id && frame.session.stalled?.reason === 'server-lost' &&
      frame.session.waitingOnPrompt === undefined && frame.changed.includes('stalled')));
    await eventually(() => messages.some(m => m['type'] === 'session-stalled' && m['session'] === id));
    await eventually(() => messages.some(m => m['type'] === 'prompt-clear' && m['session'] === id));
    await eventually(async () => {
      const list = await api(td.port, td.token, '/sessions');
      const row = (list.body['sessions'] as Record<string, unknown>[]).find(s => s['id'] === id);
      return row?.['stalled'] === undefined && row?.['waitingOnPrompt'] !== undefined;
    }, 10_000);
    expect((await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=1000`)).body)
      .toMatchObject({ matched: true, reason: 'prompt' });
    await api(td.port, td.token, `/sessions/${id}/key`, { body: { key: 'enter' } });
  } finally {
    events.close();
    unsubscribe();
    if (id !== null) {
      try { await api(td.port, td.token, `/sessions/${id}/key`, { body: { key: 'enter' } }); } catch { /* Session may have exited. */ }
    }
    await td.stop();
  }
});

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
