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

it('keeps a pending body when a named message was read, even if another waits', async () => {
  const mailbox = new Mailbox({ enabled: true, policy: () => true });
  mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
  const sender = mailbox.claim('sender');
  const first = mailbox.send(sender.claimId, 'recipient', 'first');
  const pendingLine = buildNudge(mailbox.inbox('recipient', { markRead: false }));
  mailbox.inbox('recipient');
  let submits = 0;
  let pendingRecorded = false;
  const audit: { action: string; meta: Record<string, unknown> }[] = [];
  const session = {
    exited: false,
    nudgePendingLine: () => pendingLine,
    nudgePendingIds: () => [first.id],
    nudgePendingUntouched: () => true,
    nudgePendingSafeToSubmit: () => true,
    nudgePendingAuditOnce: () => {
      if (pendingRecorded) return false;
      pendingRecorded = true;
      return true;
    },
    nudgePendingTouchRefusal: () => false,
    clearConsumedNudge: () => Promise.resolve(false),
    nudgeReadyWithLine: (line: string) => line === pendingLine,
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
  // Each refusal leaves the original body in place and cannot write a second copy.
  expect(await daemon['deliverNudge']('recipient')).toBe('done');
  expect(submits).toBe(0);
  const waiting = mailbox.send(sender.claimId, 'recipient', 'second');
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  expect(submits).toBe(0);
  expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === waiting.id)?.state).toBe('waiting');
  expect(audit.filter((entry) => entry.action === 'nudge-pending')).toEqual([{ action: 'nudge-pending',
    meta: { messageIds: [first.id], count: 1, reason: 'messages-changed' } }]);
});
