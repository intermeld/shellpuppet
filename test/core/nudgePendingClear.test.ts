import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  paint: (data: string) => void = () => {};
  onData(listener: (data: string) => void): { dispose(): void } {
    this.paint = listener;
    return { dispose(): void {} };
  }
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

const body = 'A message is waiting.';
const clear = '\x1b[2J\x1b[H';
const composer = (draft: string) => clear + '❯ ' + draft + '\r\n────────────────────';

function recipient(agent = 'muse') {
  const pty = new InputPty();
  const session = new Session('submit-check', { command: process.execPath, shell: false, agent, cols: 120, rows: 34 }, {
    platform: 'linux', spawn: () => pty,
  });
  return { session, pty };
}

it.each(['A message is wait\r\ning.', 'A message is wait\r\n ing.', ' A message is waiting.'])(
  'refuses a retained line with a hard break or extra space (%j)', async edited => {
    const { session, pty } = recipient();
    try {
      expect(await session.writeNudgeWithReason(body + '\r', (_s, phase) => phase === 'before', ['m1']))
        .toBe('aborted-line-not-seen');
      pty.paint(composer(edited));
      expect(await session.submitPendingNudge(body, () => true)).toBe('wait');
      expect(pty.writes).toEqual([body]);
    } finally { await session['renderer'].dispose(); }
  });

it.each(['prompt', 'output'])('cancels the retry after temporary %s during settle', async change => {
  const { session, pty } = recipient();
  const trust = readFileSync(join(__dirname, '../fixtures/reasoning/muse-trust.ansi'), 'utf8');
  let observed: Promise<void> | undefined;
  const record = pty.write.bind(pty);
  vi.spyOn(pty, 'write').mockImplementation(data => {
    record(data);
    if (data !== '\r') pty.paint(composer(body));
    else if (!observed) {
      pty.paint(change === 'prompt' ? clear + trust : composer(body) + '\r\nnew output');
      observed = session['renderer'].flush().then(() => {
        if (change === 'prompt') expect(session.answerablePrompt(session['renderer'].snapshot().screen)).toBeTruthy();
        pty.paint(composer(body));
      });
    }
  });
  try {
    const outcome = await session.writeNudgeWithReason(body + '\r', () => true, ['m1']);
    await observed;
    expect(pty.writes).toEqual([body, '\r']);
    expect(outcome).toBe('aborted-not-submitted');
    expect(await session.submitPendingNudge(body, () => true)).toBe('wait');
    expect(pty.writes).toEqual([body, '\r']);
  } finally { await session['renderer'].dispose(); }
});

it.each([false, true])('uses the one remaining key on a later visit (accepted: %s)', async accepted => {
  const { session, pty } = recipient();
  let checks = 0;
  const record = pty.write.bind(pty);
  vi.spyOn(pty, 'write').mockImplementation(data => {
    record(data);
    if (data !== '\r') pty.paint(composer(body));
    else if (accepted && pty.writes.length === 3) pty.paint(composer(''));
  });
  try {
    expect(await session.writeNudgeWithReason(body + '\r', (_s, phase) => phase === 'before' || ++checks === 1, ['m1']))
      .toBe('aborted-not-submitted');
    expect(pty.writes).toEqual([body, '\r']);
    expect(await session.submitPendingNudge(body, () => true)).toBe(accepted ? 'sent' : 'not-submitted');
    expect(await session.submitPendingNudge(body, () => true)).toBe('wait');
    expect(pty.writes).toEqual([body, '\r', '\r']);
  } finally { await session['renderer'].dispose(); }
});

it('retains ownership if an ignored key briefly paints an empty composer', async () => {
  const { session, pty } = recipient();
  let repaint: ReturnType<typeof setTimeout> | undefined;
  const record = pty.write.bind(pty);
  vi.spyOn(pty, 'write').mockImplementation(data => {
    record(data);
    if (data === '\r') {
      pty.paint(composer(''));
      repaint = setTimeout(() => pty.paint(composer(body)), 450);
    } else pty.paint(composer(body));
  });
  try {
    expect(await session.writeNudgeWithReason(body + '\r', () => true, ['m1'])).toBe('aborted-not-submitted');
    expect(session.nudgePendingLine()).toBe(body);
    expect(pty.writes).toEqual([body, '\r']);
  } finally { clearTimeout(repaint); await session['renderer'].dispose(); }
});

it('retains the draft when ordinary output in a running turn quotes it', async () => {
  const { session, pty } = recipient('codex');
  const record = pty.write.bind(pty);
  vi.spyOn(pty, 'write').mockImplementation(data => {
    record(data);
    const above = data === '\r' ? 'Output mentions ' + body + '\r\nWorking (1s · esc to interrupt)\r\n' : '';
    pty.paint(clear + above + '› ' + body + (data === '\r' ? '\r\nstatus updating' : ''));
  });
  try {
    expect(await session.writeNudgeWithReason(body + '\r', () => true, ['m1'])).toBe('aborted-not-submitted');
    expect(session.nudgePendingLine()).toBe(body);
    expect(pty.writes).toEqual([body, '\r']);
  } finally { await session['renderer'].dispose(); }
});
