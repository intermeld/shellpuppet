/**
 * The end kills through the handle it opened before the name and start-time
 * checks. The process is the console host of a session this test starts.
 * The script is the one the end runs, with the private cached handle read
 * through reflection before and after Kill.
 */

import { execFileSync } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import type { SpawnWindow } from '../../src/core/windowsConsoleHost.js';
import { endConsoleHostProcess, listConsoleHosts } from '../../src/core/windowsConsoleHost.js';

const captured = vi.hoisted(() => ({
  scripts: [] as string[],
  execFile: null as null | typeof import('node:child_process').execFile,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  captured.execFile = actual.execFile;
  const isUnknownList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
  const scriptFrom = (args: unknown): string => {
    if (!isUnknownList(args)) return '';
    const index = args.indexOf('-Command');
    const script = index >= 0 ? args[index + 1] : undefined;
    return typeof script === 'string' ? script : '';
  };
  return {
    ...actual,
    execFile: ((
      file: string,
      args?: ReadonlyArray<string>,
      options?: unknown,
      callback?: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      const cb = typeof options === 'function' ? options as typeof callback : callback;
      const opts = typeof options === 'function' ? undefined : options;
      const script = scriptFrom(args);
      // The instrumented script still contains Kill. Only the production one is held.
      if (file === 'powershell.exe' && script.includes('$proc.Kill()') && !script.includes('HANDLE')) {
        captured.scripts.push(script);
        const pid = /\$targetId = (\d+)/.exec(script)?.[1] ?? '0';
        cb?.(null, `${pid} 3\n`, '');
        return { unref(): void {} };
      }
      return actual.execFile(
        file,
        args,
        opts as Parameters<typeof actual.execFile>[2],
        cb as Parameters<typeof actual.execFile>[3],
      );
    }) as typeof actual.execFile,
  };
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function powershell(script: string): Promise<string> {
  const run = captured.execFile;
  if (run === null) throw new Error('the real execFile was not captured');
  return new Promise((resolve, reject) => {
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout) => {
        const text = typeof stdout === 'string' ? stdout : String(stdout);
        if (error) {
          const detail = error instanceof Error ? error.message : 'PowerShell failed';
          reject(new Error(`${detail}\n${text}`));
          return;
        }
        resolve(text);
      },
    );
  });
}

/** The private handle Kill will use, read before and after the real Kill. */
function instrument(script: string): string {
  const probe = [
    "$flags = [Reflection.BindingFlags]'Instance,NonPublic'",
    "$field = $proc.GetType().GetField('m_processHandle', $flags)",
    '$beforeHandle = $field.GetValue($proc)',
    '$beforeHeld = $false',
    '$beforePtr = [int64]0',
    'if ($null -ne $beforeHandle -and -not $beforeHandle.IsClosed -and -not $beforeHandle.IsInvalid) {',
    '  $beforeHeld = $true',
    '  $beforePtr = $beforeHandle.DangerousGetHandle().ToInt64()',
    '}',
    '$proc.Kill()',
    '$afterHandle = $field.GetValue($proc)',
    '$afterHeld = $false',
    '$afterPtr = [int64]0',
    'if ($null -ne $afterHandle -and -not $afterHandle.IsClosed -and -not $afterHandle.IsInvalid) {',
    '  $afterHeld = $true',
    '  $afterPtr = $afterHandle.DangerousGetHandle().ToInt64()',
    '}',
    'Write-Output "HANDLE $beforeHeld $afterHeld $beforePtr $afterPtr"',
  ].join('; ');
  const replaced = script.replace('$proc.Kill()', probe);
  if (replaced === script) throw new Error('the end script has no $proc.Kill()');
  return replaced;
}

function endRecorded(pid: number): void {
  try {
    execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // Already gone.
  }
}

describe.skipIf(process.platform !== 'win32')('the console-host kill uses the handle opened before the checks', () => {
  it('kills the session host through the handle read before the name and the start time', async () => {
    let window: SpawnWindow | undefined;
    const manager = new SessionManager(compilePolicy(undefined), undefined, {
      queueConsoleHostEnd: () => undefined,
      registerConsoleHostWindow: (_id, recorded) => {
        window = recorded;
      },
    });
    const session = manager.create({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    const sessionPid = session.pid;
    let hostPid: number | undefined;
    let script = '';
    try {
      const recorded = window;
      if (recorded === undefined) throw new Error('the session did not record a spawn window');
      const hosts = await listConsoleHosts(process.pid);
      const matched = hosts.filter((host) =>
        host.creationTime >= recorded.t0 && host.creationTime <= recorded.t1);
      if (matched.length !== 1) {
        throw new Error(`expected the session's one host, saw ${JSON.stringify(matched)}`);
      }
      const host = matched[0];
      if (host === undefined) throw new Error('the session host was not listed');
      hostPid = host.pid;

      // Captures the script and reports "not that host", so this call kills nothing.
      await expect(endConsoleHostProcess(host.pid, host.creationTime)).rejects.toMatchObject({ code: 'ESRCH' });
      expect(alive(host.pid)).toBe(true);
      expect(captured.scripts).toHaveLength(1);
      script = captured.scripts[0] ?? '';

      const stdout = await powershell(instrument(script));
      const match = /^HANDLE (True|False) (True|False) (-?\d+) (-?\d+)$/m.exec(stdout);
      if (match === null) throw new Error(`no handle report:\n${stdout}`);
      // Kill reused the handle already cached before it ran. A Kill that opens
      // its own handle by pid leaves this field empty on both sides.
      expect(match[1]).toBe('True');
      expect(match[2]).toBe('True');
      expect(match[3]).not.toBe('0');
      expect(match[3]).toBe(match[4]);

      const handleAt = script.indexOf('$proc.Handle');
      const nameAt = script.indexOf('$proc.ProcessName');
      const startAt = script.indexOf('$proc.StartTime');
      const killAt = script.indexOf('$proc.Kill()');
      expect(handleAt).toBeGreaterThanOrEqual(0);
      expect(handleAt).toBeLessThan(nameAt);
      expect(nameAt).toBeLessThan(startAt);
      expect(startAt).toBeLessThan(killAt);
      expect(script.split('$proc.Handle').length - 1).toBe(1);
    } finally {
      try {
        await session.kill();
      } catch {
        // The tree kill can lose a race with the program exiting.
      }
      if (alive(sessionPid)) endRecorded(sessionPid);
      if (hostPid !== undefined && alive(hostPid)) {
        if (script.includes('$proc.Kill()')) {
          await powershell(script).catch(() => undefined);
        }
        if (alive(hostPid)) endRecorded(hostPid);
      }
    }
  });
});
