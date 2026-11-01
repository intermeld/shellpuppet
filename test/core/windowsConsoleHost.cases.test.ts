/**
 * Console host attribution cases: touching windows, three-session overlap, a
 * session ending while another starts, a host outside every window, clock
 * skew, many sessions, and a brute-force oracle for the one-to-one assignment.
 */

import { describe, expect, it } from 'vitest';
import { createConsoleHostQueue } from '../../src/core/windowsConsoleHost.js';
import type {
  ConsoleHostProcess,
  QueuedConsoleHost,
  SpawnWindow,
} from '../../src/core/windowsConsoleHost.js';

const daemon = 4000;

function host(pid: number, creationTime: number): ConsoleHostProcess {
  return { pid, parentPid: daemon, name: 'conhost.exe', creationTime };
}

interface Window {
  id: string;
  window: SpawnWindow;
}

async function run(
  windows: readonly Window[],
  hosts: readonly ConsoleHostProcess[],
  known: readonly Window[] = [],
): Promise<number[]> {
  const ended: number[] = [];
  const queue = createConsoleHostQueue({
    parentPid: daemon,
    coalesceMs: 1,
    knownWindows: () => known,
    list: () => Promise.resolve(hosts),
    endProcess: (pid) => {
      ended.push(pid);
    },
  });
  const log: QueuedConsoleHost['log'] = () => undefined;
  for (const item of windows) queue.push({ id: item.id, window: item.window, log });
  await queue.whenSettled();
  return ended.sort((a, b) => a - b);
}

describe('console host attribution cases', () => {
  it('splits touching windows at the exact boundary', async () => {
    // A's spawn ends at 1020; B's begins at 1020. Both hosts exist.
    const ended = await run(
      [
        { id: 'a', window: { t0: 1_000, t1: 1_020 } },
        { id: 'b', window: { t0: 1_020, t1: 1_040 } },
      ],
      [host(1, 1_019), host(2, 1_020)],
    );
    expect(ended).toEqual([1, 2]);
  });

  it('resolves an overlap of three sessions by elimination', async () => {
    const ended = await run(
      [
        { id: 'a', window: { t0: 1_000, t1: 1_030 } },
        { id: 'b', window: { t0: 1_010, t1: 1_040 } },
        { id: 'c', window: { t0: 1_020, t1: 1_050 } },
      ],
      [host(1, 1_005), host(2, 1_015), host(3, 1_025)],
    );
    expect(ended).toEqual([1, 2, 3]);
  });

  it('leaks when another live session starts during the same window', async () => {
    // E ends; L started while E's spawn window was still open and is live.
    const ended = await run(
      [{ id: 'e', window: { t0: 1_000, t1: 1_010 } }],
      [host(1, 1_005), host(2, 1_009)],
      [{ id: 'l', window: { t0: 1_008, t1: 1_020 } }],
    );
    expect(ended).toEqual([]);
  });

  it('ends nothing for a host created outside every window', async () => {
    const ended = await run(
      [
        { id: 'a', window: { t0: 1_000, t1: 1_010 } },
        { id: 'b', window: { t0: 1_010, t1: 1_020 } },
      ],
      [host(9, 2_000)],
    );
    expect(ended).toEqual([]);
  });

  it('leaks rather than guesses when a host is a few ms early and its own window lost it', async () => {
    // B's host was created at 1023 but the list records 1020 (3 ms early),
    // which is inside A's window. A's own host is present, so the pair is
    // ambiguous and nothing may be ended.
    const ended = await run(
      [
        { id: 'a', window: { t0: 1_000, t1: 1_020 } },
        { id: 'b', window: { t0: 1_023, t1: 1_040 } },
      ],
      [host(1, 1_005), host(2, 1_020)],
    );
    expect(ended).toEqual([]);
  });

  it('never ends a live session host when a few ms of skew swap two windows', async () => {
    // A ended at 1020; L is live from 1022. A's host is recorded 2 ms late
    // (1022, inside L's window) and L's host 2 ms early (1020, inside A's).
    // Each window then holds only the other's host. The rule
    // says no live session's host may be ended, so nothing may be ended.
    const ended = await run(
      [{ id: 'a', window: { t0: 1_000, t1: 1_020 } }],
      [host(1, 1_022), host(2, 1_020)],
      [{ id: 'live', window: { t0: 1_022, t1: 1_040 } }],
    );
    expect(ended).toEqual([]);
  });

  it('ends every host when many sessions each have their own window', async () => {
    const windows: Window[] = [];
    const hosts: ConsoleHostProcess[] = [];
    for (let i = 0; i < 200; i += 1) {
      windows.push({ id: `s${String(i)}`, window: { t0: 1_000 + i * 20, t1: 1_005 + i * 20 } });
      hosts.push(host(10_000 + i, 1_002 + i * 20));
    }
    const started = Date.now();
    const ended = await run(windows, hosts);
    const elapsed = Date.now() - started;
    expect(ended).toHaveLength(200);
    expect(elapsed).toBeLessThan(5_000);
  });
});

/** Brute-force oracle: which session-host edges are in every maximum matching. */
function oracle(
  windows: readonly Window[],
  hosts: readonly ConsoleHostProcess[],
): Map<string, number> {
  const candidatePids = windows.map((entry) =>
    hosts
      .filter((h) => h.creationTime >= entry.window.t0 && h.creationTime <= entry.window.t1)
      .map((h) => h.pid),
  );
  const best = (forbidden: { id: string; pid: number } | null): number => {
    let max = 0;
    const search = (index: number, used: Set<number>, size: number): void => {
      if (size + (windows.length - index) <= max) return;
      if (index === windows.length) {
        if (size > max) max = size;
        return;
      }
      search(index + 1, used, size);
      const entry = windows[index];
      if (entry === undefined) return;
      for (const pid of candidatePids[index] ?? []) {
        if (used.has(pid)) continue;
        if (forbidden !== null && forbidden.id === entry.id && forbidden.pid === pid) continue;
        used.add(pid);
        search(index + 1, used, size + 1);
        used.delete(pid);
      }
    };
    search(0, new Set(), 0);
    return max;
  };
  const maximum = best(null);
  const forced = new Map<string, number>();
  for (const [index, entry] of windows.entries()) {
    for (const pid of candidatePids[index] ?? []) {
      if (best({ id: entry.id, pid }) < maximum) forced.set(entry.id, pid);
    }
  }
  return forced;
}

describe('console host assignment against a brute-force oracle', () => {
  it('agrees on 150 random overlapping cases', async () => {
    let seed = 123_456_789;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 150; round += 1) {
      const windowCount = 1 + Math.floor(random() * 4);
      const windows: Window[] = [];
      for (let i = 0; i < windowCount; i += 1) {
        const t0 = Math.floor(random() * 20);
        windows.push({ id: `w${String(i)}`, window: { t0, t1: t0 + Math.floor(random() * 10) } });
      }
      const hostCount = Math.floor(random() * 5);
      const hosts: ConsoleHostProcess[] = [];
      for (let i = 0; i < hostCount; i += 1) {
        hosts.push(host(1_000 + i, Math.floor(random() * 30)));
      }
      const forced = oracle(windows, hosts);
      const expected = windows
        .map((entry) => forced.get(entry.id))
        .filter((pid): pid is number => pid !== undefined)
        .sort((a, b) => a - b);
      const ended = await run(windows, hosts);
      expect({ round, ended }).toEqual({ round, ended: expected });
    }
  });
});
