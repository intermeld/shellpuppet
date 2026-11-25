import { expect, it } from 'vitest';
import { Mailbox } from '../../src/core/mailbox.js';

const minute = 60_000;

it('counts a verified launch proof as activity and expires exactly one idle period later', () => {
  let now = 0;
  const box = new Mailbox({ enabled: true, now: () => now });
  const { claimId, secret } = box.claim('desk');
  now = 15 * minute;
  expect(box.verifyClaim(claimId, secret)).toBe(true);
  now = 45 * minute - 1;
  expect(box.verifyClaim(claimId, 'incorrect')).toBe(false);
  expect(box.lapseClaims()).toEqual([]);
  now++;
  expect(box.lapseClaims()).toEqual([claimId]);
});

it('moves waiting and nudged messages in order, retires the old reader and restores only the new proof', async () => {
  const box = new Mailbox({ enabled: true, policy: () => true });
  box.register({ kind: 'session', name: 'peer', id: 's1' });
  const old = box.claim('desk');
  box.send('s1', 'desk', 'already read');
  box.inbox(old.claimId);
  const nudged = box.send('s1', 'desk', 'earlier');
  box.markNudged([nudged.id]);
  const waiting = box.send('s1', 'desk', 'later');
  box.send(old.claimId, 'peer', 'outgoing');
  const outbox = box.outbox(old.claimId);
  const blocked = box.waitForMessage(old.claimId, { from: 'another' });

  const fresh = box.claim('desk', { replace: true });
  expect(await blocked).toBeUndefined();
  expect(() => box.claim('peer', { replace: true })).toThrow(expect.objectContaining({
    code: 'duplicate-name', message: 'The name "peer" is already held by a live participant.',
    hint: 'That participant name is unavailable.',
  }));
  expect(box.verifyClaim(old.claimId, old.secret)).toBe(false);
  expect(box.verifyClaim(fresh.claimId, old.secret)).toBe(false);
  expect(box.verifyClaim(fresh.claimId, fresh.secret)).toBe(true);
  expect(box.outbox(fresh.claimId)).toEqual([]);
  expect(box.inbox('s1', { markRead: false })[0]?.from).toEqual(outbox[0]?.from);
  const carried = box.inbox(fresh.claimId, { markRead: false });
  expect(carried.map(m => [m.id, m.state, m.to.id])).toEqual([
    [nudged.id, 'nudged', fresh.claimId], [waiting.id, 'waiting', fresh.claimId],
  ]);
  expect(box.outbox('s1')).toEqual(carried);
  const rows = box.savedClaims(['desk']);
  const restored = new Mailbox({ enabled: true });
  expect(restored.restoreClaims(rows, ['desk'])).toBe(1);
  expect(restored.verifyClaim(fresh.claimId, fresh.secret)).toBe(true);
  expect(restored.verifyClaim(old.claimId, old.secret)).toBe(false);
  expect(restored.inbox(fresh.claimId)).toEqual([]);
});

it('gives the same recovery hint before and during a pending wait', async () => {
  let now = 0;
  const box = new Mailbox({ enabled: true, now: () => now });
  const reader = box.claim('desk');
  const expectConflict = () => expect(() => box.claim('desk')).toThrow(expect.objectContaining({
    hint: 'Recover it with msg claim desk --replace or replace: true on session_claim.',
  }));
  expectConflict();
  const controller = new AbortController();
  const pending = box.waitForMessage(reader.claimId, { signal: controller.signal });
  now += 45 * minute;
  expect(box.lapseClaims()).toEqual([]);
  try {
    expectConflict();
  } finally {
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  }
});

it('keeps the previous claim and its delivery intact if the new digest cannot be saved', () => {
  const box = new Mailbox({ enabled: true, policy: () => true });
  const old = box.claim('desk');
  const message = box.send(old.claimId, 'desk', 'pending');
  expect(() => box.claim('desk', { replace: true, beforeCommit: () => { throw new Error('write failed'); } }))
    .toThrow('write failed');
  expect(box.verifyClaim(old.claimId, old.secret)).toBe(true);
  expect(box.inbox(old.claimId)).toMatchObject([{ id: message.id }]);
  expect(box.savedClaims(['desk']).map(c => c.id)).toEqual([old.claimId]);
});
