import { describe, expect, it } from 'vitest';
import { SessionFeed, changedFields } from '../../src/daemon/sessionFeed.js';
import type { FeedFrame, FeedSummary } from '../../src/daemon/sessionFeed.js';
import { NULL_LOGGER } from '../../src/core/types.js';

const base: FeedSummary = {
  id: 's1', label: 'one', purpose: '', startedBy: 'client', agent: null,
  command: 'node', args: [], cols: 80, rows: 24, ready: false,
  readyReason: 'pending', geometryHeld: false, exited: false, exitCode: null,
  watchers: 0, createdAt: '2026-01-01T00:00:00.000Z',
};

describe('session feed', () => {
  it('compares visible fields and ignores the running prompt clock', () => {
    const before = { ...base, waitingOnPrompt: { question: '<img>', options: ['yes'], waitingMs: 100, alerted: false } };
    const after = { ...before, cols: 90, ready: true, readyReason: 'condition-met' as const,
      waitingOnPrompt: { ...before.waitingOnPrompt, waitingMs: 200 } };
    expect(changedFields(before, after)).toEqual(['cols', 'ready', 'readyReason']);
    expect(changedFields(after, { ...after, waitingOnPrompt: { ...after.waitingOnPrompt, alerted: true } }))
      .toEqual(['waitingOnPrompt']);
    expect(changedFields(before, { ...before, waitingOnPrompt: {
      ...before.waitingOnPrompt, options: ['no'], waitingMs: 300,
    } })).toEqual(['waitingOnPrompt']);
    expect(changedFields(base, { ...base, rows: 25, geometryHeld: true, watchers: 1,
      label: 'two', purpose: 'observe', exited: true, exitCode: 0 }))
      .toEqual(['rows', 'geometryHeld', 'watchers', 'label', 'purpose', 'exited', 'exitCode']);
  });

  it('adds and removes each id once', () => {
    let current: FeedSummary[] = [];
    const feed = new SessionFeed('1.0', () => current);
    const frames: FeedFrame[] = [];
    feed.subscribe((frame) => frames.push(frame));
    current = [base];
    feed.add(base);
    feed.add(base);
    feed.remove(base.id);
    feed.remove(base.id);
    expect(frames.filter((frame) => frame.type === 'session-added')).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'session-removed')).toHaveLength(1);
  });

  it('logs each listener failure without recording screen content', () => {
    const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
    const feed = new SessionFeed('1.0', () => [base], {
      ...NULL_LOGGER,
      warn: (message, meta) => warnings.push({ message, meta }),
    });
    feed.subscribe(() => { throw new Error('screen text: <img onerror=alert(1)>'); });
    feed.update({ ...base, cols: 81 });
    expect(warnings).toHaveLength(3);
    expect(warnings.map((entry) => entry.message)).toEqual([
      'session feed listener failed',
      'session feed listener failed',
      'session feed listener failed',
    ]);
    expect(JSON.stringify(warnings)).not.toContain('<img');
  });

  it('delivers a snapshot before re-entrant deltas and isolates listeners', () => {
    let current = [base];
    const feed = new SessionFeed('1.0', () => current);
    const first: FeedFrame[] = [];
    const second: FeedFrame[] = [];
    feed.subscribe((frame) => {
      first.push(frame);
      if (frame.type === 'hello') {
        current = [...current, { ...base, id: 's2' }];
        feed.add(current[1]!);
      }
    });
    const unsubscribe = feed.subscribe((frame) => second.push(frame));
    feed.subscribe(() => { throw new Error('listener failed'); });
    feed.update({ ...base, cols: 100 });
    unsubscribe();
    feed.remove('s1');
    expect(first.map((frame) => frame.type)).toEqual([
      'hello', 'snapshot', 'session-added', 'session-updated', 'session-removed',
    ]);
    expect((first[1] as Extract<FeedFrame, { type: 'snapshot' }>).sessions.map((s) => s.id))
      .toEqual(['s1']);
    expect(second.map((frame) => frame.type)).toEqual(['hello', 'snapshot', 'session-updated']);
    expect(first.filter((frame) => frame.type === 'session-removed')).toHaveLength(1);

    const duringDispatch: FeedFrame[] = [];
    feed.subscribe((frame) => {
      if (frame.type === 'session-added') feed.subscribe((late) => duringDispatch.push(late));
    });
    current = [...current, { ...base, id: 's3' }];
    feed.add(current[2]!);
    expect(duringDispatch.map((frame) => frame.type)).toEqual(['hello', 'snapshot']);
    expect((duringDispatch[1] as Extract<FeedFrame, { type: 'snapshot' }>).sessions)
      .toContainEqual(expect.objectContaining({ id: 's3' }));

    const replay: FeedFrame[] = [];
    let replayState = [base];
    const replayFeed = new SessionFeed('1.0', () => replayState);
    replayFeed.subscribe((frame) => {
      replay.push(frame);
      if (frame.type === 'hello') {
        replayState = [...replayState, { ...base, id: 's2' }];
        replayFeed.add(replayState[1]!);
      }
      if (frame.type === 'session-added') replayFeed.update({ ...frame.session, cols: 81 });
    });
    expect(replay.map((frame) => frame.type)).toEqual([
      'hello', 'snapshot', 'session-added', 'session-updated',
    ]);
  });
});
