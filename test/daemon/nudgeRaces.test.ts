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
        nudgeComposerBlock: () => screen,
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
      nudgeComposerBlock: () => 'idle screen',
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
