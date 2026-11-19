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
    messageIds: [first.id], count: 1, waitingMessageIds: [second.id],
  } });
});
