/**
 * Ending a console host must not reach whatever process now holds the pid
 * the list returned. A bare `process.kill` would, once Windows had reused it.
 */

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill();
      });
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('ending a listed console host', () => {
  it('does not kill a process on another console that now holds the listed pid', async () => {
    // Match the host name so only the creation time distinguishes this process.
    const directory = mkdtempSync(join(tmpdir(), 'console-host-test-'));
    directories.push(directory);
    const executable = join(directory, 'OpenConsole.exe');
    copyFileSync(process.execPath, executable);
    const decoy = spawn(executable, ['-e', 'setInterval(() => {}, 500)'], {
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
  });
});
