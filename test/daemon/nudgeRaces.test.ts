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
        snapshot: () => Promise.resolve({ screen, exited: false }),
        answerablePrompt: () => prompt ? { signature: 'prompt' } : null,
        lastChangeAt: () => 100,
        nudgeInputVersion: () => 0,
        nudgeQueuedInputVersion: () => 0,
        nudgeScreenRevision: () => revision,
        getStalled: () => undefined,
        nudgeSubmit: () => '\r',
        writeNudge: async (data: string, ready: (current: string, phase: 'before' | 'submit') => boolean) => {
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
