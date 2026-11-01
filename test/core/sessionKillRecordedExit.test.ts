/**
 * Once node-pty has recorded a program's exit, the pid is already free:
 * the native exit thread closes the process handle before it records the
 * code, and the session's own exit follows about a second later. A tree
 * kill in that gap walks a pid Windows may have given to another process.
 * The other case here is the fail-safe: where node-pty records no code at
 * all, an exit that carries none counts as the program's end, so no pid is
 * walked on its word alone.
 */

import { spawn } from 'node:child_process';
import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/core/types.js';
import { Session } from '../../src/core/session.js';
import type { TreeKiller } from '../../src/core/session.js';
import { releaseFailedStarts } from '../../src/core/windowsPtyStart.js';

type ExitListener = (event: { exitCode: number; signal?: number }) => void;

class FakePty implements IPty {
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'true';
  handleFlowControl = false;
  /** What `recordedExitCode` reads. Set when node-pty has seen the program end. */
  _agent?: { exitCode?: number };
  readonly exitListeners: ExitListener[] = [];

  constructor(readonly pid: number) {}
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A program that stays up until the test ends it. */
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

const ignore = (): void => undefined;
const quiet: Logger = { debug: ignore, info: ignore, warn: ignore, error: ignore };

describe('a kill once node-pty has recorded the program end', () => {
  it('does not walk the pid, which is already free to be given out', async () => {
    expect(releaseFailedStarts()).toBe(true);
    const program = stayingProgram();
    const started = Date.now();
    while (!alive(program.pid)) {
      if (Date.now() - started > 5_000) throw new Error('the child did not stay up');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const walked: number[][] = [];
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(message) {
        errors.push(message);
      },
    };
    const treeKiller: TreeKiller = (pids) => {
      walked.push([...pids]);
      return Promise.resolve(null);
    };
    const pty = new FakePty(program.pid);
    pty._agent = { exitCode: 0 };
    const session = new Session(
      'recorded',
      { command: 'cmd.exe', shell: true },
      {
        platform: 'win32',
        logger,
        spawn: () => pty,
        queueConsoleHostEnd: () => undefined,
        registerConsoleHostWindow: () => undefined,
        treeKiller,
      },
    );

    try {
      expect(session.programEnded).toBe(true);
      await session.kill();
      // A dead stand-in pid is not alive, so the tree walk is skipped whether
      // or not the program-ended guard exists. This pid is live: removing the
      // guard calls the tree killer with it.
      expect(walked).toEqual([]);
      expect(errors.some((message) => message.includes('SURVIVED'))).toBe(false);
      expect(alive(program.pid)).toBe(true);
    } finally {
      program.stop();
    }
  });

  it('walks no pid on the word of an exit with no code, where node-pty records none', async () => {
    expect(releaseFailedStarts()).toBe(true);
    const program = stayingProgram();
    const started = Date.now();
    while (!alive(program.pid)) {
      if (Date.now() - started > 5_000) throw new Error('the child did not stay up');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const walked: number[][] = [];
    const treeKiller: TreeKiller = (pids) => {
      walked.push([...pids]);
      return Promise.resolve(null);
    };
    // No `_agent`: as with a node-pty this wrapper does not know, nothing
    // records a code, so an exit with no code is the program's end.
    const pty = new FakePty(program.pid);
    const session = new Session(
      'unrecorded',
      { command: 'cmd.exe', shell: true },
      {
        platform: 'win32',
        logger: quiet,
        spawn: () => pty,
        queueConsoleHostEnd: () => undefined,
        registerConsoleHostWindow: () => undefined,
        treeKiller,
      },
    );
    pty.exitListeners[0]?.({ exitCode: undefined as unknown as number, signal: undefined });

    try {
      expect(session.exited).toBe(true);
      expect(session.exitCode).toBeNull();
      expect(session.programEnded).toBe(true);
      await session.kill();
      expect(walked).toEqual([]);
      expect(alive(program.pid)).toBe(true);
    } finally {
      program.stop();
    }
  });
});
