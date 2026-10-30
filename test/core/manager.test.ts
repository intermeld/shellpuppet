import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { TREE_KILL_TIMEOUT_MS } from '../../src/core/session.js';
import type { SessionDeps, TreeKiller } from '../../src/core/session.js';
import type { Logger } from '../../src/core/types.js';

/**
 * `killAll` must always complete, even when a session's teardown wedges.
 * A daemon that hangs mid-shutdown stays alive but undiscoverable.
 */
describe('SessionManager.killAll bounding', () => {
  function managerWithSessions(kills: (() => Promise<void>)[]): {
    manager: SessionManager;
    warnings: string[];
  } {
    const warnings: string[] = [];
    // The per-session path, which every platform takes; Windows adds one
    // tree kill in front of it (below).
    const manager = new SessionManager(compilePolicy(undefined), warningLogger(warnings), {
      platform: 'linux',
    });
    // Register stand-in sessions directly: this is about teardown control
    // flow, not about spawning real PTYs (that is covered by integration).
    const sessions = manager as unknown as {
      sessions: Map<string, { id: string; kill: () => Promise<void> }>;
    };
    kills.forEach((kill, index) => {
      const id = `s${String(index + 1)}`;
      sessions.sessions.set(id, { id, kill });
    });
    return { manager, warnings };
  }

  it('resolves promptly even when a kill never settles, and warns about it', async () => {
    vi.useFakeTimers();
    try {
      let secondFinished = false;
      const { manager, warnings } = managerWithSessions([
        () => new Promise<void>(() => undefined), // never settles, like a wedged taskkill
        () =>
          Promise.resolve().then(() => {
            secondFinished = true;
          }),
      ]);

      const done = manager.killAll(1_000);
      let settled = false;
      void done.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_500);
      await done;

      expect(settled).toBe(true);
      expect(secondFinished).toBe(true); // healthy sessions are not held up
      expect(warnings.some((w) => w.includes('exceeded its budget'))).toBe(true);
      // The registry is cleared regardless, so nothing is retried forever.
      expect(manager.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not warn when every teardown completes in time', async () => {
    const { manager, warnings } = managerWithSessions([
      () => Promise.resolve(),
      () => Promise.resolve(),
    ]);
    await manager.killAll(1_000);
    expect(warnings).toEqual([]);
    expect(manager.size()).toBe(0);
  });
});

function warningLogger(warnings: string[], fields: Record<string, unknown>[] = []): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, meta) => {
      warnings.push(message);
      fields.push(meta ?? {});
    },
    error: () => undefined,
  };
}

/**
 * Every `taskkill` run enumerates every process on the machine before it
 * kills anything, so concurrent runs contend: thirty of them, one per
 * session, each overran the 30 s cap, where one run given all thirty pids
 * took 10 s. So on Windows `killAll` kills every live tree in one run, then
 * kills each session.
 */
describe('SessionManager.killAll tree kill in one run', () => {
  interface StandIn {
    id: string;
    pid: number;
    exited: boolean;
    programEnded: boolean;
    kill: () => Promise<void>;
  }

  function managerWith(
    standIns: StandIn[],
    deps: SessionDeps,
  ): { manager: SessionManager; warnings: string[]; fields: Record<string, unknown>[] } {
    const warnings: string[] = [];
    const fields: Record<string, unknown>[] = [];
    const manager = new SessionManager(compilePolicy(undefined), warningLogger(warnings, fields), deps);
    const registry = manager as unknown as { sessions: Map<string, StandIn> };
    for (const standIn of standIns) registry.sessions.set(standIn.id, standIn);
    return { manager, warnings, fields };
  }

  function recorded(events: string[]): {
    treeKiller: TreeKiller;
    standIn: (id: string, pid: number, exited?: boolean, programEnded?: boolean) => StandIn;
  } {
    return {
      treeKiller: (pids) => {
        events.push(`trees ${pids.join(',')}`);
        return Promise.resolve(null);
      },
      standIn: (id, pid, exited = false, programEnded = exited) => ({
        id,
        pid,
        exited,
        programEnded,
        kill: () => {
          events.push(`kill ${id}`);
          return Promise.resolve();
        },
      }),
    };
  }

  it('kills every live tree in one run on Windows, before any session is killed', async () => {
    const events: string[] = [];
    const { treeKiller, standIn } = recorded(events);
    const { manager, warnings } = managerWith(
      [standIn('s1', 101), standIn('s2', 102), standIn('s3', 103, true)],
      { platform: 'win32', treeKiller },
    );

    await manager.killAll(1_000);

    // An exited session has no tree left to walk, so its pid is left out.
    expect(events).toEqual(['trees 101,102', 'kill s1', 'kill s2', 'kill s3']);
    expect(warnings).toEqual([]);
  });

  it('still kills every session when that run times out', async () => {
    const events: string[] = [];
    const { standIn } = recorded(events);
    const { manager, warnings, fields } = managerWith([standIn('s1', 101)], {
      platform: 'win32',
      treeKiller: () => Promise.resolve({ timedOut: true, exitCode: null, elapsedMs: 30_000 }),
    });

    await manager.killAll(1_000);

    expect(events).toEqual(['kill s1']);
    expect(warnings).toEqual(['shutdown tree kill timed out; each session still running is killed on its own']);
    // The fields are what a reader of the log diagnoses from.
    expect(fields).toEqual([
      { sessions: 1, timedOut: true, exitCode: null, elapsedMs: 30_000, timeoutMs: TREE_KILL_TIMEOUT_MS },
    ]);
  });

  it('walks the tree of a session that ended without its program being seen to end', async () => {
    const events: string[] = [];
    const { treeKiller, standIn } = recorded(events);
    // s1's terminal closed with no exit code, and its program may run on.
    const { manager } = managerWith([standIn('s1', 101, true, false), standIn('s2', 102, true)], {
      platform: 'win32',
      treeKiller,
    });

    await manager.killAll(1_000);

    expect(events).toEqual(['trees 101', 'kill s1', 'kill s2']);
  });

  it('runs no tree kill when no session is live', async () => {
    const events: string[] = [];
    const { treeKiller, standIn } = recorded(events);
    const { manager } = managerWith([standIn('s1', 101, true)], { platform: 'win32', treeKiller });

    await manager.killAll(1_000);

    expect(events).toEqual(['kill s1']);
  });

  it('leaves other platforms to the process-group kill of each session', async () => {
    const events: string[] = [];
    const { treeKiller, standIn } = recorded(events);
    const { manager } = managerWith([standIn('s1', 101), standIn('s2', 102)], {
      platform: 'linux',
      treeKiller,
    });

    await manager.killAll(1_000);

    expect(events).toEqual(['kill s1', 'kill s2']);
  });
});

/**
 * A natural exit cleans up the same way a kill does: reapExited releases an
 * exited session once a grace period lapses, while keeping it readable
 * during it (agents read the final screen after exit).
 */
describe('SessionManager.reapExited', () => {
  interface StandIn {
    id: string;
    exited: boolean;
    exitedAt: number | null;
    killed: boolean;
    kill: () => Promise<void>;
  }

  function managerWith(standIns: Omit<StandIn, 'killed' | 'kill'>[]): {
    manager: SessionManager;
    all: StandIn[];
  } {
    const manager = new SessionManager(compilePolicy(undefined));
    const map = (manager as unknown as { sessions: Map<string, StandIn> }).sessions;
    const all = standIns.map((s) => {
      const standIn: StandIn = {
        ...s,
        killed: false,
        kill: () => {
          standIn.killed = true;
          return Promise.resolve();
        },
      };
      map.set(standIn.id, standIn);
      return standIn;
    });
    return { manager, all };
  }

  it('reaps sessions whose grace has lapsed and reports their ids', async () => {
    const { manager, all } = managerWith([
      { id: 's1', exited: true, exitedAt: Date.now() - 10_000 },
      { id: 's2', exited: true, exitedAt: Date.now() - 10_000 },
    ]);
    const reaped = await manager.reapExited(5_000);
    expect(reaped.sort()).toEqual(['s1', 's2']);
    expect(manager.size()).toBe(0);
    expect(all.every((s) => s.killed)).toBe(true);
  });

  it('keeps exited sessions readable during the grace period', async () => {
    const { manager } = managerWith([
      { id: 's1', exited: true, exitedAt: Date.now() - 1_000 },
    ]);
    expect(await manager.reapExited(60_000)).toEqual([]);
    expect(manager.get('s1')).toBeDefined();
  });

  it('never touches live sessions, whatever the grace', async () => {
    const { manager, all } = managerWith([
      { id: 's1', exited: false, exitedAt: null },
      { id: 's2', exited: true, exitedAt: Date.now() - 10_000 },
    ]);
    const reaped = await manager.reapExited(0);
    expect(reaped).toEqual(['s2']);
    expect(manager.get('s1')).toBeDefined();
    expect(all[0]?.killed).toBe(false);
  });
});
