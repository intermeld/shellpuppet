import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { MUSE_SUBMIT_DELAY_MS, NUDGE_SUBMIT_DELAY_MS, Session } from '../../src/core/session.js';

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
  it('submits a Codex nudge after a separate delay', async () => {
    const { session, pty } = recordingSession('codex');
    const phases: string[] = [];
    expect(await session.writeNudge('fixed nudge\r', (_screen, phase) => {
      phases.push(phase);
      return true;
    })).toBe('sent');
    expect(phases).toEqual(['before', 'submit']);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', '\r']);
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual(NUDGE_SUBMIT_DELAY_MS - 5);
  });

  it('leaves a Codex nudge visible when a prompt opens during the delay', async () => {
    const { session, pty } = recordingSession('codex');
    let promptOpen = false;
    const pending = session.writeNudge('fixed nudge\r', (_screen, phase) =>
      phase === 'before' || !promptOpen);
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    promptOpen = true;
    expect(await pending).toBe('aborted');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge']);
  });

  it('leaves a Codex nudge visible when another input is queued during the delay', async () => {
    const { session, pty } = recordingSession('codex');
    const pending = session.writeNudge('fixed nudge\r', () => true);
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = session.write('other');
    expect(await pending).toBe('aborted');
    await other;
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', 'other']);
  });
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

  it('leaves a typed nudge unsubmitted when a prompt opens during the delay', async () => {
    const { session, pty } = recordingSession('muse');
    let promptOpen = false;
    const phases: string[] = [];
    const pending = session.writeNudge('fixed nudge\r', (_screen, phase) => {
      phases.push(phase);
      return phase === 'before' || !promptOpen;
    });
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    promptOpen = true;
    expect(await pending).toBe('aborted');
    expect(phases).toEqual(['before', 'submit']);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge']);
  });

  it('leaves a typed nudge unsubmitted when other input is queued during the delay', async () => {
    const { session, pty } = recordingSession('muse');
    const pending = session.writeNudge('fixed nudge\r', () => true);
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = session.write('other');
    expect(await pending).toBe('aborted');
    await other;
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', 'other']);
  });

  it('advances the screen revision for every applied resize', async () => {
    const { session } = recordingSession('muse');
    const before = session.nudgeScreenRevision();
    await session.resize(80, 24);
    expect(session.nudgeScreenRevision()).toBe(before + 1);
    await session.resize(90, 30);
    expect(session.nudgeScreenRevision()).toBe(before + 2);
  });
});
