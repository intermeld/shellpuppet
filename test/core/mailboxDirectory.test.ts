import { describe, expect, it } from 'vitest';
import { Mailbox, MailboxError } from '../../src/core/mailbox.js';

describe('messaging names and directory', () => {
  it('keeps session id names available for their sessions', () => {
    const mailbox = new Mailbox({ enabled: true, policy: () => true });
    expect(() => mailbox.claim('s2')).toThrowError(MailboxError);
    mailbox.register({ kind: 'session', id: 's2', name: 's2' });
    expect(mailbox.participant('s2')?.name).toBe('s2');
  });

  it('lists only live names allowed by policy', () => {
    const mailbox = new Mailbox({ enabled: true,
      policy: (from, to) => from.name === 'parent' && to.name === 'child',
    });
    mailbox.register({ kind: 'session', id: 's1', name: 'parent' });
    mailbox.register({ kind: 'session', id: 's2', name: 'child' });
    mailbox.claim('outside');
    expect(mailbox.directory('s1')).toEqual([{ kind: 'session', id: 's2', name: 'child' }]);
    mailbox.end('s2');
    expect(mailbox.directory('s1')).toEqual([]);
  });

  it('includes the caller when policy permits sending to its own name', () => {
    const mailbox = new Mailbox({ enabled: true, policy: () => true });
    mailbox.register({ kind: 'session', id: 's1', name: 'chair' });
    expect(mailbox.directory('s1')).toEqual([{ kind: 'session', id: 's1', name: 'chair' }]);
  });
});
