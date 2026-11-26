import type { IPty } from 'node-pty';
import { expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';

class RecordingPty implements IPty {
  readonly pid = 0;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'stand-in';
  handleFlowControl = false;
  readonly writes: string[] = [];
  onData(): { dispose(): void } { return { dispose(): void {} }; }
  onExit(): { dispose(): void } { return { dispose(): void {} }; }
  resize(): void {}
  clear(): void {}
  write(data: string | Buffer): void { this.writes.push(data as string); }
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

function session(): { session: Session; pty: RecordingPty } {
  const pty = new RecordingPty();
  return { session: new Session('report-nudge', { command: process.execPath, shell: false }, {
    platform: 'linux', spawn: () => pty,
  }), pty };
}

it.each(['\x1b[<35;12;7M', '\x1b[M *%', '\x1b[I', '\x1b[O'])(
  'forwards a report during a nudge without aborting Enter: %j', async (report) => {
    const { session: live, pty } = session();
    const nudge = live.writeNudgeWithReason('notice\r', () => true);
    while (pty.writes.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const forwarded = live.write(report, { terminalReport: true });
    expect(await nudge).toBe('sent');
    await forwarded;
    expect(pty.writes).toEqual(['notice', '\r', report]);
    expect(live.recentInput).toBe(false);
  },
);

it('still aborts for a mixed report and keyboard write', async () => {
  const { session: live, pty } = session();
  const nudge = live.writeNudgeWithReason('notice\r', () => true);
  while (pty.writes.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const mixed = '\x1b[<35;12;7Mx';
  const forwarded = live.write(mixed);
  expect(await nudge).toBe('aborted-other-input-arrived');
  await forwarded;
  expect(pty.writes).toEqual(['notice', mixed]);
  expect(live.recentInput).toBe(true);
});

it('forwards a binary mouse report during a nudge without aborting Enter or holding later nudges', async () => {
  const { session: live, pty } = session();
  const nudge = live.writeNudgeWithReason('notice\r', () => true);
  while (pty.writes.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const click = Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x84, 0x25]);
  const forwarded = live.writeBinary(click, { terminalReport: true });
  expect(await nudge).toBe('sent');
  await forwarded;
  expect(pty.writes.slice(0, 2)).toEqual(['notice', '\r']);
  expect(pty.writes[2]).toEqual(click);
  expect(live.recentInput).toBe(false);
});

it('counts non-report binary input as typing: it aborts a nudge and starts the input hold', async () => {
  const { session: live, pty } = session();
  const nudge = live.writeNudgeWithReason('notice\r', () => true);
  while (pty.writes.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const typed = live.writeBinary(Buffer.from('x'));
  expect(await nudge).toBe('aborted-other-input-arrived');
  await typed;
  expect(live.recentInput).toBe(true);
});
