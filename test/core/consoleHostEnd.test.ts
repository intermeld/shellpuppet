/**
 * Ending a console host must not reach whatever process now holds the pid
 * the list returned. A bare `process.kill` would, once Windows had reused it.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { endConsoleHostProcess } from '../../src/core/windowsConsoleHost.js';

const children: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function powershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout) => {
        if (error) reject(error instanceof Error ? error : new Error('PowerShell failed'));
        else resolve(stdout);
      },
    );
  });
}

/** Unix milliseconds, the same clock the end compares against. */
async function startTime(pid: number): Promise<number> {
  const stdout = await powershell(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      "$ErrorActionPreference = 'Stop'",
      `$proc = Get-Process -Id ${String(pid)}`,
      'Write-Output ([DateTimeOffset]::new($proc.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds())',
    ].join('\n'),
  );
  const started = Number(stdout.trim());
  if (!Number.isInteger(started)) throw new Error(`no start time for ${String(pid)}`);
  return started;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && alive(child.pid)) {
      try {
        execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // Already gone.
      }
    }
  }
});

describe.skipIf(process.platform !== 'win32')('ending a listed console host', () => {
  it('does not kill a process on another console that now holds the listed pid', async () => {
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    children.push(decoy);
    const decoyPid = decoy.pid;
    if (decoyPid === undefined) throw new Error('the decoy did not start');

    const kills = vi.spyOn(process, 'kill');
    // The list's creation time is not this process's: the pid has been reused.
    await expect(endConsoleHostProcess(decoyPid, 1)).rejects.toMatchObject({ code: 'ESRCH' });
    const terminating = kills.mock.calls.filter(([pid, signal]) => pid === decoyPid && signal !== 0);
    expect(terminating).toEqual([]);
    expect(alive(decoyPid)).toBe(true);
  });

  it('does not kill a process that is not a console host, even at its real start time', async () => {
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    children.push(decoy);
    const decoyPid = decoy.pid;
    if (decoyPid === undefined) throw new Error('the decoy did not start');
    const started = await startTime(decoyPid);

    // The time gate matches. Only the name gate can refuse this process.
    const outcome = await endConsoleHostProcess(decoyPid, started).then(
      () => 'ended',
      (error: unknown) => error,
    );
    expect(alive(decoyPid)).toBe(true);
    expect(outcome).toMatchObject({ code: 'ESRCH' });
  }, 40_000);
});
