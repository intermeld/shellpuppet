/**
 * A session's kill on Windows ends the session's processes and nothing else,
 * including later. node-pty 1.1.0 asks a helper process which pids are
 * attached to the terminal's console and kills those; when the helper cannot
 * answer, it waits five seconds and kills the pid of the program the terminal
 * started. A session kill ends the process tree first, so the helper never
 * can answer, and the pid it fell back to had been free for five seconds by
 * then, which on Windows is long enough to have been handed to another
 * process (`src/core/windowsPtyStart.ts`).
 */

import type * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import type { Session } from '../../src/core/session.js';
import { consoleProcessList } from '../../src/core/windowsPtyStart.js';
import { eventually, interactiveShell } from './helpers.js';

/** Past node-pty's five seconds, with room for a timer that fires late. */
const PAST_THE_FALLBACK_MS = 7_000;

const managers: SessionManager[] = [];
function makeManager(): SessionManager {
  const manager = new SessionManager(compilePolicy(undefined));
  managers.push(manager);
  return manager;
}

/** A program that prints a line and then waits to be ended. */
function waitingProgram(): Session {
  return makeManager().create({
    command: process.execPath,
    args: ['-e', "console.log('kill-me-up'); setInterval(() => {}, 200)"],
    shell: false,
  });
}

/** The kills of `pid` that terminate: signal 0 only asks whether it exists. */
function terminatingKillsOf(kills: { mock: { calls: unknown[][] } }, pid: number): unknown[][] {
  return kills.mock.calls.filter(([target, signal]) => target === pid && signal !== 0);
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (managers.length > 0) await managers.pop()?.killAll();
});

describe.skipIf(process.platform !== 'win32')('a session kill on Windows', () => {
  it('never kills the program pid again once that pid is free to be given out', async () => {
    const session = waitingProgram();
    await eventually(() => session.getScreen().includes('kill-me-up'), 20_000);
    const program = session.pid;
    const kills = vi.spyOn(process, 'kill');

    await session.kill();
    await new Promise((resolve) => setTimeout(resolve, PAST_THE_FALLBACK_MS));

    // The session's own check after the kill asks with signal 0.
    expect(terminatingKillsOf(kills, program)).toEqual([]);
  });

  it('never kills it either for a session whose output failed, which has ended its program itself', async () => {
    const session = waitingProgram();
    await eventually(() => session.getScreen().includes('kill-me-up'), 20_000);
    const program = session.pid;
    const kills = vi.spyOn(process, 'kill');

    // node-pty closes a terminal whose output socket fails and reports an
    // exit with no code; the session then ends the program with a tree kill,
    // and its kill waits for that before node-pty's own.
    const ended = new Promise((resolve) => session.onExit(resolve));
    const output = (session as unknown as { pty: { _agent?: { outSocket?: net.Socket } } }).pty._agent?.outSocket;
    if (output === undefined) throw new Error('no output socket');
    output.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await ended;
    await session.kill();
    await new Promise((resolve) => setTimeout(resolve, PAST_THE_FALLBACK_MS));

    expect(terminatingKillsOf(kills, program)).toEqual([]);
  });

  it('still lists what is attached to the console of a terminal that is running', async () => {
    const session = makeManager().create(interactiveShell());
    await session.waitFor({ quiet: 700 }, { timeout: 20_000 });
    await session.write(`"${process.execPath}" -e "setInterval(() => {}, 200)"\r`);
    // The shell and the program it started share the terminal's console.
    await eventually(async () => (await consoleProcessList(session.pid)).length >= 2, 20_000);
    expect(await consoleProcessList(session.pid)).toContain(session.pid);
  });
});
