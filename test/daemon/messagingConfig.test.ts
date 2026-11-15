/**
 * The messaging config section: shape validation with problems reported like
 * every other section, and the policy it compiles to (design §2.5).
 */

import { describe, expect, it } from 'vitest';
import { buildMessagingPolicy, parseDaemonConfig } from '../../src/daemon/config.js';
import type { MessagingConfig } from '../../src/daemon/config.js';
import type { MessagingPolicy, ParticipantRef } from '../../src/core/mailbox.js';

function session(id: string, name: string): ParticipantRef {
  return { kind: 'session', id, name };
}

function claim(id: string, name: string): ParticipantRef {
  return { kind: 'claim', id, name };
}

/** s2 and s3 were started by s1; s4 was started by s2. */
const relations = {
  parentOf(id: string): string | undefined {
    return { s2: 's1', s3: 's1', s4: 's2' }[id];
  },
};

describe('parseDaemonConfig: the messaging section', () => {
  it('an absent section means messaging is off, and is not a problem', () => {
    const { config, problems } = parseDaemonConfig({ idleMinutes: 5 });
    expect(config.messaging).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it('parses the documented section', () => {
    const { config, problems } = parseDaemonConfig({
      messaging: {
        enabled: false,
        allow: ['parent-child', { group: 'chairs', members: ['cdr', 'coding-plan', 'shellpuppet-chair'] }],
      },
    });
    expect(problems).toEqual([]);
    expect(config.messaging).toEqual({
      enabled: false,
      allow: ['parent-child', { group: 'chairs', members: ['cdr', 'coding-plan', 'shellpuppet-chair'] }],
    });
  });

  it('enabled is false when the key is missing: off until it is switched on', () => {
    const { config, problems } = parseDaemonConfig({ messaging: { allow: ['parent-child'] } });
    expect(problems).toEqual([]);
    expect(config.messaging).toEqual({ enabled: false, allow: ['parent-child'] });
  });

  it('a section that cannot be read as written leaves messaging off', () => {
    const broken: unknown[] = [
      'on',
      { enabled: 'yes', allow: [] },
      { enabled: true, allow: 'parent-child' },
      { enabled: true, allow: [], extra: 1 },
      [],
    ];
    for (const messaging of broken) {
      const { config, problems } = parseDaemonConfig({ messaging });
      expect(config.messaging, JSON.stringify(messaging)).toBeUndefined();
      expect(problems.join(' '), JSON.stringify(messaging)).toContain('messaging');
    }
  });

  it('drops an allow entry it cannot read and keeps its siblings', () => {
    const bad: unknown[] = [
      'parents-child',
      42,
      null,
      { group: 'chairs' },
      { group: 'chairs', members: 'cdr' },
      { group: 'chairs', members: [] },
      { group: '', members: ['cdr'] },
      { group: 'chairs', members: ['cdr'], note: 'typo' },
    ];
    for (const entry of bad) {
      const { config, problems } = parseDaemonConfig({ messaging: { enabled: true, allow: ['parent-child', entry] } });
      expect(config.messaging?.allow, JSON.stringify(entry)).toEqual(['parent-child']);
      expect(problems.join(' '), JSON.stringify(entry)).toContain('messaging.allow');
    }
  });

  it('drops members that are not participant names, and the entry when none survive', () => {
    const { config, problems } = parseDaemonConfig({
      messaging: { enabled: true, allow: [{ group: 'chairs', members: ['cdr', 'not a name'] }] },
    });
    expect(config.messaging?.allow).toEqual([{ group: 'chairs', members: ['cdr'] }]);
    // The problem names the entry, never the untrusted text inside it.
    expect(problems.join(' ')).toContain('messaging.allow[0]');

    const empty = parseDaemonConfig({
      messaging: { enabled: true, allow: [{ group: 'chairs', members: ['not a name', 'also bad'] }] },
    });
    expect(empty.config.messaging?.allow).toEqual([]);
    expect(empty.problems.join(' ')).toContain('messaging.allow[0]');
  });
});

describe('buildMessagingPolicy', () => {
  it('no messaging config allows nothing', () => {
    const policy = buildMessagingPolicy(undefined, relations);
    expect(policy(session('s1', 'chair'), session('s2', 'helper'))).toBe(false);
  });

  it('a disabled config allows nothing, even with rules', () => {
    const config: MessagingConfig = { enabled: false, allow: ['parent-child'] };
    const policy = buildMessagingPolicy(config, relations);
    expect(policy(session('s1', 'chair'), session('s2', 'helper'))).toBe(false);
  });

  it('an enabled config with no rules allows nothing', () => {
    const policy = buildMessagingPolicy({ enabled: true, allow: [] }, relations);
    expect(policy(session('s1', 'chair'), session('s2', 'helper'))).toBe(false);
  });

  describe('parent-child', () => {
    const policy: MessagingPolicy = buildMessagingPolicy(
      { enabled: true, allow: ['parent-child'] },
      relations,
    );

    it('allows a parent and its own children, in both directions', () => {
      expect(policy(session('s1', 'chair'), session('s2', 'helper'))).toBe(true);
      expect(policy(session('s2', 'helper'), session('s1', 'chair'))).toBe(true);
      expect(policy(session('s1', 'chair'), session('s3', 'third'))).toBe(true);
      expect(policy(session('s2', 'helper'), session('s4', 'grandhelper'))).toBe(true);
    });

    it('refuses siblings and further generations', () => {
      expect(policy(session('s2', 'helper'), session('s3', 'third'))).toBe(false);
      expect(policy(session('s3', 'third'), session('s2', 'helper'))).toBe(false);
      expect(policy(session('s1', 'chair'), session('s4', 'grandhelper'))).toBe(false);
    });

    it('never applies to a claim', () => {
      expect(policy(claim('c1', 'desk'), session('s1', 'chair'))).toBe(false);
      expect(policy(session('s1', 'chair'), claim('c1', 'desk'))).toBe(false);
    });
  });

  describe('a group', () => {
    const policy: MessagingPolicy = buildMessagingPolicy(
      { enabled: true, allow: [{ group: 'chairs', members: ['cdr', 'coding-plan', 'shellpuppet-chair'] }] },
      relations,
    );

    it('allows every pair of members, by name', () => {
      expect(policy(session('s5', 'cdr'), session('s6', 'coding-plan'))).toBe(true);
      expect(policy(session('s6', 'coding-plan'), session('s5', 'cdr'))).toBe(true);
      expect(policy(claim('c1', 'shellpuppet-chair'), session('s5', 'cdr'))).toBe(true);
    });

    it('refuses everyone else, by name', () => {
      expect(policy(session('s5', 'cdr'), session('s7', 'ops'))).toBe(false);
      expect(policy(session('s7', 'ops'), session('s8', 'other'))).toBe(false);
    });
  });

  it('rules combine: either one is enough', () => {
    const policy = buildMessagingPolicy(
      { enabled: true, allow: ['parent-child', { group: 'chairs', members: ['cdr', 'ops'] }] },
      relations,
    );
    expect(policy(session('s1', 'chair'), session('s2', 'helper'))).toBe(true);
    expect(policy(session('s5', 'cdr'), session('s7', 'ops'))).toBe(true);
    expect(policy(session('s5', 'cdr'), session('s2', 'helper'))).toBe(false);
  });
});
