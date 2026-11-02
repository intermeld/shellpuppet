/**
 * Session registry: ids, policy enforcement, cleanup (design §2.4).
 *
 * The manager is where policy meets the pre-wrap command (design §4.3): it
 * evaluates `command args…` exactly as the caller passed them, and only then
 * hands off to `Session`, which applies the platform shell wrapper at spawn.
 */

import { Session, TREE_KILL_TIMEOUT_MS, taskkillTrees } from './session.js';
import type { SessionDeps } from './session.js';
import { whenConsoleHostBatchSettled } from './windowsConsoleHost.js';
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

export class SessionStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStartError';
  }
}

/** node-pty 1.2.0-beta.18's lib/windowsConoutConnection.js waits this long in dispose before terminating its worker. */
export const CONPTY_WORKER_DISPOSAL_MS = 1_000;
/** Margin for the scheduled termination and a short pause before another start. */
export const CONPTY_START_RETRY_DELAY_MS = 100;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly logger: Logger;
  private readonly sessionDeps: SessionDeps;
  private policy: CompiledPolicy;
  private seq = 0;
  private readonly starting = new Set<string>();
  private readonly cancelledStarts = new Set<string>();

  constructor(
    policy: CompiledPolicy,
    logger: Logger = NULL_LOGGER,
    deps: SessionDeps = {},
    private readonly onRemoved: (id: string) => void = () => undefined,
  ) {
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

  /** Finish the deferred Windows start contract, retrying one proven worker
   * connection timeout under the same id after the failed attempt is ended.
   * The starting reservation remains in the capacity count throughout.
   */
  async finishStart(session: Session, options: SessionOptions): Promise<Session> {
    this.starting.add(session.id);
    let current = session;
    const registered = (allowOwnKill = false): boolean =>
      this.sessions.get(session.id) === current &&
      !this.cancelledStarts.has(session.id) &&
      (allowOwnKill || !current.isKilled);
    const discard = (): void => {
      if (this.sessions.get(session.id) !== current) return;
      this.sessions.delete(session.id);
      this.onRemoved(session.id);
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const pid = await current.startedProgramPid();
        if (!registered()) {
          await current.kill();
          discard();
          throw new SessionStartError('Session start was cancelled.');
        }
        if (pid !== null) return current;
        const retry = attempt === 0 && current.conptyConnectionTimedOut;
        const failure = current.startFailure();
        await current.kill();
        if (!retry) {
          discard();
          throw new SessionStartError(failure);
        }
        // The first attempt's host must be ended before the id is reused.
        // The queue can settle after exhausting its attempts without ending it.
        const hostEnded = await current.whenConsoleHostSettled();
        await whenConsoleHostBatchSettled();
        if (!hostEnded) {
          discard();
          throw new SessionStartError(failure);
        }
        if (!registered(true)) throw new SessionStartError('Session start was cancelled.');
        await new Promise<void>((resolve) => setTimeout(resolve, CONPTY_WORKER_DISPOSAL_MS + CONPTY_START_RETRY_DELAY_MS));
        if (!registered(true)) throw new SessionStartError('Session start was cancelled.');
        this.logger.warn('session ConPTY start retry', { id: session.id, delayMs: CONPTY_START_RETRY_DELAY_MS });
        try {
          current = new Session(session.id, options, { ...this.sessionDeps, retryAttempt: true });
        } catch (error) {
          discard();
          throw error;
        }
        this.sessions.set(session.id, current);
      }
      throw new Error('unreachable start attempt');
    } finally {
      this.starting.delete(session.id);
      this.cancelledStarts.delete(session.id);
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  /** Live sessions, including an exited first attempt holding a retry slot. */
  liveCount(): number {
    return [...this.sessions.values()].filter((s) => !s.exited || this.starting.has(s.id)).length;
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
      this.onRemoved(id);
      // The process is already dead; kill() just releases the PTY handles
      // and disposes the renderer. It deliberately does NOT tree-kill: the
      // root has been gone for the whole grace period, so there is nothing
      // to walk the tree from and the process group id may have been
      // recycled. A grandchild that outlived its parent is left
      // running, which is a residual risk stated in
      // `docs/reference/security-model.md` rather than a case to guess at.
      // The one exception is a session that ended without its program being
      // seen to end (`Session.programEnded`): the session ends that program
      // at once, and kill() waits for it, or walks the tree if it has not.
      await session.kill();
      reaped.push(id);
    }
    return reaped;
  }

  /** Tree-kill one session and drop it from the registry. */
  async kill(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    if (this.starting.has(id)) this.cancelledStarts.add(id);
    await session.kill();
    this.sessions.delete(id);
    this.onRemoved(id);
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
   * bound would cut short the very run it exists for.
   *
   * Before any of that, every session's program is waited for
   * (`Session.startedProgramPid`): node-pty creates a Windows terminal's
   * program only after its output worker connects, so a session started in
   * the moment of shutdown has no pid yet. That wait has its own bound (above
   * node-pty's five-second connection limit) and sits outside `timeoutMs`, so
   * the per-session teardown budget is spent on teardown, not on waiting, and
   * each kill is still awaited and verified.
   *
   * So shutdown takes at most the program wait (`PROGRAM_PID_WAIT_MS`), plus
   * the tree kill's cap, plus `timeoutMs`. A session whose program wait ran
   * out is not waited for again by its own kill.
   *
   * Each kill is bounded so shutdown ALWAYS completes. An unbounded teardown
   * that wedges leaves the daemon alive but undiscoverable. That is worse than
   * a best-effort kill, because the user can then only end it via Task
   * Manager, and every future client sees a stale state file. A kill that
   * overruns is logged and abandoned.
   */
  async killAll(timeoutMs = 10_000): Promise<void> {
    const all = [...this.sessions.values()];
    for (const session of all) {
      if (this.starting.has(session.id)) this.cancelledStarts.add(session.id);
      this.sessions.delete(session.id);
      this.onRemoved(session.id);
    }
    await Promise.all(all.map(async (session) => {
      await session.startedProgramPid();
    }));
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
    // A pid of 0 is a program node-pty has not created yet (its deferred
    // connection); such a session's own kill waits for the pid and then walks
    // its tree, and a start whose connection failed has nothing to walk.
    const pids = sessions
      .filter((session) => !session.programEnded && session.pid > 0)
      .map((session) => session.pid);
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
