import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { MUSE_SUBMIT_DELAY_MS, Session } from '../../src/core/session.js';

class RecordingPty implements IPty {
  readonly pid = 0;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'stand-in';
  handleFlowControl = false;
  events: string[] = [];
  dead = false;
  private exitListener: ((event: { exitCode: number }) => void) | undefined;
  onData(listener: (data: string) => void): { dispose(): void } {
    void listener;
    return { dispose(): void {} };
  }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListener = listener;
    return { dispose(): void {} };
  }
  end(): void { this.dead = true; this.exitListener?.({ exitCode: 0 }); }
  resize(): void { this.events.push('resize'); }
  clear(): void {}
  write(data: string): void { this.events.push(this.dead ? `dead:${data}` : data); }
  kill(): void { this.dead = true; }
  pause(): void {}
  resume(): void {}
}

function make(agent = 'muse'): { session: Session; pty: RecordingPty } {
  const pty = new RecordingPty();
  const session = new Session('review', { command: process.execPath, shell: false, agent }, {
    platform: 'linux', spawn: () => pty, pidWaitMs: 0,
  });
  return { session, pty };
}

describe('Muse delayed submission', () => {
  it('orders later type, key and resize after Enter', async () => {
    const { session, pty } = make();
    const submit = session.write('hello\r');
    await new Promise((resolve) => setTimeout(resolve, MUSE_SUBMIT_DELAY_MS / 4));
    const resize = session.resize(90, 30);
    const laterType = session.write('next');
    const key = session.write('\x1b[A');
    await Promise.all([submit, resize, laterType, key]);
    expect(pty.events).toEqual(['hello', '\r', 'resize', 'next', '\x1b[A']);
  });

  it('never writes Enter after the session exits during the delay', async () => {
    const { session, pty } = make();
    const submit = session.write('hello\r');
    await new Promise((resolve) => setTimeout(resolve, MUSE_SUBMIT_DELAY_MS / 4));
    pty.end();
    await expect(submit).rejects.toThrow(/exited/);
    expect(pty.events).toEqual(['hello']);
  });

  it('never writes Enter after a kill during the delay', async () => {
    const { session, pty } = make();
    const submit = session.write('hello\r');
    await new Promise((resolve) => setTimeout(resolve, MUSE_SUBMIT_DELAY_MS / 4));
    await session.kill();
    await expect(submit).rejects.toThrow(/exited/);
    expect(pty.events).toEqual(['hello']);
  });

  it.each(['first\rsecond\r', 'first\nsecond\r'])(
    'leaves input with an earlier Enter %j in one write', async (input) => {
      const { session, pty } = make();
      await session.write(input);
      expect(pty.events).toEqual([input]);
    },
  );
});
