/**
 * Once node-pty has recorded a program's exit, the pid is already free:
 * the native exit thread closes the process handle before it records the
 * code, and the session's own exit follows about a second later. A tree
 * kill in that gap walks a pid Windows may have given to another process.
 */

import { spawn } from 'node:child_process';
import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/core/types.js';
import { Session } from '../../src/core/session.js';
import type { TreeKiller } from '../../src/core/session.js';
import { releaseFailedStarts } from '../../src/core/windowsPtyStart.js';

class FakePty implements IPty {
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'true';
  handleFlowControl = false;
  /** What `recordedExitCode` reads. Set when node-pty has seen the program end. */
  _agent?: { _useConpty?: boolean; exitCode?: number };

  constructor(readonly pid: number) {}
  onData(): { dispose(): void } {
    return { dispose(): void {} };
  }

  onExit(): { dispose(): void } {
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

describe('a kill once node-pty has recorded the program end', () => {
  it('does not walk the pid, which is already free to be given out', async () => {
    expect(releaseFailedStarts()).toBe(true);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('the child did not start');
    const started = Date.now();
    while (!alive(pid)) {
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
    const pty = new FakePty(pid);
    pty._agent = { _useConpty: true, exitCode: 0 };
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
      expect(alive(pid)).toBe(true);
    } finally {
      if (alive(pid)) {
        try {
          process.kill(pid);
        } catch {
          // Already gone.
        }
      }
    }
  });
});
