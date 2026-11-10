import type { IPty } from 'node-pty';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { modernRefusal } from '../fixtures/stalls/modern-refusal.mjs';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { SessionManager } from '../../src/core/manager.js';
import { signatureFor, validateStall } from '../../src/core/reasoning.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function replay(startCols: number, end?: 'output' | 'input' | 'exit' | 'loss', endDuringShrink = false,
  lateClipped = false) {
  const td = await startTestDaemon({ home: makeTempHome('modern-resize-'), promptScanIntervalMs: 50 });
  let output: (data: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  const pty = {
    pid: 777778, cols: startCols, rows: 30, process: 'synthetic', handleFlowControl: false,
    onData(fn: typeof output) { output = fn; return { dispose() {} }; },
    onExit(fn: typeof exit) { exit = fn; return { dispose() {} }; },
    resize(cols: number, rows: number) { pty.cols = cols; pty.rows = rows; },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
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
      body: { command: process.execPath, shell: false, agent: 'mimo', cols: startCols, rows: 30 },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const session = manager.get(id)!;
    const states = [] as (ReturnType<typeof session.getStalled>)[];
    session.onStall(state => states.push(state));
    const stalled = async () => (await api(td.port, td.token, '/sessions')).body['sessions'] as Record<string, unknown>[];
    const current = async () => (await stalled()).find(row => row['id'] === id)?.['stalled'];
    output(modernRefusal({ cols: startCols }));
    await eventually(async () => await current() !== undefined);
    const first = session.getStalled();
    expect(first).toBeDefined();
    const move = async (cols: number, rows: number) => {
      const resized = await api(td.port, td.token, `/sessions/${id}/resize`, { body: { cols, rows } });
      expect(resized.status).toBe(200);
      output(modernRefusal({ cols }));
      await session.viewportLines();
    };
    await move(80, 24);
    if (endDuringShrink && end !== undefined) {
      await finish(end);
      return;
    }
    await sleep(1450);
    expect(session.getStalled()).toBe(first);
    expect(await current()).toEqual(first);
    expect(messages.filter(message => message['type'] === 'session-stalled' && message['session'] === id)).toHaveLength(1);
    expect(messages.filter(message => message['type'] === 'session-stall-clear' && message['session'] === id)).toHaveLength(0);
    if (lateClipped) {
      output('\x1b[3J' + modernRefusal({ cols: 80, visibleTurn: false }).replace('Example note', 'Revised note'));
      await session.viewportLines();
      const renderer = (session as unknown as { renderer: { styledLines(options: { above: number; extendWrapped: boolean }): { lines: never[]; firstVisible: number } } }).renderer;
      const styled = renderer.styledLines({ above: 128, extendWrapped: false });
      const candidate = validateStall(styled.lines, signatureFor('mimo', 'mimo')!, false, styled.firstVisible);
      expect(candidate).toMatchObject({ inconclusive: true });
      expect(styled.firstVisible).toBeGreaterThan(0);
      await sleep(400);
      expect(session.getStalled()).toBe(first);
      expect(states).toEqual([first]);
    }
    await move(startCols, 30);
    await sleep(1450);
    expect(session.getStalled()).toBe(first);
    expect(states).toEqual([first]);
    if (end !== undefined) await finish(end);

    async function finish(kind: 'output' | 'input' | 'exit' | 'loss') {
      const begun = performance.now();
      if (kind === 'input') await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'x' } });
      else if (kind === 'exit') exit({ exitCode: 0 });
      else if (kind === 'loss') output('\x1b[2J\x1b[H');
      else output(modernRefusal({ cols: startCols, panel: false }).replace('Neutral task output.', 'A newer answer.'));
      await eventually(() => session.getStalled() === undefined, 1500);
      expect(performance.now() - begun).toBeLessThan(1500);
      await eventually(() => messages.some(message => message['type'] === 'session-stall-clear' && message['session'] === id));
    }
  } finally {
    events.close();
    await td.stop();
  }
}

it.each([96, 120])('keeps one modern notice through %ix30 to 80x24 and back', async cols => {
  await replay(cols);
}, 15_000);

it('keeps a matching clipped refusal after the resize allowance', async () => {
  await replay(96, undefined, false, true);
}, 15_000);

it.each([
  ['input', true], ['loss', true], ['output', false], ['exit', false],
] as const)('clears a genuine %s during or after modern resize', async (end, during) => {
  await replay(96, end, during);
}, 15_000);
