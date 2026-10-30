/**
 * Every surface of a session whose output failed, read after node-pty has
 * recorded the code of the program the session ended
 * (a later viewer's identity frame and replayed notice, a refused keystroke,
 * the 409 on input, key and resize, snapshot, wait, list); the
 * `canReadExitCode` fail-safe of `programEnded`; and normal exits, which
 * still report their own code everywhere.
 */

import type * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import type { Session } from '../../src/core/session.js';
import { howSessionEnded, listedState } from '../../src/core/types.js';
import type { Logger } from '../../src/core/types.js';
import { api, connectWs, eventually, interactiveShell, processAlive, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const managers: SessionManager[] = [];
const daemons: TestDaemon[] = [];
afterEach(async () => {
  while (managers.length > 0) await managers.pop()?.killAll();
  while (daemons.length > 0) await daemons.pop()?.stop();
});

type Agent = { outSocket?: net.Socket; exitCode?: number; _useConpty?: boolean };
function agentOf(session: Session): Agent {
  const agent = (session as unknown as { pty: { _agent?: Agent } }).pty._agent;
  if (agent === undefined) throw new Error('no Windows agent on this terminal');
  return agent;
}

function sessionOf(td: TestDaemon, id: string): Session {
  const session = (td.daemon as unknown as { manager: SessionManager }).manager.get(id);
  if (session === undefined) throw new Error(`no session ${id}`);
  return session;
}

function failOutput(session: Session): void {
  const output = agentOf(session).outSocket;
  if (output === undefined) throw new Error('no output socket');
  output.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -4077, syscall: 'read' }));
}

const ignore = (): void => undefined;
const quiet: Logger = { debug: ignore, info: ignore, warn: ignore, error: ignore };

describe.skipIf(process.platform !== 'win32')('a session whose output failed', () => {
  it('reads the same on every surface after node-pty has recorded the code', async () => {
    const td = await startTestDaemon();
    daemons.push(td);
    const started = await api(td.port, td.token, '/sessions', { body: { ...interactiveShell(), cols: 80, rows: 24 } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const session = sessionOf(td, id);
    await eventually(() => session.getScreen().trim() !== '');

    failOutput(session);
    await eventually(() => session.exited, 10_000);
    await eventually(() => !processAlive(session.pid), 30_000);
    await eventually(() => agentOf(session).exitCode !== undefined, 30_000);
    expect(session.programEnded).toBe(true);

    // A viewer that joins only now.
    const late = await connectWs(td.port, id, td.token);
    try {
      const identity = await late.waitForControl((c) => c['type'] === 'identity');
      expect(identity).toMatchObject({ exited: true, exitCode: null });
      await late.waitForData('[session ended: its output failed]', 5_000);
      expect(late.received()).not.toContain('[process exited');
      late.ws.send('typed-after-the-end');
      const refused = await late.waitForControl((c) => c['type'] === 'input-refused');
      expect(refused).toMatchObject({ reason: 'exited', exitCode: null });
    } finally {
      late.close();
    }

    const ended = `Session ${id} has ended (its output failed) and no longer accepts input or geometry changes.`;
    const input = await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'x' } });
    const key = await api(td.port, td.token, `/sessions/${id}/key`, { body: { key: 'enter' } });
    const resize = await api(td.port, td.token, `/sessions/${id}/resize`, { body: { cols: 100, rows: 30 } });
    for (const refusal of [input, key, resize]) {
      expect(refusal.status).toBe(409);
      expect(refusal.body['error']).toBe(ended);
    }

    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`, { method: 'GET' });
    expect(snapshot.body).toMatchObject({ exited: true, exitCode: null });
    expect(howSessionEnded(snapshot.body['exitCode'] as number | null)).toBe('its output failed');

    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=never-on-screen&timeout=2000`, {
      method: 'GET',
    });
    expect(waited.body).toMatchObject({ matched: false, reason: 'exited', exited: true, exitCode: null });

    const listed = await api(td.port, td.token, '/sessions', { method: 'GET' });
    const summary = (listed.body['sessions'] as Array<{ id: string; exited: boolean; exitCode: number | null }>).find(
      (s) => s.id === id,
    );
    expect(summary).toMatchObject({ exited: true, exitCode: null });
    expect(listedState(summary as { exited: boolean; exitCode: number | null })).toBe('ended(output failed)');
    expect(session.summary().exitCode).toBeNull();
    expect((await session.snapshot()).exitCode).toBeNull();
  }, 120_000);

  it('counts as ended at once where node-pty records no code (canReadExitCode false)', async () => {
    const manager = new SessionManager(compilePolicy(undefined), quiet);
    managers.push(manager);
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    await eventually(() => session.getScreen().trim() !== '');
    const agent = agentOf(session);

    failOutput(session);
    await eventually(() => session.exited, 10_000);
    // Read as winpty would be: node-pty records nothing that can be trusted.
    agent._useConpty = false;
    try {
      expect(session.programEnded).toBe(true);
      expect(session.exitCode).toBeNull();
    } finally {
      agent._useConpty = true;
    }
    await eventually(() => !processAlive(session.pid), 30_000);
  }, 60_000);
});

describe.skipIf(process.platform !== 'win32')('a program that exits by itself or is killed', () => {
  it('reports its own code on every surface', async () => {
    const td = await startTestDaemon();
    daemons.push(td);
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(3), 1500)'], shell: false },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const session = sessionOf(td, id);
    const watcher = await connectWs(td.port, id, td.token);
    try {
      const exited = await watcher.waitForControl((c) => c['type'] === 'exited', 20_000);
      expect(exited['exitCode']).toBe(3);
      await watcher.waitForData('[process exited: 3]', 5_000);
    } finally {
      watcher.close();
    }
    expect(session.exitCode).toBe(3);
    expect(session.programEnded).toBe(true);
    const late = await connectWs(td.port, id, td.token);
    try {
      const identity = await late.waitForControl((c) => c['type'] === 'identity');
      expect(identity).toMatchObject({ exited: true, exitCode: 3 });
      await late.waitForData('[process exited: 3]', 5_000);
    } finally {
      late.close();
    }
    const input = await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'x' } });
    expect(input.status).toBe(409);
    expect(input.body['error']).toBe(
      `Session ${id} has exited (code 3) and no longer accepts input or geometry changes.`,
    );
    const listed = await api(td.port, td.token, '/sessions', { method: 'GET' });
    const summary = (listed.body['sessions'] as Array<{ id: string; exited: boolean; exitCode: number | null }>).find(
      (s) => s.id === id,
    );
    expect(listedState(summary as { exited: boolean; exitCode: number | null })).toBe('exited(3)');
  }, 60_000);

  it('reports the code of a program killed from outside', async () => {
    const manager = new SessionManager(compilePolicy(undefined), quiet);
    managers.push(manager);
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    await eventually(() => session.getScreen().trim() !== '');
    const reported = new Promise<number | null>((resolve) => session.onExit(resolve));
    process.kill(session.pid);
    const code = await reported;
    expect(code).not.toBeNull();
    expect(session.exitCode).toBe(code);
    expect(session.programEnded).toBe(true);
    expect(listedState(session.summary())).toBe(`exited(${String(code)})`);
  }, 60_000);
});
