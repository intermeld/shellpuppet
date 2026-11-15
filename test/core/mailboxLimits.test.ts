/**
 * The mailbox limits: one message's size, and the per-recipient message count
 * and byte ceiling, including which messages are dropped to make room (design
 * §2.5).
 */

import { describe, expect, it } from 'vitest';
import { Mailbox, MailboxError } from '../../src/core/mailbox.js';
import type { MailboxErrorCode } from '../../src/core/mailbox.js';

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_INBOX_MESSAGES = 200;
const MAX_INBOX_BYTES = 1024 * 1024;

function fullPair(): Mailbox {
  const box = new Mailbox({ enabled: true, policy: () => true, now: () => 0 });
  box.register({ kind: 'session', id: 's1', name: 'chair' });
  box.register({ kind: 'session', id: 's2', name: 'helper' });
  return box;
}

function refuse(call: () => unknown): MailboxErrorCode {
  try {
    call();
  } catch (error) {
    if (error instanceof MailboxError) return error.code;
    throw error;
  }
  throw new Error('expected the call to refuse');
}

describe('one message', () => {
  it('accepts exactly 16 KiB of UTF-8 text and refuses one byte more', () => {
    const box = fullPair();
    expect(() => box.send('s1', 'helper', 'a'.repeat(MAX_MESSAGE_BYTES), 1)).not.toThrow();
    expect(refuse(() => box.send('s1', 'helper', 'a'.repeat(MAX_MESSAGE_BYTES + 1), 1))).toBe('text-too-large');
  });

  it('counts bytes, not characters', () => {
    const box = fullPair();
    // é is two bytes in UTF-8.
    expect(() => box.send('s1', 'helper', 'é'.repeat(MAX_MESSAGE_BYTES / 2), 1)).not.toThrow();
    expect(refuse(() => box.send('s1', 'helper', 'é'.repeat(MAX_MESSAGE_BYTES / 2 + 1), 1))).toBe('text-too-large');
  });

  it('a refused send consumes no message id', () => {
    const box = fullPair();
    box.send('s1', 'helper', 'one', 1);
    refuse(() => box.send('s1', 'helper', 'x'.repeat(MAX_MESSAGE_BYTES + 1), 2));
    expect(box.send('s1', 'helper', 'two', 3).id).toBe('m2');
  });
});

describe('the per-recipient message count', () => {
  it('holds at most 200 messages and refuses the 201st when none is read', () => {
    const box = fullPair();
    for (let n = 0; n < MAX_INBOX_MESSAGES; n++) box.send('s1', 'helper', `m${String(n)}`, n);
    expect(box.inbox('s2', { markRead: false })).toHaveLength(MAX_INBOX_MESSAGES);
    expect(refuse(() => box.send('s1', 'helper', 'one too many', 999))).toBe('mailbox-full');
    // The refusal changed nothing.
    expect(box.inbox('s2', { markRead: false })).toHaveLength(MAX_INBOX_MESSAGES);
    expect(box.outbox('s1')).toHaveLength(MAX_INBOX_MESSAGES);
  });

  it('drops the OLDEST read messages first to make room', () => {
    const box = fullPair();
    for (let n = 0; n < MAX_INBOX_MESSAGES; n++) box.send('s1', 'helper', `m${String(n)}`, n);
    // Read the three oldest, so only those may be dropped.
    box.inbox('s2', { limit: 3 });
    const first = box.send('s1', 'helper', 'more', 999).id;
    expect(first).toBe(`m${String(MAX_INBOX_MESSAGES + 1)}`);
    const second = box.send('s1', 'helper', 'more still', 1_000);
    expect(second.id).toBe(`m${String(MAX_INBOX_MESSAGES + 2)}`);
    const held = box.log({ participantId: 's2' });
    expect(held).toHaveLength(MAX_INBOX_MESSAGES);
    // m1 and m2 were dropped as the oldest read messages; m3 survives as read.
    const ids = held.map((m) => m.id);
    expect(ids).not.toContain('m1');
    expect(ids).not.toContain('m2');
    expect(held[0]?.id).toBe('m3');
    expect(held[0]?.state).toBe('read');
    // Every unread message is still there, right through to the newest.
    expect(ids.at(-1)).toBe(second.id);
    expect(held.filter((m) => m.state !== 'read')).toHaveLength(MAX_INBOX_MESSAGES - 1);
  });

  it('limits are per recipient: another name is unaffected', () => {
    const box = fullPair();
    box.register({ kind: 'session', id: 's3', name: 'third' });
    for (let n = 0; n < MAX_INBOX_MESSAGES; n++) box.send('s1', 'helper', `m${String(n)}`, n);
    expect(refuse(() => box.send('s1', 'helper', 'full', 999))).toBe('mailbox-full');
    expect(() => box.send('s1', 'third', 'room next door', 999)).not.toThrow();
  });
});

describe('the per-recipient byte ceiling', () => {
  it('holds exactly 1 MiB of text and refuses what would pass it', () => {
    const box = fullPair();
    for (let n = 0; n < MAX_INBOX_BYTES / MAX_MESSAGE_BYTES; n++) {
      box.send('s1', 'helper', 'a'.repeat(MAX_MESSAGE_BYTES), n);
    }
    expect(refuse(() => box.send('s1', 'helper', 'a', 999))).toBe('mailbox-full');
  });

  it('drops a read message to bring the bytes back under the ceiling', () => {
    const box = fullPair();
    // The oldest message is a one-byte message the helper has already read.
    box.send('s1', 'helper', 'x', 0);
    box.inbox('s2', { limit: 1 });
    for (let n = 0; n < 63; n++) box.send('s1', 'helper', 'a'.repeat(MAX_MESSAGE_BYTES), n + 1);
    // 1 read byte + 63 x 16,384 unread = 1,032,193; one more 16,384 would be
    // 1,048,577, one byte over the ceiling, so the read message is dropped
    // and the send goes through at exactly 1 MiB.
    const sent = box.send('s1', 'helper', 'a'.repeat(MAX_MESSAGE_BYTES), 200);
    expect(sent.state).toBe('waiting');
    const held = box.log({ participantId: 's2' });
    expect(held.map((m) => m.id)).not.toContain('m1');
    expect(held).toHaveLength(64);
    expect(held.at(-1)?.id).toBe(sent.id);
  });

  it('refuses without dropping anything when dropping every read message is not enough', () => {
    const box = fullPair();
    // A full unread MiB, plus read messages that no amount of dropping can
    // offset: the unread messages alone sit at the ceiling.
    for (let n = 0; n < MAX_INBOX_BYTES / MAX_MESSAGE_BYTES; n++) {
      box.send('s1', 'helper', 'a'.repeat(MAX_MESSAGE_BYTES), n);
    }
    for (let n = 0; n < 10; n++) {
      box.send('s2', 'chair', `read ${String(n)}`, 500 + n);
      box.inbox('s1');
    }
    expect(refuse(() => box.send('s1', 'helper', 'a', 999))).toBe('mailbox-full');
    // The refusal dropped nothing: every read message is still in the log.
    const chair = box.log({ participantId: 's1' });
    expect(chair.filter((m) => m.state === 'read')).toHaveLength(10);
  });
});
