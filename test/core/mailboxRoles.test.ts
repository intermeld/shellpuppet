import { describe, expect, it } from 'vitest';
import { Mailbox, MailboxError } from '../../src/core/mailbox.js';
import { buildMessagingPolicy, parseDaemonConfig } from '../../src/daemon/config.js';
import { parseLaunchProfile } from '../../src/daemon/launchProfiles.js';

describe('session roles and outside claim names', () => {
  it('accepts only a chair role in a launch profile', () => {
    const base = { name: 'lead', command: 'node' };
    expect(parseLaunchProfile({ ...base, role: 'chair' }, new Set())).toMatchObject({ profile: { role: 'chair' } });
    const invalid = parseLaunchProfile({ ...base, role: 'delegate' }, new Set());
    expect(invalid).toHaveProperty('problem');
    expect(invalid).toMatchObject({ profile: { name: 'lead' } });
    expect('profile' in invalid && invalid.profile.role).toBeUndefined();
    const loaded = parseDaemonConfig({ launcher: { profiles: [{ ...base, role: 'delegate' }] } });
    expect(loaded.problems.join(' ')).toContain('ignoring role');
    expect(loaded.config.launcher?.profiles[0]?.role).toBeUndefined();
  });

  it('parses group roles and reports a member that equals a profile name', () => {
    const result = parseDaemonConfig({
      launcher: { profiles: [{ name: 'lead', command: 'node', role: 'chair' }] },
      messaging: { enabled: true, allow: [{ group: 'chairs', members: ['lead'], roles: ['chair'] }], claimIdleMinutes: 2 },
    });
    expect(result.config.messaging?.claimIdleMinutes).toBe(2);
    expect(result.config.messaging?.allow).toEqual([{ group: 'chairs', members: ['lead'], roles: ['chair'] }]);
    expect(result.problems.join(' ')).toContain('members are for outside claims');
    for (const bad of [0, -1, '2', null]) {
      const parsed = parseDaemonConfig({ messaging: { enabled: true, allow: [], claimIdleMinutes: bad } });
      expect(parsed.config.messaging).toBeUndefined();
      expect(parsed.problems.join(' ')).toContain('claimIdleMinutes');
    }
  });

  it('uses role for sessions and name for claims', () => {
    const policy = buildMessagingPolicy({ enabled: true, allow: [{ group: 'chairs', members: ['outside'], roles: ['chair'] }] }, { parentOf: () => undefined });
    expect(policy({ kind: 'session', id: 's9', name: 'outside', role: 'delegate' },
      { kind: 'claim', id: 'c1', name: 'outside' })).toBe(false);
    const box = new Mailbox({ enabled: true, policy, reservedNames: new Set(['outside']) });
    box.register({ kind: 'session', id: 's1', name: 'lead', role: 'chair' });
    box.register({ kind: 'session', id: 's2', name: 'helper', role: 'chair' });
    box.register({ kind: 'session', id: 's3', name: 'outside-2', role: 'delegate' });
    const claim = box.claim('outside');
    expect(box.send('s1', 'helper', 'allowed').state).toBe('waiting');
    expect(box.send('s1', 'outside', 'allowed').state).toBe('waiting');
    expect(() => box.send('s3', 'outside', 'refused')).toThrow(/outside-2.*outside.*messaging.allow/);
    expect(() => box.register({ kind: 'session', id: 's4', name: 'outside' })).toThrow(MailboxError);
    expect(box.verifyClaim(claim.claimId, claim.secret)).toBe(true);
  });

  it('renames without moving old messages and frees the old name', () => {
    const box = new Mailbox({ enabled: true, policy: () => true, reservedNames: new Set(['outside']) });
    box.register({ kind: 'session', id: 's1', name: 'lead' });
    box.register({ kind: 'session', id: 's2', name: 'helper' });
    box.send('s1', 'helper', 'before');
    expect(() => box.rename('s1', 'outside')).toThrow(/reserved/);
    expect(() => box.rename('s1', 'helper')).toThrow(/already held/);
    box.rename('s2', 'new-helper');
    expect(box.inbox('s2')[0]?.to.name).toBe('helper');
    expect(box.participant('s2')?.name).toBe('new-helper');
    box.register({ kind: 'session', id: 's3', name: 'helper' });
    box.end('s2');
    expect(() => box.rename('s2', 'late')).toThrow(/ended/);
  });

  it('lapses idle claims, retains a pending wait, and marks unread messages not delivered', async () => {
    let now = 0;
    const box = new Mailbox({ enabled: true, policy: () => true, now: () => now, claimIdleMinutes: 0.001 });
    box.register({ kind: 'session', id: 's1', name: 'lead' });
    const first = box.claim('outside');
    box.send('s1', 'outside', 'unread');
    now = 61;
    expect(box.lapseClaims()).toEqual([first.claimId]);
    expect(box.outbox('s1')[0]?.state).toBe('not-delivered');
    const second = box.claim('outside');
    expect(second.claimId).not.toBe(first.claimId);
    const controller = new AbortController();
    const pending = box.waitForMessage(second.claimId, { signal: controller.signal });
    now = 200;
    expect(box.lapseClaims()).toEqual([]);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    box.touchClaim(second.claimId);
    expect(box.lapseClaims()).toEqual([]);
    now = 261;
    expect(box.lapseClaims()).toEqual([second.claimId]);
  });
});
