/**
 * A resize made before a Windows terminal's first output must not take the
 * daemon down when the program has ended by the time that output arrives.
 *
 * node-pty 1.1.0 holds a resize asked for before the terminal's first output
 * and runs it from the output socket's first 'data' event; once it has seen
 * the program end, its agent throws `Cannot resize a pty that has already
 * exited`. Thrown from that handler, the error reaches no caller and is an
 * uncaught exception, on which the daemon shuts down with every session.
 * The program here exits at once; the busy wait stands for a daemon whose
 * main thread is held by other work (other starts, a long pattern), which is
 * when node-pty learns of the exit before it reads the first output.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import type { Session } from '../../src/core/session.js';

const managers: SessionManager[] = [];
afterEach(async () => {
  while (managers.length > 0) await managers.pop()?.killAll();
});

function exitOf(session: Session): Promise<number | null> {
  return new Promise((resolve) => {
    if (session.exited) resolve(session.exitCode);
    else session.onExit(resolve);
  });
}

/** Hold the main thread, as other work on a busy daemon does. */
function holdMainThread(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy on purpose: nothing else may run meanwhile.
  }
}

describe.skipIf(process.platform !== 'win32')('a resize made before the first output (Windows)', () => {
  it('leaves the process running when the program has ended by the time that output arrives', async () => {
    const uncaught: unknown[] = [];
    const listener = (error: unknown): void => void uncaught.push(error);
    process.on('uncaughtException', listener);
    try {
      const manager = new SessionManager(compilePolicy(undefined));
      managers.push(manager);
      const session = manager.create({ command: 'exit', args: ['3'] });
      session.resize(100, 30);
      holdMainThread(500);

      // The exit event follows node-pty's first-output handler, so any error
      // that handler threw has been thrown by now.
      expect(await exitOf(session)).toBe(3);
      expect(uncaught).toEqual([]);
      // The renderer took the size asked for.
      expect([session.cols, session.rows]).toEqual([100, 30]);
      // Asked for after the exit, a resize is refused at once, to its caller.
      expect(() => session.resize(80, 24)).toThrow(/exited/);
    } finally {
      process.off('uncaughtException', listener);
    }
  });
});
