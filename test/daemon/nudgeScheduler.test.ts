import { describe, expect, it } from 'vitest';
import { NudgeScheduler } from '../../src/daemon/nudgeScheduler.js';

describe('nudge delivery scheduler', () => {
  it('keeps busy, draft and unknown sessions pending until ready, then delivers once', async () => {
    let now = 100_000;
    const state = new Map([['busy', 'busy'], ['draft', 'draft'], ['unknown', 'unknown'], ['ready', 'ready']]);
    const sent: string[] = [];
    const scheduler = new NudgeScheduler({ now: () => now, intervalMs: 30_000, perMinute: 20,
      deliver: (id) => {
        if (state.get(id) !== 'ready') return Promise.resolve('wait');
        sent.push(id);
        return Promise.resolve('sent');
      } });
    for (const id of state.keys()) scheduler.queue(id);
    await scheduler.tick();
    expect(sent).toEqual(['ready']);
    for (const id of ['busy', 'draft', 'unknown']) state.set(id, 'ready');
    now += 5_000;
    await scheduler.tick();
    await scheduler.tick();
    expect(sent).toEqual(['ready', 'busy', 'draft', 'unknown']);
  });

  it('keeps delivering to later recipients when one recipient fails, then reports the failure', async () => {
    let now = 100_000;
    let failA = true;
    const sent: string[] = [];
    const scheduler = new NudgeScheduler({ now: () => now, intervalMs: 30_000, perMinute: 20,
      deliver: (id) => {
        if (id === 'a' && failA) return Promise.reject(new Error('Session a exited while input was being written.'));
        sent.push(id);
        return Promise.resolve('sent');
      } });
    scheduler.queue('a'); scheduler.queue('b');
    await expect(scheduler.tick()).rejects.toThrow('exited while input was being written');
    expect(sent).toEqual(['b']);
    failA = false;
    now += 5_000;
    await scheduler.tick();
    expect(sent).toEqual(['b', 'a']);
  });

  it('limits each session to one nudge in thirty seconds and the daemon to two per minute', async () => {
    let now = 100_000;
    const sent: string[] = [];
    const scheduler = new NudgeScheduler({ now: () => now, intervalMs: 30_000, perMinute: 2,
      deliver: (id) => { sent.push(id); return Promise.resolve('sent'); } });
    scheduler.queue('a'); scheduler.queue('b'); scheduler.queue('c');
    await scheduler.tick();
    expect(sent).toEqual(['a', 'b']);
    scheduler.queue('a');
    now += 29_999;
    await scheduler.tick();
    expect(sent).toHaveLength(2);
    now += 30_001;
    await scheduler.tick();
    expect(sent).toEqual(['a', 'b', 'c', 'a']);
  });

  it('removes ended sessions without delivering', async () => {
    const sent: string[] = [];
    const scheduler = new NudgeScheduler({ now: () => 100_000, intervalMs: 30_000, perMinute: 20,
      deliver: (id) => { sent.push(id); return Promise.resolve('sent'); } });
    scheduler.queue('outside'); scheduler.remove('outside');
    scheduler.queue('ended'); scheduler.remove('ended');
    await scheduler.tick();
    expect(sent).toEqual([]);
  });
  it('keeps a session pending when a message arrives during its delivery', async () => {
    let now = 10_000;
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstCall = new Promise<void>((resolve) => { entered = resolve; });
    const scheduler = new NudgeScheduler({ now: () => now, intervalMs: 30_000, perMinute: 60,
      deliver: async () => {
        calls++;
        if (calls === 1) { entered(); await held; }
        return 'sent';
      },
    });
    scheduler.queue('recipient');
    const firstTick = scheduler.tick();
    await firstCall;
    scheduler.queue('recipient');
    release();
    await firstTick;
    now += 30_000;
    await scheduler.tick();
    expect(calls).toBe(2);
    now += 30_000;
    await scheduler.tick();
    expect(calls).toBe(2);
  });
});
