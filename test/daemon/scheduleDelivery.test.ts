import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { claude } from '../../src/agents/claude/index.js';
import { codex } from '../../src/agents/codex/index.js';
import { muse } from '../../src/agents/muse/index.js';
import { Mailbox } from '../../src/core/mailbox.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { Session } from '../../src/core/session.js';
import { Daemon } from '../../src/daemon/server.js';
import { InputPty } from '../fixtures/inputPty.js';

it.each([
  ['claude-answered', 'skip', 'sent'],
  ['claude-thinking', 'queue', 'queued'],
  ['claude-thinking', 'skip', 'skipped'],
] as const)('delivers a word-wrapped schedule on %s with %s', async (capture, whenBusy, outcome) => {
  const message = 'Please review the completed release checklist before starting the next job.';
  const schedule = { name: 'check', session: 'worker', whenBusy, enabled: true, message, cron: '* * * * *' };
  const pty = new InputPty(48);
  const session = new Session('s1', { command: process.execPath, agent: claude.name, cols: pty.cols, rows: pty.rows }, {
    platform: 'linux', spawn: () => pty,
  });
  const screen = fs.readFileSync(path.join(__dirname, '../fixtures/reasoning', capture + '.ansi'), 'utf8')
    .replace(/─{120}/gu, '─'.repeat(pty.cols));
  const mailbox = new Mailbox({ enabled: false, policy: () => false });
  mailbox.register({ id: session.id, name: 'worker', kind: 'session' });
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, { mailbox, pendingSchedules: new Map(), manager: { get: () => session },
    now: () => Date.now() + 5_000 });
  const record = pty.write.bind(pty);
  vi.spyOn(pty, 'write').mockImplementation(data => {
    record(data);
    if (data === message) pty.paint('\x1b[H\x1b[2J' + screen.replace('❯\u00a0',
      '❯\u00a0Please review the completed release checklist\r\n  before starting the next job.'));
  });
  try {
    pty.paint(screen);
    await session['renderer'].flush();
    session.nudgeState(Date.now(), whenBusy);
    const result = await daemon['deliverScheduled'](schedule, () => true);
    expect(result).toMatchObject({ outcome, ...(outcome === 'skipped' ? { reason: 'busy' } : {}) });
    expect(pty.writes).toEqual(outcome === 'skipped' ? [] : [message, '\r']);
    expect(session.nudgePendingLine()).toBeNull();
  } finally { await session['renderer'].dispose(); }
});

it.each([
  ['claude-answered', 'skip', 'sent', undefined],
  ['claude-thinking', 'queue', 'queued', undefined],
  ['claude-thinking', 'skip', 'skipped', 'busy'],
  ['codex-working', 'queue', 'skipped', 'cannot-queue'],
  ['claude-prompt-typed', 'queue', 'skipped', 'draft'],
  ['busy-draft', 'queue', 'skipped', 'draft'],
  ['unpainted-input', 'skip', 'skipped', 'recent-input'],
  ['input-before-write', 'queue', 'skipped', 'recent-input'],
  ['muse-approval', 'queue', 'skipped', 'prompt'],
  ['stalled', 'skip', 'skipped', 'stalled'],
  ['unknown', 'skip', 'skipped', 'unknown'],
  ['pending', 'queue', 'skipped', 'pending'],
  ['absent', 'queue', 'skipped', 'no-session'],
] as const)('%s with %s gives %s %s', async (fixture, whenBusy, outcome, reason) => {
  const schedule = { name: 'check', session: 'worker', whenBusy, enabled: true, message: 'Run my check.', cron: '* * * * *' };
  const capture = fixture === 'busy-draft' || fixture === 'input-before-write' ? 'claude-thinking' :
    ['pending', 'absent', 'stalled', 'unknown', 'unpainted-input'].includes(fixture) ? 'claude-answered' : fixture;
  const base = path.join(__dirname, '..', 'fixtures', 'reasoning', capture);
  const size = JSON.parse(fs.readFileSync(base + '.json', 'utf8')) as { cols: number; rows: number };
  const renderer = new ScreenRenderer(size);
  try {
    await renderer.write(fs.readFileSync(base + '.ansi', 'utf8'));
    if (fixture === 'busy-draft') {
      const row = renderer.styledLines().lines.map(line => line.text.startsWith('❯')).lastIndexOf(true);
      await renderer.write(`\x1b[${String(row + 1)};3HMy unfinished reply`);
    }
    const session = Object.create(Session.prototype) as Session;
    const write = vi.fn((_data: string, ready: (screen: string, phase: 'before') => boolean) => {
      if (fixture === 'input-before-write') Object.assign(session, { recentInputUntil: Date.now() + 10_000 });
      return Promise.resolve(ready(renderer.snapshot().screen, 'before') ? 'sent' : 'wait');
    });
    Object.assign(session, { renderer, id: 's1', recentInputUntil: fixture === 'unpainted-input' ? Date.now() + 10_000 : 0,
      agentModule: fixture === 'unknown' ? undefined : fixture.startsWith('muse') ? muse : fixture.startsWith('codex') ? codex : claude,
      agent: fixture.startsWith('muse') ? 'muse' : fixture.startsWith('codex') ? 'codex' : 'claude',
      snapshot: () => Promise.resolve(renderer.snapshot()), hasPainted: () => true,
      lastChangeAt: () => 500, getStalled: () => fixture === 'stalled' ? { reason: 'refused' } : undefined,
      nudgeInputVersion: () => 0, nudgeQueuedInputVersion: () => 0, nudgeScreenRevision: () => 0,
      nudgePendingLine: () => fixture === 'pending' ? 'older body' : null, clearConsumedNudge: () => Promise.resolve(false),
      answerablePrompt: () => null, writeNudgeWithReason: write });
    session.nudgeState(1000);
    const mailbox = new Mailbox({ enabled: false, policy: () => false });
    if (fixture !== 'absent') mailbox.register({ id: 's1', name: 'worker', kind: 'session' });
    const daemon = Object.create(Daemon.prototype) as Daemon;
    Object.assign(daemon, { mailbox, pendingSchedules: new Map(), manager: { get: () => session }, now: () => 10_000 });
    expect(await daemon['deliverScheduled'](schedule, () => true)).toMatchObject({
      outcome, ...(reason ? { reason } : {}) });
    expect(write).toHaveBeenCalledTimes(!reason || fixture === 'input-before-write' ? 1 : 0);
    if (!reason) expect(write.mock.calls[0]?.[0]).toBe(schedule.message + '\r');
  } finally { await renderer.dispose(); }
});

it('keeps an aborted body pending across a target change and an unrelated mailbox nudge', async () => {
  const mailbox = new Mailbox({ enabled: true, policy: () => true });
  mailbox.register({ id: 's1', name: 'before', kind: 'session' });
  mailbox.register({ id: 's2', name: 'after', kind: 'session' });
  const sender = mailbox.claim('sender');
  mailbox.send(sender.claimId, 'before', 'Read the inbox.');
  const submit = vi.fn(() => Promise.resolve(true));
  const previous = { id: 's1', pendingSchedule: () => 'check', nudgePendingLine: () => 'Previous check.',
    nudgePendingIds: () => [], clearConsumedNudge: () => Promise.resolve(false), nudgePendingUntouched: () => true,
    nudgeReadyWithLine: () => true, nudgeInputVersion: () => 1, nudgeQueuedInputVersion: () => 0,
    nudgeScreenRevision: () => 0, submitPendingNudge: submit };
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, { mailbox, manager: { get: (id: string) => id === 's1' ? previous : { id: 's2' } },
    pendingSchedules: new Map([['check', 's1']]), audit: { record: vi.fn() } });
  expect(await daemon['deliverNudge']('s1')).toBe('wait');
  expect(submit).not.toHaveBeenCalled();
  expect(mailbox.inbox('s1', { markRead: false })[0]?.state).toBe('waiting');
  expect(await daemon['deliverScheduled']({ name: 'check', session: 'after', message: 'Another check.',
    enabled: true, cron: '* * * * *', whenBusy: 'queue' }, () => true)).toMatchObject({ outcome: 'skipped', reason: 'pending' });
});

it('passes the schedule busy policy to the submit-phase check', async () => {
  const schedule = { name: 'check', session: 'worker', whenBusy: 'skip', enabled: true, message: 'Run my check.', cron: '* * * * *' } as const;
  const base = path.join(__dirname, '..', 'fixtures', 'reasoning', 'claude-answered');
  const size = JSON.parse(fs.readFileSync(base + '.json', 'utf8')) as { cols: number; rows: number };
  const renderer = new ScreenRenderer(size);
  try {
    await renderer.write(fs.readFileSync(base + '.ansi', 'utf8'));
    const session = Object.create(Session.prototype) as Session;
    const submitCheck = vi.fn(() => false);
    let inputVersion = 0;
    const write = vi.fn((_data: string, ready: (screen: string, phase: 'before' | 'submit') => boolean) => {
      if (!ready(renderer.snapshot().screen, 'before')) return Promise.resolve('wait');
      inputVersion = 1; // the body was written
      return Promise.resolve(ready(renderer.snapshot().screen, 'submit') ? 'sent' : 'aborted-line-not-seen');
    });
    Object.assign(session, { renderer, id: 's1', recentInputUntil: 0, agentModule: claude, agent: 'claude',
      snapshot: () => Promise.resolve(renderer.snapshot()), hasPainted: () => true, lastChangeAt: () => 500,
      getStalled: () => undefined, nudgeInputVersion: () => inputVersion, nudgeQueuedInputVersion: () => 0, nudgeScreenRevision: () => 0,
      nudgePendingLine: () => null, clearConsumedNudge: () => Promise.resolve(false), answerablePrompt: () => null,
      writeNudgeWithReason: write, nudgeReadyWithLine: submitCheck });
    session.nudgeState(1000);
    const mailbox = new Mailbox({ enabled: false, policy: () => false });
    mailbox.register({ id: 's1', name: 'worker', kind: 'session' });
    const daemon = Object.create(Daemon.prototype) as Daemon;
    Object.assign(daemon, { mailbox, pendingSchedules: new Map(), manager: { get: () => session }, now: () => 10_000,
      audit: { record: vi.fn() } });
    const result = await daemon['deliverScheduled'](schedule, () => true);
    expect(submitCheck).toHaveBeenCalledWith(schedule.message, false, 'skip');
    expect(result).not.toMatchObject({ outcome: 'sent' });
  } finally { await renderer.dispose(); }
});
