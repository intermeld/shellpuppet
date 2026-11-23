import { expect, it } from 'vitest';
import { buildNudge, Mailbox } from '../../src/core/mailbox.js';
import { Daemon } from '../../src/daemon/server.js';

it.each([false, true])('submits the original body after another arrival (queue key: %s)', async queued => {
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
    nudgePendingTouchRefusal: () => false,
    clearConsumedNudge: () => Promise.resolve(false),
    nudgeReadyWithLine: (line: string, queueKey = false) => visible && line === pendingLine && queueKey === queued,
    nudgeInputVersion: () => 1,
    nudgeQueuedInputVersion: () => 0,
    nudgeScreenRevision: () => 0,
    getStalled: () => undefined,
    answerablePrompt: () => null,
    submitPendingNudge: () => { submits++; return Promise.resolve('sent'); },
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
    ...(queued ? { queued: true } : {}),
  } });
});

it('submits an untouched pending body when its named message was read and another waits', async () => {
  const mailbox = new Mailbox({ enabled: true, policy: () => true });
  mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
  const sender = mailbox.claim('sender');
  const first = mailbox.send(sender.claimId, 'recipient', 'first');
  const pendingLine = buildNudge(mailbox.inbox('recipient', { markRead: false }));
  mailbox.inbox('recipient');
  let visible = true;
  let touched = false;
  let submits = 0;
  let beforeSubmitCheck: (() => void) | undefined;
  const audit: { action: string; meta: Record<string, unknown> }[] = [];
  const session = {
    exited: false,
    nudgePendingLine: () => pendingLine,
    nudgePendingIds: () => [first.id],
    nudgePendingUntouched: () => !touched,
    nudgePendingTouchRefusal: () => false,
    clearConsumedNudge: () => Promise.resolve(false),
    nudgeReadyWithLine: (line: string) => visible && line === pendingLine,
    nudgeInputVersion: () => 1,
    nudgeQueuedInputVersion: () => 0,
    nudgeScreenRevision: () => 0,
    getStalled: () => undefined,
    answerablePrompt: () => null,
    submitPendingNudge: (_line: string, ready: (screen: string) => boolean) => {
      beforeSubmitCheck?.();
      beforeSubmitCheck = undefined;
      if (!ready('screen')) return Promise.resolve('wait');
      submits++;
      return Promise.resolve('sent');
    },
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
  touched = true;
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  touched = false;
  visible = false;
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  visible = true;
  let later: ReturnType<typeof mailbox.send>;
  beforeSubmitCheck = () => { later = mailbox.send(sender.claimId, 'recipient', 'third'); };
  expect(await daemon['deliverNudge']('recipient')).toBe('wait');
  expect(submits).toBe(0);
  expect(await daemon['deliverNudge']('recipient')).toBe('sent');
  expect(submits).toBe(1);
  expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === waiting.id)?.state).toBe('nudged');
  expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === later!.id)?.state).toBe('nudged');
  expect(audit).toContainEqual({ action: 'nudge', meta: {
    messageIds: [first.id], count: 1, waitingMessageIds: [waiting.id, later!.id],
    staleMessageIds: [first.id],
  } });
});
