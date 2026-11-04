import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { MUSE_SUBMIT_DELAY_MS, Session } from '../../src/core/session.js';

class RecordingPty implements IPty {
  readonly pid = 0;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'stand-in';
  handleFlowControl = false;
  readonly writes: { data: string; at: number }[] = [];
  onData(): { dispose(): void } { return { dispose(): void {} }; }
  onExit(): { dispose(): void } { return { dispose(): void {} }; }
  resize(): void {}
  clear(): void {}
  write(data: string): void { this.writes.push({ data, at: Date.now() }); }
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

function recordingSession(agent: string): { session: Session; pty: RecordingPty } {
  const pty = new RecordingPty();
  const session = new Session('input-order', { command: process.execPath, shell: false, agent }, {
    platform: 'linux', spawn: () => pty,
  });
  return { session, pty };
}

describe('Muse input submission', () => {
  it('writes Enter after the delay and before a following write', async () => {
    const { session, pty } = recordingSession('muse');
    const submitting = session.write('hello\r');
    const following = session.write('after');
    await Promise.all([submitting, following]);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r', 'after']);
    // Timers and Date.now() on Windows can disagree by a millisecond or two.
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual(MUSE_SUBMIT_DELAY_MS - 5);
  });

  it('keeps other agents and key or unfinished writes in one write', async () => {
    const codex = recordingSession('codex');
    await codex.session.write('hello\r');
    expect(codex.pty.writes.map((entry) => entry.data)).toEqual(['hello\r']);
    const muse = recordingSession('muse');
    await muse.session.write('\r');
    await muse.session.write('hello');
    expect(muse.pty.writes.map((entry) => entry.data)).toEqual(['\r', 'hello']);
  });
});
