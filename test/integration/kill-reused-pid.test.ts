/**
 * A session's kill on Windows ends the session's processes and nothing else,
 * including later. node-pty 1.1.0's own kill asks a helper process to attach
 * to the console of whichever process holds the program's pid and kills every
 * process on it; when the helper cannot answer, it waits five seconds and
 * kills that pid. A session's kill ends the process tree first, and once the
 * program has ended Windows may give its pid to another process, so either
 * way node-pty would end processes that are not the session's
 * (`src/core/windowsPtyStart.ts`).
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { taskkillTrees } from '../../src/core/session.js';
import type { Session } from '../../src/core/session.js';
import { eventually, processAlive } from './helpers.js';

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

const decoys: ChildProcess[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (managers.length > 0) await managers.pop()?.killAll();
  // Each decoy's whole tree, which these tests started.
  const pids = decoys.splice(0).flatMap((decoy) => (decoy.pid === undefined ? [] : [decoy.pid]));
  if (pids.length > 0) await taskkillTrees(pids);
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

  it("ends nothing of another console when the ended program's pid is held by a process on it", async () => {
    const session = makeManager().create({
      command: process.execPath,
      args: ['-e', "console.log('ended-soon'); setTimeout(() => {}, 300)"],
      shell: false,
    });
    await new Promise((resolve) => session.onExit(resolve));
    expect(session.programEnded).toBe(true);

    // A stand-in for a process Windows has given the freed pid to: a program
    // of this test's own, on a console of its own, with a child on it.
    const decoy = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    decoys.push(decoy);
    const decoyPid = decoy.pid;
    if (decoyPid === undefined) throw new Error('the decoy did not start');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // node-pty looks the console up by the pid its agent holds.
    const agent = (session as unknown as { pty: { _agent?: { _innerPid: number } } }).pty._agent;
    if (agent === undefined) throw new Error('no Windows agent on this terminal');
    agent._innerPid = decoyPid;
    const kills = vi.spyOn(process, 'kill');

    await session.kill();
    await new Promise((resolve) => setTimeout(resolve, PAST_THE_FALLBACK_MS));

    const terminating = kills.mock.calls.filter(([, signal]) => signal !== 0).map(([pid]) => pid);
    expect({ terminating, decoyAlive: processAlive(decoyPid) }).toEqual({ terminating: [], decoyAlive: true });
  });
});
