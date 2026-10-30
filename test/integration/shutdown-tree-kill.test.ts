/**
 * At shutdown on Windows every session's tree dies in one `taskkill` run, and
 * no session runs another after it. Each run enumerates every process on the
 * machine first: thirty concurrent runs, one per session, each overran the
 * 30 s cap, where one run given all thirty pids took 10 s. This drives real
 * sessions, each a shell with a program in it, and a real `taskkill`. One
 * program starts a grandchild detached from its console, which only the tree
 * walk can reach.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { TREE_KILL_TIMEOUT_MS, taskkillTrees } from '../../src/core/session.js';
import type { Session, TreeKiller } from '../../src/core/session.js';
import type { Logger } from '../../src/core/types.js';
import { repoRoot } from './helpers.js';

const sink = path.join(repoRoot, 'test', 'fixtures', 'plain-sink.mjs');
const detaching = path.join(repoRoot, 'test', 'fixtures', 'detached-grandchild.mjs');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

/** The pid the detaching fixture prints once its grandchild is running. */
async function grandchildOf(session: Session): Promise<number> {
  let pid: number | undefined;
  const found = await eventually(() => {
    const match = /grandchild (\d+)/.exec(session.getScreen());
    pid = match ? Number(match[1]) : undefined;
    return pid !== undefined;
  }, 20_000);
  if (!found || pid === undefined) throw new Error('the fixture never printed its grandchild');
  return pid;
}

describe('shutdown', () => {
  it.skipIf(process.platform !== 'win32')(
    'kills every session tree in one taskkill run on Windows, then checks each root',
    async (context) => {
      const runs: number[][] = [];
      const treeKiller: TreeKiller = (pids) => {
        runs.push([...pids]);
        return taskkillTrees(pids);
      };
      const infos: string[] = [];
      const warnings: { message: string; meta: Record<string, unknown> }[] = [];
      const errors: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: (message) => infos.push(message),
        warn: (message, meta) => warnings.push({ message, meta: meta ?? {} }),
        error: (message) => errors.push(message),
      };
      const manager = new SessionManager(compilePolicy(undefined), logger, { treeKiller });
      const sessions: Session[] = [];
      const pids: number[] = [];
      let grandchild: number | undefined;
      let killed = false;

      try {
        for (const program of [sink, sink, detaching]) {
          const session = manager.create({ command: process.execPath, args: [program] });
          sessions.push(session);
          pids.push(session.pid);
        }
        grandchild = await grandchildOf(sessions[2] as Session);
        await manager.killAll();
        killed = true;

        expect(runs[0]).toEqual(pids);
        // A machine loaded enough makes even one run overrun its cap, and then
        // each session still running falls back to its own run, by design; the
        // single run cannot be observed then, so the test says so. A run that
        // "timed out" well before the cap is a defect, not load, and fails.
        const overrun = warnings.find(({ message }) => message.startsWith('shutdown tree kill timed out'));
        if (overrun !== undefined) {
          expect(overrun.meta['elapsedMs']).toBeGreaterThanOrEqual(TREE_KILL_TIMEOUT_MS - 2_000);
          context.skip('taskkill overran its cap under this load; one run was not observable');
        }
        expect(runs).toEqual([pids]);
        expect(pids.filter(alive)).toEqual([]);
        const detached = grandchild;
        expect(await eventually(() => !alive(detached), 3_000)).toBe(true);
        expect(infos.filter((message) => message === 'session tree killed')).toHaveLength(3);
        expect(errors).toEqual([]);
      } finally {
        // A failure before the shutdown still has to take the trees down, and
        // the tree walk reaches the detached grandchild even when its pid was
        // never seen; it would otherwise outlive the test run.
        if (!killed) await manager.killAll();
        const left = grandchild === undefined ? pids : [...pids, grandchild];
        for (const pid of left.filter(alive)) {
          try {
            process.kill(pid);
          } catch {
            // Gone between the check and the kill.
          }
        }
      }
    },
  );
});
