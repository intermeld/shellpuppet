import { describe, expect, it } from 'vitest';
import { createConsoleHostQueue } from '../../src/core/windowsConsoleHost.js';
import type { ConsoleHostProcess, QueuedConsoleHost } from '../../src/core/windowsConsoleHost.js';

const host = (pid: number, time: number): ConsoleHostProcess => ({
  pid, parentPid: 4000, name: 'conhost.exe', creationTime: time,
});
const item = (id: string, time: number, log: QueuedConsoleHost['log']): QueuedConsoleHost => ({
  id, window: { t0: time, t1: time + 2 }, log,
});

describe('bounded console host attribution', () => {
  it('logs a missing host at info level and resolves without retrying', async () => {
    const entries: { level: string; message: string; reason: unknown }[] = [];
    const resolved: string[] = [];
    let lists = 0;
    const queue = createConsoleHostQueue({
      parentPid: 4000, coalesceMs: 1,
      list: () => { lists += 1; return Promise.resolve([]); },
      endProcess: () => { throw new Error('no host to end'); },
      resolved: (id) => { resolved.push(id); },
    });
    const gone = item('gone', 1000, (level, message, meta) => {
      entries.push({ level, message, reason: meta['reason'] });
    });
    const outcomes: boolean[] = [];
    gone.onSettled = (ended) => { outcomes.push(ended); };
    queue.push(gone);
    await queue.whenSettled();
    expect(entries).toEqual([{
      level: 'info', message: 'console host not ended',
      reason: 'no console host was found in the session window',
    }]);
    expect(lists).toBe(1);
    expect(resolved).toEqual(['gone']);
    expect(outcomes).toEqual([true]);
  });

  it('leaves and logs candidates beyond the work cap', async () => {
    const ended: number[] = [];
    const warnings: string[] = [];
    let calls = 0;
    const queue = createConsoleHostQueue({
      parentPid: 4000, coalesceMs: 1,
      list: () => {
        calls += 1;
        return Promise.resolve(Array.from({ length: 65 }, (_, i) => host(i + 1, 1001)));
      },
      endProcess: (pid) => { ended.push(pid); },
    });
    for (let i = 0; i < 65; i += 1) {
      queue.push(item(String(i), 1000, (_level, message, meta) => {
        if (message === 'console host not ended') warnings.push(String(meta['reason']));
      }));
    }
    await queue.whenSettled();
    expect(ended).toEqual([]);
    expect(calls).toBe(3);
    expect(warnings).toContain('candidate cap exceeded');
  });

  it('retries a failed list and then ends the host', async () => {
    let calls = 0;
    const ended: number[] = [];
    const queue = createConsoleHostQueue({
      parentPid: 4000, coalesceMs: 1,
      list: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('failed')) : Promise.resolve([host(1, 1001)]);
      },
      endProcess: (pid) => { ended.push(pid); },
    });
    queue.push(item('a', 1000, () => undefined));
    await queue.whenSettled();
    expect(calls).toBeGreaterThan(1);
    expect(ended).toEqual([1]);
  });

  it('drops an ambiguous item after bounded retries', async () => {
    const resolved: string[] = [];
    let calls = 0;
    const queue = createConsoleHostQueue({
      parentPid: 4000, coalesceMs: 1,
      list: () => { calls += 1; return Promise.resolve([host(1, 1001), host(2, 1001)]); },
      endProcess: () => { throw new Error('unexpected end'); },
      resolved: (id) => { resolved.push(id); },
    });
    const ambiguous = item('a', 1000, () => undefined);
    const outcomes: boolean[] = [];
    ambiguous.onSettled = (ended) => { outcomes.push(ended); };
    queue.push(ambiguous);
    await queue.whenSettled();
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
    expect(resolved).toEqual(['a']);
    expect(outcomes).toEqual([false]);
  });
});
