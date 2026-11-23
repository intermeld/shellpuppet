import type { IPty } from 'node-pty';
import { expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';
import type { NudgeVerdict } from '../../src/core/nudge.js';
import { terminalReportKind } from '../../src/daemon/terminalReports.js';

class InputPty implements IPty {
  readonly pid = 0;
  readonly cols = 120;
  readonly rows = 34;
  readonly process = 'stand-in';
  handleFlowControl = false;
  readonly writes: string[] = [];
  onData(): { dispose(): void } { return { dispose(): void {} }; }
  onExit(): { dispose(): void } { return { dispose(): void {} }; }
  resize(): void {}
  clear(): void {}
  write(data: string): void { this.writes.push(data); }
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

async function pending(settleMs: number): Promise<{
  session: Session; pty: InputPty; read: (verdict: NudgeVerdict) => void;
}> {
  const pty = new InputPty();
  const session = new Session('pending-clear', { command: process.execPath, shell: false, agent: 'claude' }, {
    platform: 'linux', spawn: () => pty, pendingNudgeSettleMs: settleMs,
  });
  const read = (verdict: NudgeVerdict): void => {
    (session as unknown as { pendingComposerVerdict: () => NudgeVerdict }).pendingComposerVerdict = () => verdict;
  };
  expect(await session.writeNudgeWithReason('fixed body\r', (_screen, phase) => phase === 'before')).toBe('aborted-line-not-seen');
  expect(session.nudgePendingLine()).toBe('fixed body');
  return { session, pty, read };
}

it('keeps a pending body through input and an empty reading until the quiet period ends', async () => {
  const { session, read } = await pending(300);
  read({ ready: true });
  await session.write('\x15', { humanInput: true });
  expect(await session.clearConsumedNudge()).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 330));
  expect(await session.clearConsumedNudge()).toBe(true);
  expect(session.nudgePendingLine()).toBeNull();
}, 10_000);

it('clears after submitted input was seen busy and then positively empty', async () => {
  const { session, pty, read } = await pending(30_000);
  vi.spyOn(session, 'waitForTypedDraft').mockResolvedValue(true);
  vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation(() => !pty.writes.includes('\r'));
  await session.write('person\r', { humanInput: true });
  read({ ready: false, reason: 'busy' });
  expect(await session.clearConsumedNudge()).toBe(false);
  read({ ready: true });
  expect(await session.clearConsumedNudge()).toBe(true);
}, 10_000);

it('never clears while the composer reading stays unknown', async () => {
  const { session, read } = await pending(20);
  read({ ready: false, reason: 'unknown' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await session.clearConsumedNudge()).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await session.clearConsumedNudge()).toBe(false);
  expect(session.nudgePendingLine()).toBe('fixed body');
}, 10_000);

it.each([false, true])('checks the composer below a newly running turn (line consumed: %s)', async consumed => {
  const pty = new InputPty();
  const session = new Session('turn-start', { command: process.execPath, shell: false, agent: 'muse' }, {
    platform: 'linux', spawn: () => pty,
  });
  const line = 'fixed body';
  const paint = (draft: string, busy: boolean) => '\x1b[2J\x1b[H' +
    (busy ? '◈ Working (1s · esc to interrupt)\r\n' : '') +
    '── Voice input (Alt+V to start) ──────────\r\n❯ ' + draft + '\r\n' +
    '──────────────────────────────────────────\r\n  Background task running';
  const record = pty.write.bind(pty);
  vi.spyOn(pty, 'write').mockImplementation(data => {
    record(data);
    void session['renderer'].write(paint(data === '\r' && consumed ? '' : line, data === '\r'));
  });
  try {
    await session['renderer'].write(paint('', false));
    const result = await session.writeNudgeWithReason(line + '\r', () => true, ['m1']);
    expect(result).toBe(consumed ? 'sent' : 'aborted-not-submitted');
    expect(session.nudgePendingLine()).toBe(consumed ? null : line);
    expect(pty.writes).toEqual([line, '\r']);
  } finally {
    await session['renderer'].dispose();
  }
});

it('treats a terminal report as untouched but the same bytes on the ordinary path as input', async () => {
  const { session } = await pending(30_000);
  const focusIn = '\x1b[I';
  expect(terminalReportKind(focusIn)).toBe('focus-in');
  await session.write(focusIn, { terminalReport: true });
  expect(session.nudgePendingLine()).toBe('fixed body');
  expect(session.nudgePendingUntouched()).toBe(true);
  await session.write(focusIn);
  expect(session.nudgePendingLine()).toBe('fixed body');
  expect(session.nudgePendingUntouched()).toBe(false);
}, 10_000);
