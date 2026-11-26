import { expect, it } from 'vitest';
import { SessionInputFailedError } from '../../src/core/session.js';
import type { Session } from '../../src/core/session.js';
import { Daemon } from '../../src/daemon/server.js';

function failingDelivery(error: Error): { daemon: Daemon; session: Session;
  audit: { action: string; meta: Record<string, unknown> }[] } {
  const audit: { action: string; meta: Record<string, unknown> }[] = [];
  const session = {
    id: 's1',
    exited: false,
    hasPainted: () => true,
    nudgeInputVersion: () => 0,
    nudgeQueuedInputVersion: () => 0,
    nudgeScreenRevision: () => 0,
    snapshot: () => Promise.resolve({ screen: '', exited: false }),
    nudgeState: () => ({ ready: true, queued: false, paneQuiet: false, regionKey: 'idle' }),
    answerablePrompt: () => null,
    lastChangeAt: () => 0,
    getStalled: () => undefined,
    nudgeSubmit: () => '\r',
    writeNudgeWithReason: () => Promise.reject(error),
    nudgePendingBodyMeta: () => ({ pendingBody: true, typedChars: 1_024, submitSent: false }),
  } as unknown as Session;
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, { options: {}, audit: { record: (_actor: string, action: string, _id: string,
    meta: Record<string, unknown>) => { audit.push({ action, meta }); } } });
  return { daemon, session, audit };
}

it('audits the accepted prefix before returning an input-pipe failure', async () => {
  const { daemon, session, audit } = failingDelivery(new SessionInputFailedError('s1', new Error('pipe closed')));
  const result = await daemon['deliverLine'](session, 'x'.repeat(1_025), undefined, ['m1'], () => true);
  expect(result).toMatchObject({ outcome: 'skipped', reason: 'input-failed' });
  expect(audit).toEqual([{ action: 'nudge-aborted', meta: {
    messageIds: ['m1'], count: 1, reason: 'input-failed',
    pendingBody: true, typedChars: 1_024, submitSent: false,
  } }]);
});

it('audits the accepted prefix before propagating another write failure', async () => {
  const { daemon, session, audit } = failingDelivery(new Error('write failed'));
  await expect(daemon['deliverLine'](session, 'x'.repeat(1_025), undefined, ['m1'], () => true))
    .rejects.toThrow('write failed');
  expect(audit).toEqual([{ action: 'nudge-aborted', meta: {
    messageIds: ['m1'], count: 1, reason: 'write-failed',
    pendingBody: true, typedChars: 1_024, submitSent: false,
  } }]);
});
