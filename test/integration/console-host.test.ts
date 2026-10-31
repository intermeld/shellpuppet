/**
 * On Windows a session's console host is a child of the daemon, and node-pty
 * 1.1.0 leaves it running after the session ends. These tests start sessions
 * on a daemon of their own. Each end waits until the daemon's queue has
 * listed and ended the host, then one call to listConsoleHosts confirms it.
 *
 * That lister is one CIM query of this process, the in-process daemon, and
 * the query takes about fourteen seconds. Each check calls it once. The
 * queue's own list is the same query. The kill test leaves the surviving
 * session up so the stop test ends it together with its own session, in one
 * list.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listConsoleHosts, whenConsoleHostBatchSettled } from '../../src/core/windowsConsoleHost.js';
import type { ConsoleHostProcess } from '../../src/core/windowsConsoleHost.js';
import { api, eventually, makeTempHome, removeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

function hostKey(host: ConsoleHostProcess): string {
  return `${String(host.pid)} ${String(host.creationTime)}`;
}

function sameHosts(left: readonly ConsoleHostProcess[], right: readonly ConsoleHostProcess[]): boolean {
  return left.map(hostKey).sort().join('\n') === right.map(hostKey).sort().join('\n');
}

function addedHosts(
  current: readonly ConsoleHostProcess[],
  baseline: readonly ConsoleHostProcess[],
): ConsoleHostProcess[] {
  const known = new Set(baseline.map(hostKey));
  return current
    .filter((host) => !known.has(hostKey(host)))
    .sort((left, right) => left.creationTime - right.creationTime);
}

const shell = (): string => process.env['ComSpec'] ?? 'cmd.exe';

async function startSession(daemon: TestDaemon, body: Record<string, unknown>): Promise<string> {
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
  /** Hosts already parented to this process, taken once before any session. */
  let baseline: ConsoleHostProcess[] = [];
  /** The kill test's daemon and the host it leaves alive, for the stop test. */
  let carried: { daemon: TestDaemon; survivorPid: number } | undefined;

  beforeAll(async () => {
    baseline = await listConsoleHosts(process.pid);
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

  /** One list, then end any console host this file added. */
  async function endStrays(): Promise<void> {
    const left = await listConsoleHosts(process.pid).catch(() => [] as ConsoleHostProcess[]);
    const known = new Set(baseline.map((host) => host.pid));
    for (const host of left) {
      if (known.has(host.pid)) continue;
      try {
        process.kill(host.pid);
      } catch {
        // Already gone.
      }
    }
  }

  it('returns the console-host count to its starting value after a program exits on its own', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    try {
      started = await daemon();
      const id = await startSession(started, {
        command: shell(),
        args: ['/d', '/c', 'exit'],
        shell: false,
        openViewer: false,
      });
      await waitUntilExited(started, [id]);
      // The queue's list takes about ten seconds. A seam that resolved on
      // the call returns in well under 500 ms, while the host is still running.
      const waited = Date.now();
      await whenConsoleHostBatchSettled();
      expect(Date.now() - waited).toBeGreaterThan(500);
      const after = await listConsoleHosts(process.pid);
      expect(sameHosts(after, baseline), JSON.stringify({ after, baseline })).toBe(true);
      passed = true;
    } finally {
      if (!passed) await endStrays();
      await stop(started);
    }
  }, 120_000);

  it('ends the killed session\'s console host and leaves the other session\'s host', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    try {
      started = await daemon();
      const command = { command: shell(), shell: false, openViewer: false };
      const first = await startSession(started, command);
      const second = await startSession(started, command);
      expect(second).not.toBe(first);
      const hosts = addedHosts(await listConsoleHosts(process.pid), baseline);
      expect(hosts, JSON.stringify(hosts)).toHaveLength(2);
      const earlier = hosts[0];
      const later = hosts[1];
      if (earlier === undefined || later === undefined) throw new Error('expected two console hosts');
      if (earlier.creationTime === later.creationTime) {
        throw new Error('the two console hosts have the same creation time');
      }
      expect(later.pid).not.toBe(earlier.pid);
      const killed = await api(started.port, started.token, `/sessions/${first}`, { method: 'DELETE' });
      expect(killed.status).toBe(200);
      await whenConsoleHostBatchSettled();
      const after = await listConsoleHosts(process.pid);
      const left = new Set(after.map(hostKey));
      expect(left.has(hostKey(earlier)), JSON.stringify(after)).toBe(false);
      expect(left.has(hostKey(later)), JSON.stringify(after)).toBe(true);
      carried = { daemon: started, survivorPid: later.pid };
      passed = true;
    } finally {
      if (!passed) {
        carried = undefined;
        await endStrays();
        await stop(started);
      }
    }
  }, 180_000);

  it('ends a live session\'s console host when the daemon stops', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    const survivorPid = carried?.survivorPid;
    try {
      started = carried?.daemon ?? (await daemon());
      carried = undefined;
      await startSession(started, { command: shell(), shell: false, openViewer: false });
      const hosts = addedHosts(await listConsoleHosts(process.pid), baseline);
      if (survivorPid === undefined) {
        expect(hosts, JSON.stringify(hosts)).toHaveLength(1);
      } else {
        expect(hosts, JSON.stringify(hosts)).toHaveLength(2);
        const survivor = hosts[0];
        const opened = hosts[1];
        if (survivor === undefined || opened === undefined) {
          throw new Error('expected the surviving host and the new host');
        }
        expect(survivor.pid).toBe(survivorPid);
        if (survivor.creationTime === opened.creationTime) {
          throw new Error('the two console hosts have the same creation time');
        }
      }
      await started.daemon.stop();
      await whenConsoleHostBatchSettled();
      const after = await listConsoleHosts(process.pid);
      expect(sameHosts(after, baseline), JSON.stringify({ after, baseline })).toBe(true);
      passed = true;
    } finally {
      if (!passed) await endStrays();
      await stop(started);
      for (const home of homes) removeTempHome(home);
    }
  }, 180_000);
});
