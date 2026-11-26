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
  expect(session.nudgePendingBodyMeta()).toEqual({ pendingBody: true, typedChars: 10, submitSent: false });
  expect(session.nudgePendingSafeToSubmit()).toBe(true);
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

it('treats a terminal report as untouched but the same bytes on the ordinary path as input', async () => {
  const { session } = await pending(30_000);
  const focusIn = '\x1b[I';
  expect(terminalReportKind(focusIn)).toBe('focus-in');
  await session.write(focusIn, { terminalReport: true });
  expect(session.nudgePendingLine()).toBe('fixed body');
  expect(session.nudgePendingUntouched()).toBe(true);
  expect(session.nudgePendingSafeToSubmit()).toBe(true);
  await session.write(focusIn);
  expect(session.nudgePendingLine()).toBe('fixed body');
  expect(session.nudgePendingUntouched()).toBe(false);
  expect(session.nudgePendingSafeToSubmit()).toBe(false);
}, 10_000);

it('never treats a partly accepted body as safe to submit', async () => {
  const pty = new InputPty();
  let attempts = 0;
  vi.spyOn(pty, 'write').mockImplementation((data) => {
    if (++attempts === 2) throw new Error('input stopped');
    pty.writes.push(data);
  });
  const session = new Session('partial-body', { command: process.execPath, shell: false }, {
    platform: 'linux', spawn: () => pty,
  });
  const body = 'x'.repeat(1_025);
  await expect(session.writeNudgeWithReason(`${body}\r`, () => true)).rejects.toThrow('input stopped');
  expect(session.nudgePendingLine()).toBe(body);
  expect(session.nudgePendingBodyMeta()).toEqual({ pendingBody: true, typedChars: 1_024, submitSent: false });
  expect(session.nudgePendingSafeToSubmit()).toBe(false);
}, 10_000);
