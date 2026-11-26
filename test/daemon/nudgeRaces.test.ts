import { describe, expect, it } from 'vitest';
import { Mailbox } from '../../src/core/mailbox.js';
import { Daemon } from '../../src/daemon/server.js';

type Change = 'output' | 'draft' | 'prompt' | 'read' | 'resize';

describe('queued nudge delivery', () => {
  it.each<Change>(['output', 'draft', 'prompt', 'read', 'resize'])(
    'keeps a message waiting when %s arrives before the queued write', async (change) => {
      const mailbox = new Mailbox({ enabled: true, policy: () => true });
      mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
      const sender = mailbox.claim('sender');
      const message = mailbox.send(sender.claimId, 'recipient', 'private text');
      const second = change === 'read' ? mailbox.send(sender.claimId, 'recipient', 'more private text') : undefined;
      let screen = 'idle screen';
      let prompt = false;
      let revision = 0;
      const written: string[] = [];
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const atWrite = new Promise<void>((resolve) => { reached = resolve; });
      const session = {
        exited: false,
        hasPainted: () => true,
        nudgeReady: () => true,
        nudgeState: () => ({ ready: true, queued: false }),
        snapshot: () => Promise.resolve({ screen, exited: false }),
        answerablePrompt: () => prompt ? { signature: 'prompt' } : null,
        lastChangeAt: () => 100,
        nudgeInputVersion: () => 0,
        nudgeQueuedInputVersion: () => 0,
        nudgeScreenRevision: () => revision,
        getStalled: () => undefined,
        nudgeSubmit: () => '\r',
        nudgePendingLine: () => null,
        writeNudgeWithReason: async (data: string, ready: (current: string, phase: 'before' | 'submit') => boolean) => {
          reached();
          await gate;
          if (!ready(screen, 'before')) return 'wait';
          written.push(data);
          return 'sent';
        },
      };
      const actions: string[] = [];
      const daemon = Object.create(Daemon.prototype) as Daemon;
      Object.assign(daemon, {
        manager: { get: () => session }, mailbox, now: () => 10_000,
        audit: { record: (_actor: string, action: string) => actions.push(action) },
      });
      const delivery = daemon['deliverNudge']('recipient');
      await atWrite;
      if (change === 'output' || change === 'draft') screen = change;
      if (change === 'prompt') prompt = true;
      if (change === 'read') mailbox.inbox('recipient', { limit: 1 });
      if (change === 'resize') revision++;
      release();
      expect(await delivery).toBe('wait');
      expect(written).toEqual([]);
      expect(actions).toEqual([]);
      expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === message.id)?.state)
        .toBe(change === 'read' ? 'read' : 'waiting');
      if (second !== undefined) {
        expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === second.id)?.state).toBe('waiting');
      }
    },
  );
});

describe('a nudge the agent never answered', () => {
  function stubSession(written: string[]) {
    return {
      exited: false,
      hasPainted: () => true,
      nudgeReady: () => true,
      nudgeState: () => ({ ready: true, queued: false }),
      snapshot: () => Promise.resolve({ screen: 'idle screen', exited: false }),
      answerablePrompt: () => null,
      lastChangeAt: () => 100,
      nudgeInputVersion: () => 0,
      nudgeQueuedInputVersion: () => 0,
      nudgeScreenRevision: () => 0,
      getStalled: () => undefined,
      nudgeSubmit: () => '\r',
      nudgePendingLine: () => null,
      writeNudgeWithReason: (data: string, ready: (current: string, phase: 'before' | 'submit') => boolean) => {
        if (!ready('idle screen', 'before')) return Promise.resolve('wait');
        written.push(data);
        return Promise.resolve('sent');
      },
    };
  }

  it('does not repeat a nudge for the same unread message', async () => {
    const mailbox = new Mailbox({ enabled: true, policy: () => true });
    mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
    const sender = mailbox.claim('sender');
    mailbox.send(sender.claimId, 'recipient', 'first');
    const written: string[] = [];
    const daemon = Object.create(Daemon.prototype) as Daemon;
    Object.assign(daemon, {
      manager: { get: () => stubSession(written) }, mailbox, now: () => 10_000,
      audit: { record: () => undefined },
    });
    expect(await daemon['deliverNudge']('recipient')).toBe('sent');
    expect(await daemon['deliverNudge']('recipient')).toBe('done');
    expect(written).toHaveLength(1);
  });

  it('nudges again for a later message, listing the unread one too', async () => {
    const mailbox = new Mailbox({ enabled: true, policy: () => true });
    mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
    const sender = mailbox.claim('sender');
    const first = mailbox.send(sender.claimId, 'recipient', 'first');
    const written: string[] = [];
    const actions: Array<{ action: string; meta: unknown }> = [];
    const daemon = Object.create(Daemon.prototype) as Daemon;
    Object.assign(daemon, {
      manager: { get: () => stubSession(written) }, mailbox, now: () => 10_000,
      audit: { record: (_actor: string, action: string, _id: string, meta: unknown) => actions.push({ action, meta }) },
    });
    expect(await daemon['deliverNudge']('recipient')).toBe('sent');
    // The agent never read the first message. A second one arrives.
    const second = mailbox.send(sender.claimId, 'recipient', 'second');
    expect(await daemon['deliverNudge']('recipient')).toBe('sent');
    expect(written).toHaveLength(2);
    expect(written[1]).toContain(first.id);
    expect(written[1]).toContain(second.id);
    expect(actions.filter((entry) => entry.action === 'nudge').at(-1)?.meta).toMatchObject({ messageIds: [second.id] });
    expect(mailbox.outbox(sender.claimId).map((entry) => entry.state)).toEqual(['nudged', 'nudged']);
  });
});

describe('a queued nudge awaiting the recipient', () => {
  it('does not type another line while an aborted body and a queued hold coexist', async () => {
    const mailbox = new Mailbox({ enabled: true, policy: () => true });
    mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
    const sender = mailbox.claim('sender');
    const first = mailbox.send(sender.claimId, 'recipient', 'first');
    mailbox.markNudged([first.id]);
    const second = mailbox.send(sender.claimId, 'recipient', 'second');
    let pending: string | null = 'retained body';
    let writes = 0;
    const audit: string[] = [];
    const session = {
      exited: false,
      nudgePendingLine: () => pending,
      nudgePendingIds: () => [first.id],
      clearConsumedNudge: () => Promise.resolve(false),
      nudgePendingSafeToSubmit: () => false,
      nudgeReadyWithLine: () => false,
      nudgePendingAuditOnce: () => false,
      nudgeState: () => ({ ready: true, queued: true }),
      writeNudgeWithReason: () => { writes++; return Promise.resolve('sent'); },
    };
    const daemon = Object.create(Daemon.prototype) as Daemon;
    Object.assign(daemon, {
      manager: { get: () => session }, mailbox, now: () => 10_000,
      queuedMessageNudges: new Map([['recipient', {
        at: 9_999, messageIds: [first.id], heldIds: new Set<string>(),
      }]]),
      audit: { record: (_actor: string, action: string) => audit.push(action) },
    });
    expect(await daemon['deliverNudge']('recipient')).toBe('wait');
    expect(writes).toBe(0);
    expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === second.id)?.state).toBe('waiting');
    pending = null;
    expect(await daemon['deliverNudge']('recipient')).toBe('wait');
    expect(writes).toBe(0);
    expect(audit).toContain('nudge-held');
  });

  it('holds a later message without typing a second queued line', async () => {
    const mailbox = new Mailbox({ enabled: true, policy: () => true });
    mailbox.register({ kind: 'session', id: 'recipient', name: 'recipient' });
    const sender = mailbox.claim('sender');
    const first = mailbox.send(sender.claimId, 'recipient', 'first');
    const written: string[] = [];
    const audit: Array<{ action: string; meta: Record<string, unknown> }> = [];
    let inputVersion = 0;
    let now = 10_000;
    let idle = false;
    let screen = 'busy screen';
    const session = {
      exited: false,
      hasPainted: () => true,
      nudgeReady: () => true,
      nudgeState: () => ({ ready: true, queued: !idle }),
      snapshot: () => Promise.resolve({ screen, exited: false }),
      answerablePrompt: () => null,
      lastChangeAt: () => 100,
      nudgeInputVersion: () => inputVersion,
      nudgeQueuedInputVersion: () => 0,
      nudgeScreenRevision: () => 0,
      getStalled: () => undefined,
      nudgeSubmit: () => '\r',
      nudgePendingLine: () => null,
      nudgeReadyWithLine: () => true,
      writeNudgeWithReason: (data: string, ready: (screen: string, phase: 'before' | 'submit') => boolean) => {
        if (!ready(screen, 'before')) return Promise.resolve('wait');
        inputVersion++;
        if (!ready(screen, 'submit')) return Promise.resolve('wait');
        written.push(data);
        return Promise.resolve('sent');
      },
    };
    const daemon = Object.create(Daemon.prototype) as Daemon;
    Object.assign(daemon, {
      manager: { get: () => session }, mailbox, now: () => now,
      queuedMessageNudges: new Map(), inboxReadVersions: new Map(),
      audit: { record: (_actor: string, action: string, _id: string, meta: Record<string, unknown>) =>
        audit.push({ action, meta }) },
    });
    expect(await daemon['deliverNudge']('recipient')).toBe('sent');
    const second = mailbox.send(sender.claimId, 'recipient', 'second');
    expect(await daemon['deliverNudge']('recipient')).toBe('wait');
    screen = 'new turn screen';
    expect(await daemon['deliverNudge']('recipient')).toBe('wait');
    mailbox.inbox('recipient', { markRead: false });
    expect(await daemon['deliverNudge']('recipient')).toBe('wait');
    expect(written).toHaveLength(1);
    expect(mailbox.outbox(sender.claimId).map((entry) => entry.state)).toEqual(['nudged', 'waiting']);
    expect(audit.filter((entry) => entry.action === 'nudge-held')).toEqual([{
      action: 'nudge-held', meta: { reason: 'queued-nudge-pending', messageIds: [second.id],
        count: 1, queuedMessageIds: [first.id] },
    }]);
    idle = true;
    expect(await daemon['deliverNudge']('recipient')).toBe('sent');
    expect(written).toHaveLength(2);
    expect(mailbox.outbox(sender.claimId).find((entry) => entry.id === second.id)?.state).toBe('nudged');
    idle = false;
    mailbox.send(sender.claimId, 'recipient', 'third');
    expect(await daemon['deliverNudge']('recipient')).toBe('sent');
    mailbox.send(sender.claimId, 'recipient', 'fourth');
    expect(await daemon['deliverNudge']('recipient')).toBe('wait');
    now += 5 * 60_000;
    expect(await daemon['deliverNudge']('recipient')).toBe('sent');
    expect(written).toHaveLength(4);
    session.exited = true;
    expect(await daemon['deliverNudge']('recipient')).toBe('done');
    expect(daemon['queuedMessageNudges'].size).toBe(0);
  });
});
