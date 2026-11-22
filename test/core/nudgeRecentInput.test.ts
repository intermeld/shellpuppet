import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import { expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';

function fixture(onWrite: (data: string) => void = () => {}) {
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 120, rows: 34, process: 'fixture', handleFlowControl: false,
    onData(listener) { output = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
    write: onWrite, resize() {}, kill() {}, clear() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('recent-input', { command: process.execPath, shell: false,
    agent: 'claude', cols: pty.cols, rows: pty.rows }, { platform: 'linux', spawn: () => pty, pidWaitMs: 0 });
  const paint = (capture: string) => output('\x1b[2J\x1b[H' +
    fs.readFileSync(path.join(__dirname, '../fixtures/reasoning', capture + '.ansi'), 'utf8'));
  return { session, paint };
}

it.each(['claude-answered', 'claude-thinking'])('protects recent input across an empty repaint of %s', async capture => {
  const { session, paint } = fixture();
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    paint(capture);
    await session.snapshot();
    session.nudgeState(now);
    now += 2_000;
    const queued = capture === 'claude-thinking';
    expect(session.nudgeState(now, 'queue')).toMatchObject({ ready: true, queued });
    await session.write('first', { humanInput: true });
    paint(capture);
    await session.snapshot();
    now += 9_000;
    expect(session.nudgeState(now, 'queue')).toMatchObject({ ready: false, reason: 'recent-input' });
    await session.write('second'); // Ordinary CLI input also starts a fresh quiet period.
    now += 9_999;
    await session.write('\x1b[I', { terminalReport: true });
    for (const policy of ['skip', 'queue', undefined] as const) {
      expect(session.nudgeState(now, policy)).toMatchObject({ ready: false, reason: 'recent-input' });
    }
    now++;
    expect(session.nudgeState(now, 'queue')).toMatchObject({ ready: true, queued });
    expect(session.nudgeReady(now)).toBe(true);
  } finally { clock.mockRestore(); await session.kill(); }
});

it('releases recent input when the typed turn is confirmed', async () => {
  const draft = 'Look at the files in this folder, then work out 17 times 23, and reply with only the word PINEAPPLE.';
  const { session, paint } = fixture(data => {
    if (data === draft) paint('claude-prompt-typed');
    if (data === '\r') paint('claude-answered');
  });
  try {
    paint('claude-answered');
    await session.snapshot();
    await session.write('x');
    expect(session.nudgeState(Date.now(), 'skip').reason).toBe('recent-input');
    expect(await session.writeWithResult(draft + '\r')).toMatchObject({ submitted: true });
    expect(session.nudgeState(session.lastChangeAt() + 1_500, 'skip').ready).toBe(true);
  } finally { await session.kill(); }
});
