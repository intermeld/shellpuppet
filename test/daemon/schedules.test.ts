import { expect, it, vi } from 'vitest';
import { parseDaemonConfig } from '../../src/daemon/config.js';

const entry = { name: 'hourly-check', session: 'worker.1', message: 'Private check.', cron: '* * * * *',
  whenBusy: 'skip', enabled: true } as const;

it.each([
  [{ name: 'Bad Name' }, 'name'], [{ session: 'bad name' }, 'session'],
  [{ cron: '* * * *' }, 'cron'], [{ message: '' }, 'message'],
  [{ message: 'x'.repeat(2001) }, 'message'], [{ message: 'first\nsecond' }, 'message'],
  [{ message: 'first\u2028second' }, 'message'], [{ message: 'a\x85b' }, 'message'],
  [{ whenBusy: undefined }, 'whenBusy'], [{ whenBusy: 'wait' }, 'whenBusy'],
  [{ enabled: 1 }, 'enabled'], [{ extra: 2 }, 'key'],
] as const)('reports the named invalid entry and retains its sibling (%s)', (patch, field) => {
  const bad = { ...entry, ...patch };
  const good = { ...entry, name: 'other' };
  const result = parseDaemonConfig({ schedules: [bad, good] });
  expect(result.problems.join(' ')).toContain(bad.name);
  expect(result.problems.join(' ')).toContain(field);
  expect(result.config.schedules).toEqual([good]);
});

it('excludes both entries with a duplicate name and accepts 2000 Unicode characters', () => {
  const good = { ...entry, name: 'other', message: '🍐'.repeat(2000) };
  const result = parseDaemonConfig({ schedules: [entry, good, { ...entry, message: 'different' }] });
  expect(result.problems.join(' ')).toMatch(/hourly-check.*unique|hourly-check.*duplicate/i);
  expect(result.config.schedules).toEqual([good]);
});

it('aligns the first tick, ignores duplicate minutes and skips elapsed minutes', async () => {
  vi.useFakeTimers();
  try {
    const { ScheduleStore, PromptScheduler } = await import('../../src/daemon/schedules.js');
    vi.setSystemTime(new Date('2026-11-21T12:34:59.750Z'));
    const store = new ScheduleStore();
    store.replace([entry, { ...entry, name: 'off', enabled: false }]);
    const deliver = vi.fn(() => Promise.resolve({ outcome: 'sent' as const }));
    const scheduler = new PromptScheduler(store, Date.now, deliver, () => {});
    scheduler.start();
    await vi.advanceTimersByTimeAsync(249);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    await scheduler.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-24T12:34:01Z'));
    await scheduler.tick();
    await scheduler.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it('rechecks ownership of an in-flight run when its entry is edited or its minute expires', async () => {
  const { ScheduleStore, PromptScheduler } = await import('../../src/daemon/schedules.js');
  const store = new ScheduleStore();
  store.replace([entry]);
  let now = 0;
  let release!: () => void;
  let current!: () => boolean;
  const audit = vi.fn();
  const scheduler = new PromptScheduler(store, () => now, async (_schedule, check) => {
    current = check;
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: 'aborted', reason: 'schedule-changed' };
  }, audit);
  scheduler.start();
  try {
    now += 60_000;
    const first = scheduler.tick();
    store.replace([{ ...entry }]);
    expect(current()).toBe(true);
    store.replace([{ ...entry, message: 'Another check.' }]);
    expect(current()).toBe(false);
    now += 60_000;
    await scheduler.tick();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ name: entry.name }), { outcome: 'skipped', reason: 'pending' });
    release();
    await first;
    now += 60_000;
    const second = scheduler.tick();
    expect(current()).toBe(true);
    now += 60_000;
    expect(current()).toBe(false);
    release();
    await second;
  } finally { scheduler.stop(); }
});
