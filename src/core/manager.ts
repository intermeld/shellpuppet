/**
 * Session registry: ids, policy enforcement, cleanup (design §2.4).
 *
 * The manager is where policy meets the pre-wrap command (design §4.3): it
 * evaluates `command args…` exactly as the caller passed them, and only then
 * hands off to `Session`, which applies the platform shell wrapper at spawn.
 */

import { Session, TREE_KILL_TIMEOUT_MS, taskkillTrees } from './session.js';
import type { SessionDeps } from './session.js';
import { checkSessionCapacity, evaluateCommand } from './policy.js';
import type { CompiledPolicy } from './policy.js';
import { NULL_LOGGER } from './types.js';
import type { Logger, SessionOptions, SessionSummary } from './types.js';

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly logger: Logger;
  private readonly sessionDeps: SessionDeps;
  private policy: CompiledPolicy;
  private seq = 0;

  constructor(policy: CompiledPolicy, logger: Logger = NULL_LOGGER, deps: SessionDeps = {}) {
    this.policy = policy;
    this.logger = logger;
    this.sessionDeps = { logger, ...deps };
  }

  /** Replace the policy. */
  setPolicy(policy: CompiledPolicy): void {
    this.policy = policy;
  }

  /**
   * Policy-check and start a session. Throws `PolicyViolationError` with the
   * policy's reason when refused. Callers map it to a 403.
   */
  create(options: SessionOptions): Session {
    const decision = evaluateCommand(this.policy, options.command, options.args ?? []);
    if (!decision.allowed) {
      this.logger.warn('session refused by policy', {
        command: options.command,
        reason: decision.reason,
      });
      throw new PolicyViolationError(decision.reason ?? 'Command refused by policy.');
    }
    const capacity = checkSessionCapacity(this.policy, this.liveCount());
    if (!capacity.allowed) {
      throw new PolicyViolationError(capacity.reason ?? 'Session limit reached.');
    }

    const id = `s${String(++this.seq)}`;
    const session = new Session(id, options, this.sessionDeps);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  /** Sessions whose process has not exited. */
  liveCount(): number {
    return [...this.sessions.values()].filter((s) => !s.exited).length;
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Reap sessions whose process exited more than `graceMs` ago, so a natural
   * exit releases the renderer and its scrollback just as a kill does,
   * rather than holding them until daemon shutdown. Agents legitimately read the
   * final screen after exit, so exited sessions stay readable during the
   * grace and their resources are released after it. Returns the
   * reaped ids so the daemon layer can revoke their viewer grants and
   * credentials and close their watcher sockets. Kill (`DELETE`) is immediate.
   */
  async reapExited(graceMs: number): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const [id, session] of [...this.sessions]) {
      if (!session.exited || session.exitedAt === null) continue;
      if (now - session.exitedAt < graceMs) continue;
      this.sessions.delete(id);
      // The process is already dead; kill() just releases the PTY handles
      // and disposes the renderer. It deliberately does NOT tree-kill: the
      // root has been gone for the whole grace period, so there is nothing
      // to walk the tree from and the process group id may have been
      // recycled. A grandchild that outlived its parent is left
      // running, which is a residual risk stated in
      // `docs/reference/security-model.md` rather than a case to guess at.
      // The one exception is a session that ended without its program being
      // seen to end (`Session.programEnded`): kill() walks that program's tree.
      await session.kill();
      reaped.push(id);
    }
    return reaped;
  }

  /** Tree-kill one session and drop it from the registry. */
  async kill(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    await session.kill();
    this.sessions.delete(id);
    return true;
  }

  /**
   * Tree-kill everything at daemon shutdown (design §2.3). The daemon must
   * never exit and strand running agent CLIs.
   *
   * On Windows every live session's tree is killed first, in one `taskkill`
   * run (`taskkillTrees` says why), so each session's own kill then finds its
   * root gone and only has its terminal left to release. That run is bounded
   * by its own cap (`TREE_KILL_TIMEOUT_MS`), not by `timeoutMs`: a shorter
   * bound would cut short the very run it exists for. So shutdown takes
   * at most that cap plus `timeoutMs`.
   *
   * Each kill is bounded so shutdown ALWAYS completes. An unbounded teardown
   * that wedges leaves the daemon alive but undiscoverable. That is worse than
   * a best-effort kill, because the user can then only end it via Task
   * Manager, and every future client sees a stale state file. A kill that
   * overruns is logged and abandoned.
   */
  async killAll(timeoutMs = 10_000): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await this.killTreesInOneRun(all);
    await Promise.all(
      all.map(async (session) => {
        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const outcome = await Promise.race([session.kill(), bound]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === 'timeout') {
          this.logger.warn('session teardown exceeded its budget, abandoning it', {
            id: session.id,
            timeoutMs,
          });
        }
      }),
    );
  }

  /**
   * Windows only: kill, in one `taskkill` run, the tree of every session
   * whose program has not been seen to end, including one whose session
   * ended without it (`Session.programEnded`).
   */
  private async killTreesInOneRun(sessions: readonly Session[]): Promise<void> {
    if ((this.sessionDeps.platform ?? process.platform) !== 'win32') return;
    const pids = sessions.filter((session) => !session.programEnded).map((session) => session.pid);
    if (pids.length === 0) return;
    const failure = await (this.sessionDeps.treeKiller ?? taskkillTrees)(pids);
    if (failure !== null) {
      this.logger.warn(
        failure.timedOut
          ? 'shutdown tree kill timed out; each session still running is killed on its own'
          : 'shutdown taskkill exited non-zero (usually descendants that vanished mid-walk)',
        { sessions: pids.length, ...failure, timeoutMs: TREE_KILL_TIMEOUT_MS },
      );
    }
  }
}
