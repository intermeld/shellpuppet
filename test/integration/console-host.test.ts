/**
 * On Windows a session's console host is a child of the daemon, and node-pty
 * 1.1.0 leaves it running after the session ends. These tests start sessions
 * on a daemon of their own. Each end waits until the daemon's queue has
 * listed and ended the host, then polls for the host to leave the process
 * list. A PowerShell query can create a console host of its own, so the
 * checks only count hosts created while a test session started.
 *
 * Each list is one CIM query of this process, the in-process daemon. The
 * kill test leaves the surviving session up so the stop test ends it together
 * with its own session.
 */

import { execFile } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { CONSOLE_HOST_GUARD_MS, listConsoleHosts, whenConsoleHostBatchSettled } from '../../src/core/windowsConsoleHost.js';
import type { ConsoleHostProcess } from '../../src/core/windowsConsoleHost.js';
import { api, eventually, makeTempHome, removeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

function hostKey(host: ConsoleHostProcess): string {
  return `${String(host.pid)} ${String(host.creationTime)}`;
}

interface SessionStart { id: string; from: number; to: number }

function recordedFor(host: ConsoleHostProcess, starts: readonly SessionStart[]): string[] {
  return starts
    .filter((start) => host.creationTime >= start.from - CONSOLE_HOST_GUARD_MS &&
      host.creationTime <= start.to + CONSOLE_HOST_GUARD_MS)
    .map((start) => start.id);
}

function sessionHosts(hosts: readonly ConsoleHostProcess[], starts: readonly SessionStart[]): ConsoleHostProcess[] {
  return hosts.filter((host) => recordedFor(host, starts).length > 0);
}

async function hostDiagnostic(hosts: readonly ConsoleHostProcess[], starts: readonly SessionStart[]): Promise<string> {
  const script = [
    `$parent = ${String(process.pid)}`,
    'Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" |',
    "Where-Object { $_.Name -eq 'conhost.exe' -or $_.Name -eq 'OpenConsole.exe' } |",
    'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
  ].join('\n');
  const commandLines = await new Promise<Record<number, string>>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 45_000 }, (error, stdout) => {
        if (error) { resolve({}); return; }
        try {
          const parsed: unknown = JSON.parse(stdout);
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          const lines: Record<number, string> = {};
          for (const entry of entries) {
            if (typeof entry !== 'object' || entry === null) continue;
            const value = entry as { ProcessId?: unknown; CommandLine?: unknown };
            if (typeof value.ProcessId === 'number' && typeof value.CommandLine === 'string') {
              lines[value.ProcessId] = value.CommandLine;
            }
          }
          resolve(lines);
        } catch { resolve({}); }
      });
  });
  return JSON.stringify({
    starts,
    hosts: hosts.map((host) => ({
      ...host,
      commandLine: commandLines[host.pid] ?? 'unavailable',
      recordedFor: recordedFor(host, starts),
    })),
  });
}

const shell = (): string => process.env['ComSpec'] ?? 'cmd.exe';

async function startSession(
  daemon: TestDaemon, body: Record<string, unknown>, starts: SessionStart[],
): Promise<string> {
  const from = Date.now();
  const started = await api(daemon.port, daemon.token, '/sessions', { body });
  const to = Date.now();
  expect(started.status).toBe(200);
  const id = started.body['id'];
  expect(typeof id).toBe('string');
  starts.push({ id: id as string, from, to });
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
  const starts: SessionStart[] = [];
  /** The kill test's daemon and the host it leaves alive, for the stop test. */
  let carried: { daemon: TestDaemon; survivorPid: number } | undefined;

  it('counts hosts from session starts without counting a later query host', () => {
    const recorded = [{ id: 'session', from: 1_000, to: 1_100 }];
    const session = { pid: 1, parentPid: process.pid, name: 'conhost.exe', creationTime: 1_050 };
    const query = { pid: 2, parentPid: process.pid, name: 'conhost.exe', creationTime: 1_117 };
    const early = { ...session, pid: 3, creationTime: 995 };
    const late = { ...session, pid: 4, creationTime: 1_105 };
    expect(sessionHosts([session, query, early, late], recorded)).toEqual([session, early, late]);
    expect(recordedFor(query, recorded)).toEqual([]);
  });

  afterAll(async () => {
    const left = carried;
    carried = undefined;
    if (left !== undefined) {
      try {
        await left.daemon.stop();
      } catch {
        // Already stopped.
      }
      await whenConsoleHostBatchSettled();
      await endStrays();
    }
    for (const home of homes) removeTempHome(home);
  });

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

  /** End only console hosts created while this file started its sessions. */
  async function endStrays(): Promise<void> {
    const left = await listConsoleHosts(process.pid).catch(() => [] as ConsoleHostProcess[]);
    for (const host of sessionHosts(left, starts)) {
      try {
        process.kill(host.pid);
      } catch {
        // Already gone.
      }
    }
  }

  it('ends its console host after a program exits on its own', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    try {
      started = await daemon();
      const id = await startSession(started, {
        command: shell(),
        args: ['/d', '/c', 'exit'],
        shell: false,
        openViewer: false,
      }, starts);
      await waitUntilExited(started, [id]);
      // The first observation is after the queue has processed the exit.
      // A premature seam leaves the session host visible.
      await whenConsoleHostBatchSettled();
      let after: ConsoleHostProcess[] = [];
      await eventually(async () => {
        after = await listConsoleHosts(process.pid);
        return sessionHosts(after, starts).length === 0;
      }, 30_000, 250).catch(async () => {
        throw new Error(`Session host remained after exit: ${await hostDiagnostic(after, starts)}`);
      });
      passed = true;
    } finally {
      if (!passed) await endStrays();
      await stop(started);
    }
  }, 240_000);

  it('ends the killed session\'s console host and leaves the other session\'s host', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    try {
      started = await daemon();
      const command = { command: shell(), shell: false, openViewer: false };
      const first = await startSession(started, command, starts);
      const second = await startSession(started, command, starts);
      expect(second).not.toBe(first);
      const before = await listConsoleHosts(process.pid);
      const hosts = sessionHosts(before, starts);
      if (hosts.length !== 2) throw new Error(`Expected two session hosts: ${await hostDiagnostic(before, starts)}`);
      const earlier = hosts.find((host) => recordedFor(host, starts).includes(first));
      const later = hosts.find((host) => recordedFor(host, starts).includes(second));
      if (earlier === undefined || later === undefined) {
        throw new Error(`Could not match the hosts to their sessions: ${await hostDiagnostic(before, starts)}`);
      }
      expect(later.pid).not.toBe(earlier.pid);
      const killed = await api(started.port, started.token, `/sessions/${first}`, { method: 'DELETE' });
      expect(killed.status).toBe(200);
      await whenConsoleHostBatchSettled();
      let after: ConsoleHostProcess[] = [];
      await eventually(async () => {
        after = await listConsoleHosts(process.pid);
        const left = new Set(after.map(hostKey));
        return !left.has(hostKey(earlier)) && left.has(hostKey(later));
      }, 30_000, 250).catch(async () => {
        throw new Error(`Killed and surviving hosts had the wrong state: ${await hostDiagnostic(after, starts)}`);
      });
      carried = { daemon: started, survivorPid: later.pid };
      passed = true;
    } finally {
      if (!passed) {
        carried = undefined;
        await endStrays();
        await stop(started);
      }
    }
  }, 240_000);

  it('ends a live session\'s console host when the daemon stops', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    const survivorPid = carried?.survivorPid;
    try {
      started = carried?.daemon ?? (await daemon());
      carried = undefined;
      const openedId = await startSession(started, { command: shell(), shell: false, openViewer: false }, starts);
      const before = await listConsoleHosts(process.pid);
      const hosts = sessionHosts(before, starts);
      if (survivorPid === undefined) {
        if (hosts.length !== 1) throw new Error(`Expected one session host: ${await hostDiagnostic(before, starts)}`);
      } else {
        if (hosts.length !== 2) throw new Error(`Expected two session hosts: ${await hostDiagnostic(before, starts)}`);
        const survivor = hosts.find((host) => host.pid === survivorPid);
        const opened = hosts.find((host) => recordedFor(host, starts).includes(openedId));
        if (survivor === undefined || opened === undefined) {
          throw new Error(`Expected the surviving host and the new host: ${await hostDiagnostic(before, starts)}`);
        }
        expect(survivor.pid).toBe(survivorPid);
        expect(survivor.pid).not.toBe(opened.pid);
      }
      await started.daemon.stop();
      await whenConsoleHostBatchSettled();
      let after: ConsoleHostProcess[] = [];
      await eventually(async () => {
        after = await listConsoleHosts(process.pid);
        return sessionHosts(after, starts).length === 0;
      }, 30_000, 250).catch(async () => {
        throw new Error(`Session host remained after daemon stop: ${await hostDiagnostic(after, starts)}`);
      });
      passed = true;
    } finally {
      if (!passed) await endStrays();
      await stop(started);
      for (const home of homes) removeTempHome(home);
    }
  }, 240_000);
});
