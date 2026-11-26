import { expect, it, vi } from 'vitest';
import { Mailbox } from '../../src/core/mailbox.js';
import { buildMessagingPolicy } from '../../src/daemon/config.js';
import { Daemon } from '../../src/daemon/server.js';
import { NudgeScheduler } from '../../src/daemon/nudgeScheduler.js';

it('uses current nudge limits at the write while retaining earlier timestamps', async () => {
  let now = 0;
  const limits = { intervalMs: 10, perMinute: 2 };
  let eligible: (() => boolean) | undefined;
  const deliver = vi.fn((_id: string, check: () => boolean) => {
    eligible = check;
    return Promise.resolve('sent' as const);
  });
  const scheduler = new NudgeScheduler({ now: () => now, get intervalMs() { return limits.intervalMs; },
    get perMinute() { return limits.perMinute; }, deliver });
  scheduler.queue('first');
  await scheduler.tick();
  now = 10;
  scheduler.queue('first');
  limits.intervalMs = 12;
  await scheduler.tick();
  expect(deliver).toHaveBeenCalledTimes(1);
  now = 12;
  await scheduler.tick();
  expect(deliver).toHaveBeenCalledTimes(2);
  limits.perMinute = 1;
  scheduler.queue('second');
  await scheduler.tick();
  expect(deliver).toHaveBeenCalledTimes(2);
  limits.perMinute = 3;
  await scheduler.tick();
  expect(deliver).toHaveBeenCalledTimes(3);
  expect(eligible).toBeTypeOf('function');
  expect(eligible!()).toBe(false);
});

it('updates claim expiry from actual activity and releases a disabled waiter', async () => {
  let now = 0;
  let ttl = 5;
  let enabled = true;
  const box = new Mailbox({ get enabled() { return enabled; }, now: () => now, policy: () => true,
    get claimIdleMinutes() { return ttl; } });
  const claim = box.claim('desk');
  now = 60_001;
  ttl = 1;
  expect(box.expiredClaims()).toEqual([claim.claimId]);
  ttl = 2;
  expect(box.expiredClaims()).toEqual([]);
  expect(box.verifyClaim(claim.claimId, claim.secret, false)).toBe(true);
  const waiting = box.waitForMessage(claim.claimId, { timeoutMs: 10_000 });
  now = 120_001;
  expect(box.expiredClaims()).toEqual([]);
  enabled = false;
  box.permissionsChanged();
  await expect(waiting).rejects.toMatchObject({ code: 'messaging-disabled' });
  expect(box.expiredClaims()).toEqual([claim.claimId]);
});

it('uses the original role and parent edge after sender exit and name reuse', () => {
  let parents = true;
  const box = new Mailbox({ enabled: true, policy: (from, to, parentChild) =>
    buildMessagingPolicy({ enabled: true, allow: parents ? ['parent-child'] : [] },
      { parentOf: () => undefined })(from, to, parentChild) });
  box.register({ kind: 'session', id: 's1', name: 'holder' });
  box.register({ kind: 'session', id: 's2', name: 'child', parent: 's1' });
  box.send('s2', 'holder', 'kept');
  const held = box.deliveryPermission('s1', ['m1']);
  expect(held()).toBe(true);
  box.end('s2');
  box.claim('child');
  parents = false;
  box.permissionsChanged();
  expect(box.inbox('s1')).toEqual([]);
  parents = true;
  expect(box.inbox('s1')).toMatchObject([{ text: 'kept' }]);
  expect(held()).toBe(false);
  expect(box.deliveryPermission('s1', ['m1'])()).toBe(true);
});

it.each(['before', 'submit'] as const)('checks revocation at the %s write, including a rapid regrant', async phase => {
  let enabled = true;
  const box = new Mailbox({ get enabled() { return enabled; }, policy: () => true });
  box.register({ kind: 'session', id: 'reader', name: 'reader' });
  box.send(box.claim('desk').claimId, 'reader', 'retained');
  const writes: string[] = [];
  let inputVersion = 0;
  const revoke = () => { enabled = false; box.permissionsChanged(); enabled = true; box.permissionsChanged(); };
  const session = {
    hasPainted: () => true, nudgePendingLine: () => null, nudgeReady: () => true,
    nudgeReadyWithLine: () => true, snapshot: () => Promise.resolve({ screen: 'idle', exited: false }),
    nudgeState: () => ({ ready: true, queued: false }), answerablePrompt: () => null,
    lastChangeAt: () => 10, nudgeScreenRevision: () => 1, nudgeInputVersion: () => inputVersion,
    nudgeQueuedInputVersion: () => 0, nudgeSubmit: () => '\r', getStalled: () => undefined,
    writeNudgeWithReason: (_data: string, ready: (screen: string, phase: 'before' | 'submit') => boolean) => {
      if (phase === 'before') revoke();
      if (!ready('idle', 'before')) return Promise.resolve('wait');
      writes.push('body');
      inputVersion++;
      revoke();
      if (ready('idle', 'submit')) writes.push('Enter');
      return Promise.resolve('wait');
    },
  };
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, { mailbox: box, now: () => 10, manager: { get: () => session }, audit: { record: vi.fn() } });
  expect(await daemon['deliverNudge']('reader')).toBe('wait');
  expect(writes).toEqual(phase === 'before' ? [] : ['body']);
  expect(box.inbox('reader', { markRead: false })).toMatchObject([{ state: 'waiting' }]);
});

it('preserves an occupied name while reserving it for outside claims on subsequent acquisition', () => {
  let members: string[] = [];
  const box = new Mailbox({ enabled: true, get reservedNames() { return new Set(members); },
    policy: (from, to) => buildMessagingPolicy({ enabled: true, allow: [{ group: 'work', members, roles: ['chair'] }] },
      { parentOf: () => undefined })(from, to) });
  box.register({ kind: 'session', id: 's1', name: 'desk' });
  box.register({ kind: 'session', id: 's2', name: 'review', role: 'chair' });
  const peer = box.claim('peer');
  members = ['desk', 'peer'];
  box.permissionsChanged();
  expect(box.directory(peer.claimId).map(p => p.id)).toContain('s2');
  expect(box.directory(peer.claimId).map(p => p.id)).not.toContain('s1');
  expect(() => box.claim('desk', { replace: true })).toThrow();
  box.end('s1');
  expect(() => box.rename('s2', 'desk')).toThrow();
  const next = box.claim('desk');
  expect(box.directory(peer.claimId).map(p => p.id)).toContain(next.claimId);
});
