/**
 * The pid guards of the deferred start. node-pty 1.2.0-beta.18 creates a
 * Windows terminal's program only once its output worker has connected, and
 * reports pid 0 until then; a start whose connection fails reports an exit
 * with no pid instead. These drive the session and its manager with stand-in
 * terminals whose pids do exactly that, and prove the three guards: a kill
 * waits for the pid and then walks the real one, never 0; a session whose
 * program never appears has nothing walked on its behalf; and the shutdown
 * batch never includes a session at 0. Each guard is what stands between a
 * pid-0 session and `taskkill /PID 0` / `process.kill(0)`, which on Windows
 * targets the caller itself.
 */

import { spawn } from 'node:child_process';
import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { Session } from '../../src/core/session.js';
import type { TreeKiller } from '../../src/core/session.js';
import type { Logger } from '../../src/core/types.js';

type ExitListener = (event: { exitCode: number; signal?: number }) => void;

/** A stand-in terminal whose pid is 0 until the test makes it real. */
class LatePidPty implements IPty {
  pidValue = 0;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'true';
  handleFlowControl = false;
  readonly exitListeners: ExitListener[] = [];

  get pid(): number {
    return this.pidValue;
  }
  onData(): { dispose(): void } {
    return { dispose(): void {} };
  }
  onExit(listener: ExitListener): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose(): void {} };
  }
  resize(): void {}
  clear(): void {}
  write(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

const ignore = (): void => undefined;

/** A session around one stand-in terminal, recording every tree it walks. */
function sessionAround(
  pty: LatePidPty,
  logger: Logger = { debug: ignore, info: ignore, warn: ignore, error: ignore },
  pidWaitMs = 200,
): { session: Session; walked: number[][]; logger: Logger } {
  const walked: number[][] = [];
  const treeKiller: TreeKiller = (pids) => {
    walked.push([...pids]);
    return Promise.resolve(null);
  };
  const session = new Session(
    'guarded',
    { command: 'cmd.exe', shell: true },
    {
      platform: 'win32',
      logger,
      spawn: () => pty,
      queueConsoleHostEnd: () => undefined,
      registerConsoleHostWindow: () => undefined,
      treeKiller,
      pidWaitMs,
    },
  );
  return { session, walked, logger };
}

/** A program that stays up until the test ends it, as the "real" pid. */
function stayingProgram(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('the child did not start');
  return {
    pid,
    stop: (): void => {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    },
  };
}

describe('a kill of a session whose pid has not appeared yet', () => {
  it('waits for the program and walks the real pid, never 0', async () => {
    const program = stayingProgram();
    try {
      const pty = new LatePidPty();
      const walked: number[][] = [];
      const errors: string[] = [];
      const treeKiller: TreeKiller = (pids) => {
        walked.push([...pids]);
        return Promise.resolve(null);
      };
      const session = new Session(
        'late-pid',
        { command: 'cmd.exe', shell: true },
        {
          platform: 'win32',
          logger: {
            debug: ignore,
            info: ignore,
            warn: ignore,
            error: (message) => errors.push(message),
          },
          spawn: () => pty,
          queueConsoleHostEnd: () => undefined,
          registerConsoleHostWindow: () => undefined,
          treeKiller,
        },
      );
      // The program appears 120 ms after the spawn, as node-pty's deferred
      // connection makes real ones do.
      setTimeout(() => {
        pty.pidValue = program.pid;
      }, 120);

      await session.kill();
      expect(walked).toEqual([[program.pid]]);
    } finally {
      program.stop();
    }
  });

  it('walks nothing for a session that ended before any program existed', async () => {
    const pty = new LatePidPty();
    const errors: string[] = [];
    const logger: Logger = {
      debug: ignore,
      info: ignore,
      warn: ignore,
      error: (message) => errors.push(message),
    };
    const { session, walked } = sessionAround(pty, logger);
    // The start's connection failed: an exit with a code and no pid, which is
    // the program's end as far as the session can tell.
    pty.exitListeners[0]?.({ exitCode: -1, signal: undefined });

    await session.kill();
    expect(session.exited).toBe(true);
    expect(walked).toEqual([]);
    expect(errors.some((message) => message.includes('SURVIVED'))).toBe(false);
  });

  it('walks nothing when the wait runs out with no program and no exit', async () => {
    const pty = new LatePidPty();
    const errors: string[] = [];
    const logger: Logger = {
      debug: ignore,
      info: ignore,
      warn: ignore,
      error: (message) => errors.push(message),
    };
    // The short wait stands for the real bound: nothing appeared and nothing
    // ended, as a daemon whose event loop was held past node-pty's own
    // five-second connection bound would see.
    const { session, walked } = sessionAround(pty, logger, 150);

    await session.kill();
    expect(session.exited).toBe(false);
    expect(walked).toEqual([]);
    // A liveness probe of pid 0 answers as though something were there on
    // Windows, so no survivor may be claimed for it either.
    expect(errors.some((message) => message.includes('SURVIVED'))).toBe(false);
  });
});

describe('the shutdown batch', () => {
  it('never includes a session whose program has not appeared', async () => {
    const program = stayingProgram();
    try {
      const starting = new LatePidPty();
      const running = new LatePidPty();
      running.pidValue = program.pid;
      const spawnQueue = [starting, running];
      const walked: number[][] = [];
      const treeKiller: TreeKiller = (pids) => {
        walked.push([...pids]);
        return Promise.resolve(null);
      };
      const manager = new SessionManager(compilePolicy(undefined), undefined, {
        platform: 'win32',
        treeKiller,
        spawn: () => spawnQueue.shift() ?? new LatePidPty(),
        queueConsoleHostEnd: () => undefined,
        registerConsoleHostWindow: () => undefined,
        // Short, so the shutdown's own wait for the missing program ends
        // quickly; the session stays live and unrecorded, which is the state
        // whose pid must not reach the batch.
        pidWaitMs: 150,
      });
      manager.create({ command: 'cmd.exe', shell: true });
      manager.create({ command: 'cmd.exe', shell: true });

      await manager.killAll();
      // The one batch run holds the real program's pid, and no run — the
      // batch, or a session's own fallback walk of a stand-in that never
      // ends — ever holds a 0. (The second walk of the real pid is the
      // stand-in's own kill: nothing tells it its tree died, as the batch's
      // taskkill would tell a real one.)
      expect(walked[0]).toEqual([program.pid]);
      expect(walked.some((run) => run.includes(0))).toBe(false);
    } finally {
      program.stop();
    }
  });
});

describe('startedProgramPid', () => {
  it('resolves the pid once the program exists, null when none ever did', async () => {
    const appears = new LatePidPty();
    const appearing = sessionAround(appears).session;
    setTimeout(() => {
      appears.pidValue = 4321;
    }, 60);
    await expect(appearing.startedProgramPid()).resolves.toBe(4321);

    const failed = new LatePidPty();
    const ended = sessionAround(failed).session;
    failed.exitListeners[0]?.({ exitCode: 216, signal: undefined });
    await expect(ended.startedProgramPid()).resolves.toBeNull();
    expect(ended.startFailure()).toBe('Cannot create process, error code: 216');

    const timedOut = new LatePidPty();
    const never = sessionAround(timedOut).session;
    timedOut.exitListeners[0]?.({ exitCode: -1, signal: undefined });
    await expect(never.startedProgramPid()).resolves.toBeNull();
    expect(never.startFailure()).toBe(
      'the ConPTY output worker never connected, so node-pty never created the program',
    );
  });
});
