/**
 * Which console host belongs to a session once it has ended. A stand-in
 * lists processes. No real process is started here.
 * `test/integration/console-host.test.ts` drives the same decisions against
 * a daemon and real console hosts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_HOST_COALESCE_MS,
  CONSOLE_HOST_QUERY_TIMEOUT_MS,
  CONSOLE_HOST_WINDOW_TOLERANCE_MS,
  TRACK_WINDOWS_CONSOLE_HOST,
  createConsoleHostQueue,
  listConsoleHosts,
  queryFailureReason,
  queueConsoleHostEnd,
  selectConsoleHost,
} from '../../src/core/windowsConsoleHost.js';
import type { ConsoleHostProcess, QueuedConsoleHost, SpawnWindow } from '../../src/core/windowsConsoleHost.js';

/** What the stand-in for `execFile` last saw. No PowerShell is started. */
const listed = vi.hoisted(() => ({ timeout: undefined as number | undefined, stdout: '' }));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const options = args[2] as { timeout?: number } | undefined;
    listed.timeout = options?.timeout;
    const callback = args[3] as (error: Error | null, stdout: string) => void;
    callback(null, listed.stdout);
    return { unref(): void {} };
  },
}));

const daemon = 4000;
const tolerance = 5;

function host(overrides: Partial<ConsoleHostProcess> = {}): ConsoleHostProcess {
  return {
    pid: 50,
    parentPid: daemon,
    name: 'conhost.exe',
    creationTime: 1_000,
    ...overrides,
  };
}

const window: SpawnWindow = { t0: 1_000, t1: 1_100 };

function reasonText(meta: Record<string, unknown>): string {
  const reason = meta['reason'];
  return typeof reason === 'string' ? reason : '';
}

describe('selectConsoleHost', () => {
  it('chooses the one console host created in the window', () => {
    const created = host({ pid: 51, name: 'OpenConsole.exe', creationTime: 1_050 });
    expect(selectConsoleHost(window, [host({ pid: 7, creationTime: 10 }), created], daemon, tolerance)).toEqual({
      match: created,
    });
  });

  it('chooses a host at the edge of the tolerance and rejects one just outside it', () => {
    const edge = host({ pid: 52, creationTime: window.t1 + tolerance });
    expect(selectConsoleHost(window, [edge], daemon, tolerance)).toEqual({ match: edge });
    const outside = host({ pid: 53, creationTime: window.t1 + tolerance + 1 });
    const missed = selectConsoleHost(window, [outside], daemon, tolerance);
    expect(missed.match).toBeNull();
    if (missed.match === null) expect(missed.reason).toMatch(/no console host/);
  });

  it('chooses nothing when no console host was created in the window', () => {
    const result = selectConsoleHost(window, [host({ creationTime: 10 })], daemon, tolerance);
    expect(result).toEqual({
      match: null,
      reason: 'no console host was created in the session window',
    });
  });

  it('chooses nothing when two console hosts were created in the window', () => {
    const result = selectConsoleHost(
      window,
      [host({ pid: 51, creationTime: 1_010 }), host({ pid: 52, creationTime: 1_020 })],
      daemon,
      tolerance,
    );
    expect(result.match).toBeNull();
    if (result.match === null) expect(result.reason).toMatch(/2 console hosts/);
  });

  it('ignores a console host whose parent is not the daemon', () => {
    const result = selectConsoleHost(window, [host({ parentPid: daemon + 1 })], daemon, tolerance);
    expect(result.match).toBeNull();
    if (result.match === null) expect(result.reason).toMatch(/no console host/);
  });

  it('ignores a process that is not a console host', () => {
    const result = selectConsoleHost(window, [host({ name: 'cmd.exe' })], daemon, tolerance);
    expect(result.match).toBeNull();
    if (result.match === null) expect(result.reason).toMatch(/no console host/);
  });

  it('accepts the image name in any case', () => {
    const created = host({ name: 'CONHOST.EXE' });
    expect(selectConsoleHost(window, [created], daemon, tolerance)).toEqual({ match: created });
  });
});

describe('createConsoleHostQueue', () => {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('ends the one host in the window', async () => {
    const ended: number[] = [];
    const queue = createConsoleHostQueue({
      parentPid: daemon,
      coalesceMs: 20,
      toleranceMs: tolerance,
      list: () => Promise.resolve([host({ pid: 80, creationTime: 1_040 })]),
      endProcess: (pid) => {
        ended.push(pid);
      },
    });
    queue.push({ id: 's', window, log: () => undefined });
    await pause(80);
    expect(ended).toEqual([80]);
  });

  it('ends nothing when the window holds no host, two hosts, the wrong parent or the wrong name', async () => {
    const ended: number[] = [];
    const logs: string[] = [];
    const queue = createConsoleHostQueue({
      parentPid: daemon,
      coalesceMs: 20,
      toleranceMs: tolerance,
      list: () =>
        Promise.resolve([
          host({ pid: 81, creationTime: 10 }),
          host({ pid: 82, creationTime: 1_010 }),
          host({ pid: 83, creationTime: 1_020 }),
          host({ pid: 84, parentPid: 9, creationTime: 1_040 }),
          host({ pid: 85, name: 'cmd.exe', creationTime: 1_040 }),
          host({ pid: 86, creationTime: window.t1 + tolerance + 1 }),
        ]),
      endProcess: (pid) => {
        ended.push(pid);
      },
    });
    const item = (id: string): QueuedConsoleHost => ({
      id,
      window,
      log: (_level, _message, meta) => {
        logs.push(reasonText(meta));
      },
    });
    queue.push(item('none-and-two'));
    await pause(80);
    expect(ended).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('ends nothing when the list fails or times out, and logs the reason once', async () => {
    const ended: number[] = [];
    const reasons: string[] = [];
    let calls = 0;
    const queue = createConsoleHostQueue({
      parentPid: daemon,
      coalesceMs: 20,
      list: () => {
        calls += 1;
        const timeout = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
        return Promise.reject(calls === 1 ? new Error('snapshot failed') : timeout);
      },
      endProcess: (pid) => {
        ended.push(pid);
      },
    });
    const log = (_level: 'info' | 'warn', _message: string, meta: Record<string, unknown>): void => {
      reasons.push(reasonText(meta));
    };
    queue.push({ id: 's1', window, log });
    await pause(80);
    queue.push({ id: 's2', window, log });
    await pause(80);
    expect(ended).toEqual([]);
    expect(calls).toBe(2);
    expect(reasons[0]).toMatch(/snapshot failed/);
    expect(reasons[1]).toBe('console host query timed out');
    expect(reasons).toHaveLength(2);
  });

  it('lists once for several sessions ended together, and ends each session host', async () => {
    let calls = 0;
    const ended: number[] = [];
    const queue = createConsoleHostQueue({
      parentPid: daemon,
      coalesceMs: 40,
      toleranceMs: tolerance,
      list: () => {
        calls += 1;
        return Promise.resolve([
          host({ pid: 91, creationTime: 1_050 }),
          host({ pid: 92, creationTime: 2_050 }),
        ]);
      },
      endProcess: (pid) => {
        ended.push(pid);
      },
    });
    queue.push({ id: 'a', window, log: () => undefined });
    queue.push({ id: 'b', window: { t0: 2_000, t1: 2_100 }, log: () => undefined });
    await pause(120);
    expect(calls).toBe(1);
    expect(ended).toEqual([91, 92]);
  });

  it('uses the production tolerance, coalescing and timeout', async () => {
    expect(CONSOLE_HOST_WINDOW_TOLERANCE_MS).toBe(5);
    expect(CONSOLE_HOST_COALESCE_MS).toBe(300);
    expect(CONSOLE_HOST_QUERY_TIMEOUT_MS).toBe(45_000);

    listed.timeout = undefined;
    listed.stdout = '';
    await listConsoleHosts(daemon);
    expect(listed.timeout).toBe(CONSOLE_HOST_QUERY_TIMEOUT_MS);

    // No coalescing and no tolerance are passed in, so the defaults above are
    // the ones a batch uses. The daemon's own queue is that call with no
    // overrides, and where it is switched on it is driven the same way.
    vi.useFakeTimers();
    const kills = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const ended: number[] = [];
      const queue = createConsoleHostQueue({
        parentPid: daemon,
        list: () =>
          Promise.resolve([
            host({ pid: 70, creationTime: window.t1 + CONSOLE_HOST_WINDOW_TOLERANCE_MS }),
            host({ pid: 71, creationTime: window.t1 + CONSOLE_HOST_WINDOW_TOLERANCE_MS + 1 }),
          ]),
        endProcess: (pid) => {
          ended.push(pid);
        },
      });
      queue.push({ id: 'defaults', window, log: () => undefined });
      await vi.advanceTimersByTimeAsync(CONSOLE_HOST_COALESCE_MS - 1);
      expect(ended).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toEqual([70]);

      if (TRACK_WINDOWS_CONSOLE_HOST) {
        const edge = window.t1 + CONSOLE_HOST_WINDOW_TOLERANCE_MS;
        listed.timeout = undefined;
        listed.stdout = [
          `70 ${String(process.pid)} conhost.exe ${String(edge)}`,
          `71 ${String(process.pid)} conhost.exe ${String(edge + 1)}`,
        ].join('\n');
        kills.mockClear();
        queueConsoleHostEnd({ id: 'daemon', window, log: () => undefined });
        await vi.advanceTimersByTimeAsync(CONSOLE_HOST_COALESCE_MS - 1);
        expect(listed.timeout).toBeUndefined();
        expect(kills).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(listed.timeout).toBe(CONSOLE_HOST_QUERY_TIMEOUT_MS);
        expect(kills.mock.calls.map((call) => call[0])).toEqual([70]);
      }
    } finally {
      kills.mockRestore();
      vi.useRealTimers();
    }
  });

  it('treats a killed child or a signal as a timeout, and a message as a failure', () => {
    const killed = Object.assign(new Error('Command failed'), { killed: true });
    expect(queryFailureReason(killed)).toBe('console host query timed out');

    const signalled = Object.assign(new Error('Command failed'), { signal: 'SIGTERM' });
    expect(queryFailureReason(signalled)).toBe('console host query timed out');

    expect(queryFailureReason(new Error('the helper timed out'))).toBe(
      'console host query failed: the helper timed out',
    );
  });

  it('resolves when the batch has listed and ended, and not before', async () => {
    let resolveList: (hosts: readonly ConsoleHostProcess[]) => void = () => undefined;
    const ended: number[] = [];
    const queue = createConsoleHostQueue({
      parentPid: daemon,
      coalesceMs: 20,
      toleranceMs: tolerance,
      list: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
      endProcess: (pid) => {
        ended.push(pid);
      },
    });
    queue.push({ id: 's', window, log: () => undefined });
    let settled = false;
    const done = queue.whenSettled().then(() => {
      settled = true;
    });
    await pause(50);
    expect(settled).toBe(false);
    expect(ended).toEqual([]);
    resolveList([host({ pid: 80, creationTime: 1_040 })]);
    await done;
    expect(settled).toBe(true);
    expect(ended).toEqual([80]);
  });

  it('waits for both batches when their process lists overlap', async () => {
    vi.useFakeTimers();
    const finish: Array<(hosts: readonly ConsoleHostProcess[]) => void> = [];
    const ended: number[] = [];
    try {
      const queue = createConsoleHostQueue({
        parentPid: daemon,
        coalesceMs: 20,
        list: () => new Promise((resolve) => { finish.push(resolve); }),
        endProcess: (pid) => { ended.push(pid); },
      });
      queue.push({ id: 'first', window, log: () => undefined });
      await vi.advanceTimersByTimeAsync(20);
      queue.push({ id: 'second', window: { t0: 2_000, t1: 2_100 }, log: () => undefined });
      await vi.advanceTimersByTimeAsync(20);
      expect(finish).toHaveLength(2);

      let settled = false;
      const done = queue.whenSettled().then(() => { settled = true; });
      finish[0]?.([host({ pid: 80, creationTime: 1_040 })]);
      await vi.advanceTimersByTimeAsync(0);
      expect(ended).toEqual([80]);
      expect(settled).toBe(false);

      finish[1]?.([host({ pid: 81, creationTime: 2_040 })]);
      await done;
      expect(ended).toEqual([80, 81]);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
