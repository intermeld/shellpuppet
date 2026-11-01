/**
 * A session queues its console host once, through the queue it was given.
 * The stand-in records the call. No process is started: the spawn is a
 * stand-in too, and the platform is the session's, so this runs on every
 * platform. A real POSIX daemon has platform other than Windows and queues
 * nothing.
 */

import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';
import type { QueuedConsoleHost, SpawnWindow } from '../../src/core/windowsConsoleHost.js';

/** Not a live pid, so a kill probe finds nothing and walks no tree. */
const FAKE_PID = 2_147_483_646;

class FakePty implements IPty {
  readonly pid = FAKE_PID;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'true';
  handleFlowControl = false;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  onData(): { dispose(): void } {
    return { dispose(): void {} };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListener = listener;
    return {
      dispose: (): void => {
        this.exitListener = null;
      },
    };
  }

  resize(): void {}
  clear(): void {}
  write(): void {}

  /**
   * Does not report an exit. The session's kill path has to queue on its
   * own: an exit from here would hide a missing kill call.
   */
  kill(): void {}

  pause(): void {}
  resume(): void {}

  emitExit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

function start(platform: NodeJS.Platform): {
  session: Session;
  pty: FakePty;
  queued: QueuedConsoleHost[];
  registered: SpawnWindow[];
} {
  const pty = new FakePty();
  const queued: QueuedConsoleHost[] = [];
  const registered: SpawnWindow[] = [];
  const session = new Session(
    's1',
    { command: 'true', shell: true },
    {
      platform,
      spawn: () => pty,
      queueConsoleHostEnd: (item) => {
        queued.push(item);
      },
      registerConsoleHostWindow: (_id, window, registeredPlatform) => {
        expect(registeredPlatform).toBe(platform);
        registered.push(window);
      },
      treeKiller: () => Promise.resolve(null),
    },
  );
  return { session, pty, queued, registered };
}

function queuedOnce(queued: readonly QueuedConsoleHost[]): QueuedConsoleHost {
  expect(queued).toHaveLength(1);
  const item = queued[0];
  if (item === undefined) throw new Error('expected one queued console host');
  expect(item.id).toBe('s1');
  expect(item.window.t1).toBeGreaterThanOrEqual(item.window.t0);
  return item;
}

describe('a session queues its console host once', () => {
  it('queues once when the program exits', async () => {
    const { session, pty, queued, registered } = start('win32');
    expect(registered).toHaveLength(1);
    expect(registered[0]?.t1).toBeGreaterThanOrEqual(registered[0]?.t0 ?? 0);
    pty.emitExit(0);
    queuedOnce(queued);
    await session.kill();
    expect(queued).toHaveLength(1);
  });

  it('queues once when the session is killed', async () => {
    const { session, queued } = start('win32');
    await session.kill();
    queuedOnce(queued);
  });

  it('queues once when the program exits and the session is then killed', async () => {
    const { session, pty, queued } = start('win32');
    pty.emitExit(0);
    await session.kill();
    queuedOnce(queued);
  });

  it('queues nothing when the session platform is not Windows', async () => {
    const { session, pty, queued, registered } = start('linux');
    expect(registered).toHaveLength(0);
    pty.emitExit(0);
    await session.kill();
    expect(queued).toHaveLength(0);
  });
});
