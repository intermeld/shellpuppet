/**
 * A failed write on a live Windows terminal's pipes must not take the daemon
 * down. node-pty 1.1.0 listens for no error on the socket it writes input
 * through, nor on the worker that copies the output pipe, so either error
 * would be an uncaught exception. The input pipe refuses a write once the
 * console host has closed its end (`write EAGAIN`): the last test makes that
 * happen for real by ending the session's own console host. The others emit
 * the errors libuv and the worker would deliver, on the session's own objects.
 */

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import type { Session } from '../../src/core/session.js';
import type { Logger } from '../../src/core/types.js';
import { eventually, interactiveShell } from './helpers.js';

const managers: SessionManager[] = [];
afterEach(async () => {
  while (managers.length > 0) await managers.pop()?.killAll();
});

type Warning = { message: string; meta?: Record<string, unknown> };

function managerWithLog(): { manager: SessionManager; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const ignore = (): void => undefined;
  const logger: Logger = { debug: ignore, info: ignore, error: ignore, warn: (message, meta) => warnings.push({ message, meta }) };
  const manager = new SessionManager(compilePolicy(undefined), logger);
  managers.push(manager);
  return { manager, warnings };
}

type Agent = { inSocket?: NodeJS.EventEmitter; _conoutSocketWorker?: { _worker?: NodeJS.EventEmitter } };
function agentOf(session: Session): Agent {
  const agent = (session as unknown as { pty: { _agent?: Agent } }).pty._agent;
  if (agent === undefined) throw new Error('no Windows agent on this terminal');
  return agent;
}

function refusal(): Error {
  return Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN', errno: -4088, syscall: 'write' });
}

/**
 * The console hosts this process owns: one per pseudoconsole it created. A
 * busy machine can cancel the WMI query ("Call cancelled"), so it is tried
 * three times.
 */
function consoleHosts(): number[] {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(process.pid)} AND Name='conhost.exe'" | ForEach-Object { $_.ProcessId }`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      return out
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

describe.skipIf(process.platform !== 'win32')('a failed write on a Windows terminal', () => {
  it('is taken by the session when its input is refused, logged once, and leaves its neighbour running', async () => {
    const { manager, warnings } = managerWithLog();
    const refused = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    const neighbour = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    const input = agentOf(refused).inSocket;
    if (input === undefined) throw new Error('no input socket');

    // With no listener, emit('error') throws the error back at its caller.
    expect(() => input.emit('error', refusal())).not.toThrow();
    expect(() => input.emit('error', refusal())).not.toThrow();

    const reports = warnings.filter((w) => w.message === 'session input failed');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.meta).toMatchObject({ id: refused.id, error: 'Error: write EAGAIN' });

    // The neighbour still takes input and shows its output.
    await neighbour.write('echo still-here\r');
    await eventually(() => neighbour.getScreen().includes('still-here'));
  }, 60_000);

  it('is taken by the session when the output worker fails', () => {
    const { manager, warnings } = managerWithLog();
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    const worker = agentOf(session)._conoutSocketWorker?._worker;
    if (worker === undefined) throw new Error('no output worker');

    expect(() => worker.emit('error', refusal())).not.toThrow();
    expect(warnings.filter((w) => w.message === 'session output failed')).toHaveLength(1);
  }, 60_000);

  it('takes a real refusal, once the console host has gone', async () => {
    const { manager, warnings } = managerWithLog();
    const before = new Set(consoleHosts());
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    await eventually(() => session.getScreen().trim() !== '');
    const added = consoleHosts().filter((pid) => !before.has(pid));
    expect(added).toHaveLength(1);

    // Ending the session's own console host closes its end of the input
    // pipe; writes then race the exit node-pty reports soon after. A write
    // that lands in between is refused by Windows, and with no listener
    // that would be uncaught, failing this run.
    process.kill(added[0] as number);
    const until = Date.now() + 3_000;
    while (!session.exited && Date.now() < until && !warnings.some((w) => w.message === 'session input failed')) {
      void session.write('\x1b[O');
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(warnings.filter((w) => w.message === 'session input failed').length).toBeLessThanOrEqual(1);
  }, 60_000);
});
