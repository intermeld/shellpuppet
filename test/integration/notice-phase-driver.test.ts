import { afterEach, expect, it, vi } from 'vitest';
import { phaseDriver } from '../fixtures/notice-phase-driver.mjs';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([0, 240])('releases the next row at the observed deadline with %i ms acknowledgement delay', delay => {
  vi.useFakeTimers({ now: 1000 });
  const writes: { at: number; bytes: string }[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(bytes => {
    writes.push({ at: Date.now(), bytes: String(bytes) });
    return true;
  });
  const driver = phaseDriver();
  driver.start([['first', 800, 8], ['next', 100, 9]]);
  // The browser observes row 8 at 1035 ms, after the initial write at 1000 ms.
  vi.advanceTimersByTime(35);
  const parsedAt = Date.now();
  vi.advanceTimersByTime(delay);
  driver.read(`a1:${String(parsedAt)};`);
  vi.advanceTimersByTime(800 - delay);
  expect(writes).toEqual([
    { at: 1000, bytes: 'first\x1b]777;1:800:8\x07' },
    { at: 1835, bytes: 'next\x1b]777;2:100:9\x07' },
  ]);
});
