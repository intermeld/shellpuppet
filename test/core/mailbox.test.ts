/**
 * The mailbox core: name registry, claims, sending, reading, binding to the
 * recipient instance, events and waiting (design §2.5).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mailbox, MailboxError, NAME_PATTERN } from '../../src/core/mailbox.js';
import type { MailboxDeps, MailboxEntry, MailboxErrorCode } from '../../src/core/mailbox.js';

function make(overrides: Partial<MailboxDeps> = {}): Mailbox {
  return new Mailbox({ enabled: true, policy: () => true, now: () => 1_000, ...overrides });
}

/** Register two sessions that may always message each other. */
function pair(overrides: Partial<MailboxDeps> = {}): Mailbox {
  const box = make(overrides);
  box.register({ kind: 'session', id: 's1', name: 'chair' });
  box.register({ kind: 'session', id: 's2', name: 'helper' });
  return box;
}

/** The typed error code a call refuses with. */
function refuse(call: () => unknown): MailboxErrorCode {
  try {
    call();
  } catch (error) {
    if (error instanceof MailboxError) return error.code;
    throw error;
  }
  throw new Error('expected the call to refuse');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('names', () => {
  it('accepts every character class the pattern allows, up to 40 characters', () => {
    expect(NAME_PATTERN.test('chair')).toBe(true);
    expect(NAME_PATTERN.test('chair-2')).toBe(true);
    expect(NAME_PATTERN.test('a.very_long-name.1')).toBe(true);
    expect(NAME_PATTERN.test('x'.repeat(40))).toBe(true);
  });

  it('refuses an invalid name with a typed error', () => {
    const box = make();
    for (const bad of ['', 'has space', 'a\nb', 'a\tb', 'ünïcode', 'x'.repeat(41), 'semi;colon', 'a/b']) {
      const code = refuse(() => box.register({ kind: 'session', id: 's1', name: bad }));
      expect(code, JSON.stringify(bad)).toBe('invalid-name');
    }
  });

  it('refuses a name another live participant holds, sessions and claims alike', () => {
    const box = make();
    box.register({ kind: 'session', id: 's1', name: 'chair' });
    expect(refuse(() => box.register({ kind: 'session', id: 's2', name: 'chair' }))).toBe('duplicate-name');
    expect(refuse(() => box.claim('chair'))).toBe('duplicate-name');
  });

  it('refuses to register the same participant id twice', () => {
    const box = make();
    box.register({ kind: 'session', id: 's1', name: 'chair' });
    expect(refuse(() => box.register({ kind: 'session', id: 's1', name: 'other' }))).toBe('duplicate-id');
  });

  it('ends a participant and frees its name', () => {
    const box = make();
    box.register({ kind: 'session', id: 's1', name: 'chair' });
    box.end('s1');
    expect(() => box.register({ kind: 'session', id: 's2', name: 'chair' })).not.toThrow();
    // Ending an unknown or already-ended participant is a no-op.
    expect(() => box.end('s1')).not.toThrow();
    expect(() => box.end('nope')).not.toThrow();
  });
});

describe('claims', () => {
  it('claims a name and hands back a claim id and a secret', () => {
    const box = make();
    const { claimId, secret } = box.claim('desk');
    expect(claimId).toMatch(/^claim_[a-f0-9]{32}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(box.verifyClaim(claimId, secret)).toBe(true);
  });

  it('refuses a wrong secret, an unknown claim and a released claim', () => {
    const box = make();
    const { claimId, secret } = box.claim('desk');
    expect(box.verifyClaim(claimId, 'x'.repeat(secret.length))).toBe(false);
    expect(box.verifyClaim('c99', secret)).toBe(false);
    box.release(claimId);
    expect(box.verifyClaim(claimId, secret)).toBe(false);
    expect(() => box.claim('desk')).not.toThrow();
  });

  it('a claim can send and receive like any participant', () => {
    const box = pair();
    const { claimId, secret } = box.claim('desk');
    expect(secret).not.toBe('');
    box.send(claimId, 'helper', 'from outside', 5);
    expect(box.inbox('s2').map((m) => m.text)).toEqual(['from outside']);
    box.send('s1', 'desk', 'to outside', 6);
    const forDesk = box.inbox(claimId);
    expect(forDesk.map((m) => m.text)).toEqual(['to outside']);
    expect(forDesk[0]?.from.kind).toBe('session');
  });
});

describe('send', () => {
  it('returns the id, the recipient instance and the state', () => {
    const box = pair();
    expect(box.send('s1', 'helper', 'first', 10)).toEqual({
      id: 'm1',
      to: { id: 's2', name: 'helper' },
      state: 'waiting',
    });
    expect(box.send('s2', 'chair', 'second', 11).id).toBe('m2');
  });

  it('refuses when messaging is disabled, whatever the policy says', () => {
    const box = pair({ enabled: false, policy: () => true });
    expect(refuse(() => box.send('s1', 'helper', 'hi', 1))).toBe('messaging-disabled');
  });

  it('refuse order: sender, switch, name, policy, text', () => {
    const box = pair({ policy: () => false });
    expect(refuse(() => box.send('s9', 'helper', 'hi', 1))).toBe('unknown-sender');
    box.end('s1');
    expect(refuse(() => box.send('s1', 'helper', 'hi', 1))).toBe('unknown-sender');
    expect(refuse(() => box.send('s2', 'nobody', 'hi', 1))).toBe('unknown-name');
    expect(refuse(() => box.send('s2', 'helper', 'hi', 1))).toBe('not-allowed');
    // The text is only judged once the policy allows the pair.
    const open = pair();
    expect(refuse(() => open.send('s1', 'helper', '', 1))).toBe('empty-text');
  });

  it('passes both participants to the policy with their kinds', () => {
    const seen: Array<[string, string]> = [];
    const box = new Mailbox({
      enabled: true,
      policy: (from, to) => {
        seen.push([`${from.kind}:${from.name}`, `${to.kind}:${to.name}`]);
        return true;
      },
      now: () => 0,
    });
    box.register({ kind: 'session', id: 's1', name: 'chair' });
    const { claimId } = box.claim('desk');
    box.send('s1', 'desk', 'hello', 1);
    expect(seen).toEqual([['session:chair', 'claim:desk']]);
    box.send(claimId, 'chair', 'back', 2);
    expect(seen[1]).toEqual(['claim:desk', 'session:chair']);
  });

  it('stamps the injected clock, or the explicit time when one is given', () => {
    const box = new Mailbox({ enabled: true, policy: () => true, now: () => 777 });
    box.register({ kind: 'session', id: 's1', name: 'chair' });
    box.register({ kind: 'session', id: 's2', name: 'helper' });
    expect(box.send('s1', 'helper', 'a').state).toBe('waiting');
    expect(box.send('s1', 'helper', 'b', 999).id).toBe('m2');
    const entries = box.inbox('s2');
    expect(entries[0]?.time).toBe(777);
    expect(entries[1]?.time).toBe(999);
  });
});

describe('reading', () => {
  function filled(): Mailbox {
    const box = pair();
    box.send('s1', 'helper', 'one', 10);
    box.send('s1', 'helper', 'two', 20);
    return box;
  }

  it('returns unread messages oldest first with every field', () => {
    const entry = filled().inbox('s2', { markRead: false })[0];
    expect(entry).toEqual({
      id: 'm1',
      from: { id: 's1', name: 'chair', kind: 'session' },
      to: { id: 's2', name: 'helper' },
      time: 10,
      text: 'one',
      state: 'waiting',
    });
    // With the default markRead the returned entries show their new state.
    const read = filled().inbox('s2')[0];
    expect(read?.state).toBe('read');
  });

  it('marks messages read by default, and then they are gone from the inbox', () => {
    const box = filled();
    const states: string[] = [];
    box.on('state', (event) => states.push(`${event.id}:${event.state}`));
    const read = box.inbox('s2');
    expect(read.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(states).toEqual(['m1:read', 'm2:read']);
    expect(box.inbox('s2')).toEqual([]);
    expect(box.outbox('s1').map((m) => m.state)).toEqual(['read', 'read']);
  });

  it('markRead false leaves the messages unread and emits no state events', () => {
    const box = filled();
    const states: string[] = [];
    box.on('state', (event) => states.push(event.id));
    const unread = box.inbox('s2', { markRead: false });
    expect(unread).toHaveLength(2);
    expect(box.inbox('s2', { markRead: false })).toHaveLength(2);
    expect(states).toEqual([]);
  });

  it('limit returns the oldest messages and marks only those read', () => {
    const box = filled();
    const oldest = box.inbox('s2', { limit: 1 });
    expect(oldest.map((m) => m.id)).toEqual(['m1']);
    expect(box.inbox('s2').map((m) => m.id)).toEqual(['m2']);
  });

  it('an unknown reader has an empty inbox, and the outbox holds states', () => {
    const box = filled();
    expect(box.inbox('s9')).toEqual([]);
    expect(box.outbox('s2')).toEqual([]);
    expect(box.outbox('s1').map((m) => [m.id, m.state])).toEqual([['m1', 'waiting'], ['m2', 'waiting']]);
  });

  it('markNudged moves waiting to nudged, once, and nudged stays unread', () => {
    const box = filled();
    const states: string[] = [];
    box.on('state', (event) => states.push(`${event.id}:${event.state}`));
    box.markNudged(['m1', 'm9']);
    expect(states).toEqual(['m1:nudged']);
    box.markNudged(['m1']);
    expect(states).toEqual(['m1:nudged']);
    expect(box.inbox('s2', { markRead: false })[0]?.state).toBe('nudged');
    box.inbox('s2');
    box.markNudged(['m1']);
    // m2 was read by the same inbox call, and nudging a read message does nothing.
    expect(states).toEqual(['m1:nudged', 'm1:read', 'm2:read']);
  });
});

describe('binding to the recipient instance', () => {
  it('unread messages become not-delivered when the recipient ends', () => {
    const box = pair();
    box.send('s1', 'helper', 'one', 10);
    box.send('s1', 'helper', 'two', 11);
    box.inbox('s2', { limit: 1 });
    const states: string[] = [];
    box.on('state', (event) => states.push(`${event.id}:${event.state}`));
    box.end('s2');
    expect(states).toEqual(['m2:not-delivered']);
    expect(box.outbox('s1').map((m) => [m.id, m.state])).toEqual([['m2', 'not-delivered']]);
  });

  it('never re-delivers to a later holder of the same name', () => {
    const box = pair();
    box.send('s1', 'helper', 'for the first helper', 10);
    box.end('s2');
    box.register({ kind: 'session', id: 's3', name: 'helper' });
    expect(box.inbox('s3')).toEqual([]);
    expect(box.outbox('s1')[0]?.state).toBe('not-delivered');
  });

  it('a send after the end resolves the NEW holder of the name', () => {
    const box = pair();
    box.end('s2');
    box.register({ kind: 'session', id: 's3', name: 'helper' });
    const result = box.send('s1', 'helper', 'for the second helper', 10);
    expect(result.to).toEqual({ id: 's3', name: 'helper' });
    expect(box.inbox('s3').map((m) => m.text)).toEqual(['for the second helper']);
  });
});

describe('events', () => {
  it('the message event carries id, from, to and state but never the text', () => {
    const box = pair();
    const events: unknown[] = [];
    box.on('message', (event) => events.push(event));
    box.send('s1', 'helper', 'the secret payload', 1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain('the secret payload');
    expect(events[0]).not.toHaveProperty('text');
    expect(events[0]).toEqual({
      id: 'm1',
      from: { id: 's1', name: 'chair', kind: 'session' },
      to: { id: 's2', name: 'helper' },
      state: 'waiting',
    });
  });
});

describe('log', () => {
  it('returns every message with its state and text, oldest first', () => {
    const box = pair();
    box.send('s1', 'helper', 'one', 10);
    box.send('s2', 'chair', 'two', 11);
    box.inbox('s2');
    const all = box.log();
    expect(all.map((m) => [m.id, m.state, m.text])).toEqual([
      ['m1', 'read', 'one'],
      ['m2', 'waiting', 'two'],
    ]);
  });

  it('filters by participant, sent or received', () => {
    const box = pair();
    box.register({ kind: 'session', id: 's3', name: 'third' });
    box.send('s1', 'helper', 'one', 10);
    box.send('s2', 'chair', 'two', 11);
    box.send('s3', 'chair', 'three', 12);
    expect(box.log({ participantId: 's1' }).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(box.log({ participantId: 's2' }).map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(box.log({ participantId: 's3' }).map((m) => m.id)).toEqual(['m3']);
  });

  it('limit keeps the most recent messages, still oldest first', () => {
    const box = pair();
    box.send('s1', 'helper', 'one', 10);
    box.send('s1', 'helper', 'two', 11);
    box.send('s1', 'helper', 'three', 12);
    expect(box.log({ limit: 2 }).map((m) => m.id)).toEqual(['m2', 'm3']);
  });
});

describe('waitForMessage', () => {
  it('resolves at once when an unread message is already waiting', async () => {
    const box = pair();
    box.send('s1', 'helper', 'one', 10);
    const entry: MailboxEntry | undefined = await box.waitForMessage('s2');
    expect(entry?.id).toBe('m1');
    // Waiting did not mark it read.
    expect(box.inbox('s2')).toHaveLength(1);
  });

  it('resolves the moment a message arrives, with no timer to advance', async () => {
    vi.useFakeTimers();
    const box = pair();
    let settled = false;
    const wait = box.waitForMessage('s2').then((entry) => {
      settled = true;
      return entry;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    box.send('s1', 'helper', 'hello', 10);
    const entry = await wait;
    expect(entry?.text).toBe('hello');
  });

  it('can wait for one sender only', async () => {
    const box = pair();
    box.register({ kind: 'session', id: 's3', name: 'third' });
    let settled = false;
    const wait = box.waitForMessage('s2', { from: 's3' }).then((entry) => {
      settled = true;
      return entry;
    });
    box.send('s1', 'helper', 'from the chair', 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    box.send('s3', 'helper', 'from the third', 11);
    const entry = await wait;
    expect(entry?.id).toBe('m2');
    expect(entry?.text).toBe('from the third');
  });

  it('takes the sender by name, for a message already waiting', async () => {
    const box = pair();
    box.register({ kind: 'session', id: 's3', name: 'third' });
    box.send('s1', 'helper', 'from the chair', 10);
    box.send('s3', 'helper', 'from the third', 11);
    const entry = await box.waitForMessage('s2', { from: 'third', timeoutMs: 1_000 });
    expect(entry?.id).toBe('m2');
  });

  it('takes the sender by name, for a message that arrives later', async () => {
    const box = pair();
    box.register({ kind: 'session', id: 's3', name: 'third' });
    let settled = false;
    const wait = box.waitForMessage('s2', { from: 'third', timeoutMs: 5_000 }).then((entry) => {
      settled = true;
      return entry;
    });
    box.send('s1', 'helper', 'from the chair', 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    box.send('s3', 'helper', 'from the third', 11);
    expect((await wait)?.id).toBe('m2');
  });

  it('resolves with undefined when the timeout passes with no message', async () => {
    vi.useFakeTimers();
    const box = pair();
    const done = vi.fn();
    void box.waitForMessage('s2', { timeoutMs: 5_000 }).then(done);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('rejects with an abort error when the caller aborts', async () => {
    const box = pair();
    const controller = new AbortController();
    const wait = box.waitForMessage('s2', { signal: controller.signal });
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects at once when the signal is already aborted', async () => {
    const box = pair();
    const controller = new AbortController();
    controller.abort();
    await expect(box.waitForMessage('s2', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves with undefined when the reader ends while it waits', async () => {
    const box = pair();
    const wait = box.waitForMessage('s2');
    box.end('s2');
    expect(await wait).toBeUndefined();
  });
});
