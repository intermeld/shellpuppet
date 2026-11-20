import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { Mailbox, MAX_MAILBOX_BYTES, MAX_MAILBOX_MESSAGES } from '../../src/core/mailbox.js';

function box(): Mailbox {
  const mailbox = new Mailbox({ enabled: true, policy: () => true });
  mailbox.register({ kind: 'session', id: 'sender', name: 'sender' });
  mailbox.register({ kind: 'session', id: 'reader', name: 'reader' });
  return mailbox;
}

describe('bounded history', () => {
  it('drops read messages when a recipient ends and bounds tombstones per sender', () => {
    const mailbox = box();
    mailbox.send('sender', 'reader', 'read');
    mailbox.inbox('reader');
    mailbox.end('reader');
    expect(mailbox.log()).toEqual([]);
    for (let i = 0; i < 250; i++) {
      const id = `r${i}`;
      mailbox.register({ kind: 'session', id, name: id });
      mailbox.send('sender', id, 'pending');
      mailbox.end(id);
    }
    expect(mailbox.outbox('sender')).toHaveLength(200);
    expect(mailbox.outbox('sender')[0]?.id).toBe('m52');
    expect(mailbox.outbox('sender', { limit: 3 })).toHaveLength(3);
  });

  it('stays under daemon caps after 5,000 short-lived recipients', () => {
    const mailbox = box();
    for (let i = 0; i < 5_000; i++) {
      const id = `r${i}`;
      mailbox.register({ kind: 'session', id, name: id });
      mailbox.send('sender', id, 'x'.repeat(1024));
      mailbox.end(id);
    }
    const retained = mailbox.log();
    expect(retained.length).toBeLessThanOrEqual(MAX_MAILBOX_MESSAGES);
    expect(retained.reduce((sum, m) => sum + Buffer.byteLength(m.text), 0)).toBeLessThanOrEqual(MAX_MAILBOX_BYTES);
  });

  it('evicts the oldest tombstones at the global count and byte ceilings', () => {
    const mailbox = box();
    for (let sender = 0; sender < 11; sender++) {
      const senderId = `s${sender}`;
      mailbox.register({ kind: 'session', id: senderId, name: senderId });
      for (let i = 0; i < 200; i++) {
        const recipient = `r${sender}-${i}`;
        mailbox.register({ kind: 'session', id: recipient, name: recipient });
        mailbox.send(senderId, recipient, 'x');
        mailbox.end(recipient);
      }
    }
    expect(mailbox.log()).toHaveLength(MAX_MAILBOX_MESSAGES);
    expect(mailbox.log()[0]?.id).toBe('m201');

    const heavy = box();
    for (let sender = 0; sender < 4; sender++) {
      const senderId = `b${sender}`;
      heavy.register({ kind: 'session', id: senderId, name: senderId });
      for (let i = 0; i < 150; i++) {
        const recipient = `q${sender}-${i}`;
        heavy.register({ kind: 'session', id: recipient, name: recipient });
        heavy.send(senderId, recipient, 'x'.repeat(16 * 1024));
        heavy.end(recipient);
      }
    }
    const kept = heavy.log();
    expect(kept.reduce((sum, m) => sum + Buffer.byteLength(m.text), 0)).toBeLessThanOrEqual(MAX_MAILBOX_BYTES);
    expect(kept[0]?.id).toBe('m89');
  });

  it('refuses a send when all global space holds live unread messages', () => {
    const mailbox = box();
    for (let i = 0; i < 10; i++) {
      const recipient = `live${i}`;
      mailbox.register({ kind: 'session', id: recipient, name: recipient });
      for (let j = 0; j < 200; j++) mailbox.send('sender', recipient, 'x');
    }
    expect(mailbox.log()).toHaveLength(MAX_MAILBOX_MESSAGES);
    expect(() => mailbox.send('sender', 'reader', 'extra')).toThrow();
    expect(mailbox.log()).toHaveLength(MAX_MAILBOX_MESSAGES);
  });

  it('does not inherit an earlier holder’s outbox when an id is reused', () => {
    const mailbox = box();
    mailbox.send('sender', 'reader', 'old');
    mailbox.end('sender');
    mailbox.register({ kind: 'session', id: 'sender', name: 'sender' });
    expect(mailbox.outbox('sender')).toEqual([]);
  });
});

describe('identity and shutdown', () => {
  it('reserves claim ids and never leaves a displaced name', () => {
    const mailbox = box();
    const { claimId } = mailbox.claim('desk');
    expect(claimId).toMatch(/^claim_[a-f0-9]{32}$/);
    expect(() => mailbox.register({ kind: 'session', id: 'claim_00000000000000000000000000000000', name: 'other' })).toThrow();
    expect(() => mailbox.register({ kind: 'session', id: claimId, name: 'other' })).toThrow();
    expect(mailbox.send('sender', 'reader', 'still live').to.id).toBe('reader');
  });

  it('retries a colliding claim id without displacing its holder', () => {
    const mailbox = box();
    const first = mailbox.claim('first');
    vi.spyOn(mailbox as unknown as { newClaimId: () => string }, 'newClaimId')
      .mockReturnValueOnce(first.claimId)
      .mockReturnValueOnce('claim_11111111111111111111111111111111');
    const second = mailbox.claim('second');
    expect(second.claimId).not.toBe(first.claimId);
    expect(mailbox.send('sender', 'first', 'hello').to.id).toBe(first.claimId);
    expect(mailbox.send('sender', 'second', 'hello').to.id).toBe(second.claimId);
  });

  it('compares a missing claim against a fixed dummy digest', () => {
    const mailbox = box();
    const compare = vi.spyOn(mailbox as unknown as { compareSecrets: (a: string, b: string) => boolean }, 'compareSecrets');
    expect(mailbox.verifyClaim('claim_00000000000000000000000000000000', 'guess')).toBe(false);
    expect(compare).toHaveBeenCalledWith('guess', '0'.repeat(64));
  });

  it('finishes every transition before events and survives a throwing listener', () => {
    const mailbox = box();
    mailbox.send('sender', 'reader', 'one');
    mailbox.send('sender', 'reader', 'two');
    const wait = mailbox.waitForMessage('reader', { from: 'other' });
    const observed: string[][] = [];
    mailbox.on('state', () => { throw new Error('listener failure'); });
    mailbox.on('state', () => {
      observed.push(mailbox.outbox('sender').map((m) => m.state));
      if (observed.length === 1) {
        mailbox.register({ kind: 'session', id: 'reader', name: 'reader' });
        observed.push(mailbox.inbox('reader').map((m) => m.text));
      }
    });
    expect(() => mailbox.end('reader')).not.toThrow();
    expect(observed).toEqual([
      ['not-delivered', 'not-delivered'], [], ['not-delivered', 'not-delivered'],
    ]);
    return expect(wait).resolves.toBeUndefined();
  });
});

describe('waiting and copies', () => {
  it('resolves absent readers immediately and wakes every matching waiter', async () => {
    const mailbox = box();
    expect(await mailbox.waitForMessage('absent')).toBeUndefined();
    const first = mailbox.waitForMessage('reader');
    const second = mailbox.waitForMessage('reader');
    mailbox.send('sender', 'reader', 'hello');
    expect((await first)?.id).toBe('m1');
    expect((await second)?.id).toBe('m1');
  });

  it('checks unread messages again when a wait times out', async () => {
    vi.useFakeTimers();
    try {
      const mailbox = box();
      const wake = vi.spyOn(mailbox as unknown as { wake: (message: unknown) => void }, 'wake');
      wake.mockImplementation(() => {});
      const wait = mailbox.waitForMessage('reader', { timeoutMs: 10 });
      mailbox.send('sender', 'reader', 'arrived');
      await vi.advanceTimersByTimeAsync(10);
      expect((await wait)?.text).toBe('arrived');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns independent sender copies and hides malformed names in errors', () => {
    const mailbox = box();
    mailbox.on('message', (event) => { event.from.name = 'changed'; });
    mailbox.send('sender', 'reader', 'hello');
    const entry = mailbox.inbox('reader')[0];
    expect(entry?.from.name).toBe('sender');
    if (entry) entry.from.name = 'changed';
    expect(mailbox.log()[0]?.from.name).toBe('sender');
    try { mailbox.send('bad\ninput', 'reader', 'x'); } catch (error) {
      expect(String(error)).not.toContain('bad\ninput');
    }
    try { mailbox.send('sender', 'bad\ninput', 'x'); } catch (error) {
      expect(String(error)).not.toContain('bad\ninput');
    }
  });

  it('unrefs wait timers', async () => {
    const mailbox = box();
    const controller = new AbortController();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const wait = mailbox.waitForMessage('reader', { timeoutMs: 10_000, signal: controller.signal });
    const handle = timeout.mock.results[0]?.value as { hasRef: () => boolean };
    expect(handle.hasRef()).toBe(false);
    timeout.mockRestore();
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' });
  });
});
