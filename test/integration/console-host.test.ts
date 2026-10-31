/**
 * On Windows a session's console host is a child of the daemon, and node-pty
 * 1.1.0 leaves it running after the session ends. These tests start sessions
 * on a daemon of their own and require the host count to return to the value
 * it had before those sessions. The count is of `conhost.exe` and
 * `OpenConsole.exe` whose parent is this process, which is the daemon here.
 */

import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { api, eventually, makeTempHome, removeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

interface HostProcess {
  pid: number;
  creationTime: string;
}

function failureWithCause(error: unknown, detail: string): Error {
  return new Error(`${error instanceof Error ? error.message : String(error)}; ${detail}`, { cause: error });
}

function sameHosts(left: readonly HostProcess[], right: readonly HostProcess[]): boolean {
  const key = (host: HostProcess): string => `${String(host.pid)} ${host.creationTime}`;
  return left.map(key).sort().join('\n') === right.map(key).sort().join('\n');
}

/**
 * Console hosts whose parent is `parentPid`, read with one CIM query.
 * One pipeline, so an empty result is empty output rather than a second
 * statement: `powershell -Command` runs the argument as a single script, and
 * a statement jammed against the end of a subexpression is a parse error.
 */
function consoleHosts(parentPid: number): Promise<HostProcess[]> {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(parentPid)}" |`,
    "Where-Object { $_.Name -eq 'conhost.exe' -or $_.Name -eq 'OpenConsole.exe' } |",
    "ForEach-Object { '{0} {1}' -f [int]$_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }",
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error != null) {
          reject(error instanceof Error ? error : new Error('console host list failed'));
          return;
        }
        const rows = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^\d+ /.test(line))
          .map((line) => {
            const space = line.indexOf(' ');
            return { pid: Number(line.slice(0, space)), creationTime: line.slice(space + 1) };
          });
        resolve(rows);
      },
    );
  });
}

const shell = (): string => process.env['ComSpec'] ?? 'cmd.exe';

async function startSession(
  daemon: TestDaemon,
  body: Record<string, unknown>,
): Promise<string> {
  const started = await api(daemon.port, daemon.token, '/sessions', { body });
  expect(started.status).toBe(200);
  const id = started.body['id'];
  expect(typeof id).toBe('string');
  return id as string;
}

async function waitUntilExited(daemon: TestDaemon, ids: readonly string[]): Promise<void> {
  await eventually(async () => {
    const listed = await api(daemon.port, daemon.token, '/sessions');
    const sessions = listed.body['sessions'] as { id: string; exited: boolean }[];
    return ids.every((id) => sessions.some((session) => session.id === id && session.exited));
  }, 20_000);
}

describe.skipIf(process.platform !== 'win32')('Windows console hosts of a test daemon', () => {
  const homes: string[] = [];

  async function daemon(): Promise<TestDaemon> {
    const started = await startTestDaemon({ home: makeTempHome('shellpuppet-conhost-') });
    homes.push(started.home);
    return started;
  }

  async function stop(started: TestDaemon | undefined): Promise<void> {
    if (started === undefined) return;
    try {
      await started.daemon.stop();
    } catch {
      // Already stopped.
    }
    removeTempHome(started.home);
  }

  it('returns the console-host count to its starting value after programs exit on their own', async () => {
    const before = await consoleHosts(process.pid);
    let started: TestDaemon | undefined;
    const extras = new Set<number>(before.map((host) => host.pid));
    try {
      started = await daemon();
      const first = await startSession(started, {
        command: shell(),
        args: ['/d', '/c', 'exit'],
        shell: false,
        openViewer: false,
      });
      const second = await startSession(started, {
        command: shell(),
        args: ['/d', '/c', 'exit'],
        shell: false,
        openViewer: false,
      });
      await waitUntilExited(started, [first, second]);
      // The host is ended by a list that runs after the exit, off the request.
      // The list takes about ten seconds. A host node-pty has already dropped
      // stays for the life of the daemon, so this does not wait for the
      // fifteen-minute reap.
      let after: HostProcess[] = [];
      try {
        await eventually(async () => {
          after = await consoleHosts(process.pid);
          return sameHosts(after, before);
        }, 90_000);
      } catch (error) {
        throw failureWithCause(
          error,
          `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
        );
      }
    } finally {
      const left = await consoleHosts(process.pid).catch(() => [] as HostProcess[]);
      for (const host of left) {
        if (!extras.has(host.pid)) {
          try {
            process.kill(host.pid);
          } catch {
            // Already gone.
          }
        }
      }
      await stop(started);
    }
  }, 180_000);

  it('ends the killed session\'s console host and leaves the other session\'s host', async () => {
    const before = await consoleHosts(process.pid);
    let started: TestDaemon | undefined;
    try {
      started = await daemon();
      const command = { command: shell(), shell: false, openViewer: false };
      const first = await startSession(started, command);
      const afterFirst = await consoleHosts(process.pid);
      const firstHost = afterFirst.filter((host) => !before.some((kept) => kept.pid === host.pid));
      expect(firstHost).toHaveLength(1);
      const second = await startSession(started, command);
      const afterSecond = await consoleHosts(process.pid);
      const secondHost = afterSecond.filter((host) => !afterFirst.some((kept) => kept.pid === host.pid));
      expect(secondHost).toHaveLength(1);

      const killed = await api(started.port, started.token, `/sessions/${first}`, { method: 'DELETE' });
      expect(killed.status).toBe(200);
      let hostsAfterKill: HostProcess[] = [];
      try {
        await eventually(async () => {
          hostsAfterKill = await consoleHosts(process.pid);
          return !hostsAfterKill.some((host) => host.pid === firstHost[0]?.pid);
        }, 90_000);
      } catch (error) {
        throw failureWithCause(error, `hosts ${JSON.stringify(hostsAfterKill)}`);
      }
      const afterKill = await consoleHosts(process.pid);
      const survivor = afterKill.find((host) => host.pid === secondHost[0]?.pid);
      expect(survivor?.creationTime).toBe(secondHost[0]?.creationTime);
      expect(survivor?.pid).toBe(secondHost[0]?.pid);

      const ended = await api(started.port, started.token, `/sessions/${second}`, { method: 'DELETE' });
      expect(ended.status).toBe(200);
      let hostsAtEnd: HostProcess[] = [];
      try {
        await eventually(async () => {
          hostsAtEnd = await consoleHosts(process.pid);
          return sameHosts(hostsAtEnd, before);
        }, 90_000);
      } catch (error) {
        throw failureWithCause(
          error,
          `hosts ${JSON.stringify(hostsAtEnd)}; baseline ${JSON.stringify(before)}`,
        );
      }
    } finally {
      const left = await consoleHosts(process.pid).catch(() => [] as HostProcess[]);
      for (const host of left) {
        if (!before.some((kept) => kept.pid === host.pid)) {
          try {
            process.kill(host.pid);
          } catch {
            // Already gone.
          }
        }
      }
      await stop(started);
    }
  }, 180_000);

  it('ends a live session\'s console host when the daemon stops', async () => {
    const before = await consoleHosts(process.pid);
    let started: TestDaemon | undefined;
    try {
      started = await daemon();
      await startSession(started, { command: shell(), shell: false, openViewer: false });
      const during = await consoleHosts(process.pid);
      expect(during.filter((host) => !before.some((kept) => kept.pid === host.pid))).toHaveLength(1);
      await started.daemon.stop();
      started = undefined;
      let hostsAfterStop: HostProcess[] = [];
      try {
        await eventually(async () => {
          hostsAfterStop = await consoleHosts(process.pid);
          return sameHosts(hostsAfterStop, before);
        }, 90_000);
      } catch (error) {
        throw failureWithCause(
          error,
          `hosts ${JSON.stringify(hostsAfterStop)}; baseline ${JSON.stringify(before)}`,
        );
      }
    } finally {
      const left = await consoleHosts(process.pid).catch(() => [] as HostProcess[]);
      for (const host of left) {
        if (!before.some((kept) => kept.pid === host.pid)) {
          try {
            process.kill(host.pid);
          } catch {
            // Already gone.
          }
        }
      }
      await stop(started);
      for (const home of homes) removeTempHome(home);
    }
  }, 180_000);
});
