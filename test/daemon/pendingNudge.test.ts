import { expect, it } from 'vitest';
import { buildNudge, Mailbox } from '../../src/core/mailbox.js';
import { Daemon } from '../../src/daemon/server.js';

it('submits the original visible body after another message arrives', async () => {
  const mailbox = new Mailbox({ enabled: true, policy: () => true });
  mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
  const sender = mailbox.claim('sender');
  const first = mailbox.send(sender.claimId, 'recipient', 'first');
  const pendingLine = buildNudge(mailbox.inbox('recipient', { markRead: false }));
  const second = mailbox.send(sender.claimId, 'recipient', 'second');
  let submits = 0;
  let visible = false;
  const audit: { action: string; meta: Record<string, unknown> }[] = [];
  const session = {
    exited: false,
    nudgePendingLine: () => pendingLine,
    nudgePendingIds: () => [first.id],
    nudgePendingUntouched: () => true,
    nudgePendingSafeToSubmit: () => true,
    nudgePendingAuditOnce: () => true,
    nudgePendingTouchRefusal: () => false,
    clearConsumedNudge: () => Promise.resolve(false),
    nudgeReadyWithLine: (line: string) => visible && line === pendingLine,
    nudgeInputVersion: () => 1,
    nudgeQueuedInputVersion: () => 0,
    nudgeScreenRevision: () => 0,
    getStalled: () => undefined,
    answerablePrompt: () => null,
    submitPendingNudge: () => { submits++; return Promise.resolve(true); },
    writeNudgeWithReason: () => { throw new Error('A second body must not be written'); },
  };
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, {
    manager: { get: () => session }, mailbox,
    audit: { record: (_actor: string, action: string, _id: string, meta: Record<string, unknown>) =>
      audit.push({ action, meta }) },
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  }
  expect(submits).toBe(0);
  visible = true;
  expect(await daemon['deliverNudge']('recipient')).toBe('sent');
  expect(submits).toBe(1);
  expect(audit).toContainEqual({ action: 'nudge', meta: {
    messageIds: [first.id], count: 1, waitingMessageIds: [second.id], staleMessageIds: [],
  } });
});

it('withholds Enter when another waiting message arrives at the pending-line submit check', async () => {
  const mailbox = new Mailbox({ enabled: true, policy: () => true });
  mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
  const sender = mailbox.claim('sender');
  const first = mailbox.send(sender.claimId, 'recipient', 'first');
  const pendingLine = buildNudge(mailbox.inbox('recipient', { markRead: false }));
  const second = mailbox.send(sender.claimId, 'recipient', 'second');
  let submits = 0;
  let inject = true;
  const session = {
    exited: false,
    nudgePendingLine: () => pendingLine,
    nudgePendingIds: () => [first.id],
    nudgePendingSafeToSubmit: () => true,
    nudgePendingTouchRefusal: () => false,
    nudgePendingAuditOnce: () => false,
    clearConsumedNudge: () => Promise.resolve(false),
    nudgeReadyWithLine: (line: string) => line === pendingLine,
    nudgeInputVersion: () => 1,
    nudgeQueuedInputVersion: () => 0,
    nudgeScreenRevision: () => 0,
    getStalled: () => undefined,
    answerablePrompt: () => null,
    submitPendingNudge: (_line: string, ready: (screen: string) => boolean) => {
      if (inject) {
        mailbox.send(sender.claimId, 'recipient', 'third');
        inject = false;
      }
      if (!ready('screen')) return Promise.resolve(false);
      submits++;
      return Promise.resolve(true);
    },
    writeNudgeWithReason: () => { throw new Error('A second body must not be written'); },
  };
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, {
    manager: { get: () => session }, mailbox,
    audit: { record: () => undefined },
  });
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  expect(submits).toBe(0);
  expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === second.id)?.state).toBe('waiting');
  expect(await daemon['deliverNudge']('recipient')).toBe('sent');
  expect(submits).toBe(1);
  expect(mailbox.outbox(sender.claimId).filter((entry) => entry.state === 'nudged')).toHaveLength(3);
});

it('discards a stale pending body and nudges a later message after the composer clears', async () => {
  const mailbox = new Mailbox({ enabled: true, policy: () => true });
  mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
  const sender = mailbox.claim('sender');
  const first = mailbox.send(sender.claimId, 'recipient', 'first');
  const coveredSecond = mailbox.send(sender.claimId, 'recipient', 'covered second');
  const pendingLine = buildNudge(mailbox.inbox('recipient', { markRead: false }));
  mailbox.inbox('recipient', { limit: 1 });
  let submits = 0;
  let pending: string | null = pendingLine;
  let composerEmpty = false;
  const delivered: string[] = [];
  const audit: { action: string; meta: Record<string, unknown> }[] = [];
  const session = {
    exited: false,
    nudgePendingLine: () => pending,
    nudgePendingIds: () => pending === null ? [] : [first.id, coveredSecond.id],
    discardStalePendingNudge: () => { pending = null; return true; },
    nudgePendingUntouched: () => true,
    nudgePendingSafeToSubmit: () => true,
    nudgePendingAuditOnce: () => true,
    nudgePendingTouchRefusal: () => false,
    clearConsumedNudge: () => Promise.resolve(false),
    nudgeReadyWithLine: (line: string) => line === pendingLine,
    hasPainted: () => true,
    nudgeReady: () => composerEmpty,
    nudgeInputVersion: () => 1,
    nudgeQueuedInputVersion: () => 0,
    nudgeScreenRevision: () => 0,
    getStalled: () => undefined,
    answerablePrompt: () => null,
    submitPendingNudge: () => { submits++; return Promise.resolve(true); },
    writeNudgeWithReason: () => { throw new Error('Delivery is mocked below'); },
  };
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, {
    manager: { get: () => session }, mailbox, options: {},
    audit: { record: (_actor: string, action: string, _id: string, meta: Record<string, unknown>) =>
      audit.push({ action, meta }) },
    deliverLine: (_session: unknown, line: string) => {
      delivered.push(line);
      return Promise.resolve({ outcome: 'sent' });
    },
  });
  // The old body stays on screen, but it no longer owns daemon pending state.
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  expect(pending).toBe(pendingLine);
  mailbox.inbox('recipient');
  expect(await daemon['deliverNudge']('recipient')).toBe('done');
  expect(pending).toBeNull();
  expect(submits).toBe(0);
  const waiting = mailbox.send(sender.claimId, 'recipient', 'second');
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  expect(delivered).toEqual([]);
  composerEmpty = true;
  expect(await daemon['deliverNudge']('recipient')).toBe('sent');
  expect(submits).toBe(0);
  expect(delivered).toEqual([buildNudge([{ id: waiting.id,
    from: { id: sender.claimId, name: 'sender' } }])]);
  expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === waiting.id)?.state).toBe('nudged');
  expect(audit.filter((entry) => entry.action === 'nudge-pending-stale')).toEqual([{
    action: 'nudge-pending-stale', meta: { messageIds: [first.id, coveredSecond.id], count: 2 },
  }]);
});
