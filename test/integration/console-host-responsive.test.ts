/**
 * Ending a console host runs PowerShell, which can take seconds just to
 * start. That work must not run on the daemon's thread: while a slow end is
 * in progress the daemon keeps answering `/health`. A stand-in holds the end
 * for 2.5 s. The same test fails when the end is `execFileSync`, because the
 * hold then blocks every request.
 */

import { describe, expect, it, vi } from 'vitest';
import { queueConsoleHostEnd } from '../../src/core/windowsConsoleHost.js';
import { startTestDaemon } from './helpers.js';

const HOLD_MS = 2_500;

const observed = vi.hoisted(() => ({
  startedAt: 0,
  finishedAt: 0,
  syncHolds: 0,
  asyncHolds: 0,
  edge: 1_700_000_000_000,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const isUnknownList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
  const scriptFrom = (args: unknown): string => {
    if (!isUnknownList(args)) return '';
    const index = args.indexOf('-Command');
    const script = index >= 0 ? args[index + 1] : undefined;
    return typeof script === 'string' ? script : '';
  };
  const isEnd = (file: unknown, args: unknown): boolean =>
    file === 'powershell.exe' && scriptFrom(args).includes('$proc.Kill()');
  const isList = (file: unknown, args: unknown): boolean =>
    file === 'powershell.exe' && scriptFrom(args).includes('Get-CimInstance');
  const hold = new Int32Array(new SharedArrayBuffer(4));
  return {
    ...actual,
    execFileSync: ((file: string, args?: ReadonlyArray<string>, options?: unknown) => {
      if (isEnd(file, args)) {
        observed.syncHolds += 1;
        observed.startedAt = Date.now();
        Atomics.wait(hold, 0, 0, HOLD_MS);
        observed.finishedAt = Date.now();
        throw Object.assign(new Error('Command failed'), { status: 3 });
      }
      return actual.execFileSync(
        file,
        args,
        options as Parameters<typeof actual.execFileSync>[2],
      );
    }) as typeof actual.execFileSync,
    execFile: ((
      file: string,
      args?: ReadonlyArray<string>,
      options?: unknown,
      callback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const cb = typeof options === 'function' ? options as typeof callback : callback;
      const opts = typeof options === 'function' ? undefined : options;
      if (isList(file, args)) {
        cb?.(null, `70 ${String(process.pid)} conhost.exe ${String(observed.edge)}\n`, '');
        return { unref(): void {} };
      }
      if (isEnd(file, args)) {
        observed.asyncHolds += 1;
        observed.startedAt = Date.now();
        setTimeout(() => {
          observed.finishedAt = Date.now();
          cb?.(null, '70 3\n', '');
        }, HOLD_MS);
        return { unref(): void {} };
      }
      return actual.execFile(
        file,
        args,
        opts as Parameters<typeof actual.execFile>[2],
        cb as Parameters<typeof actual.execFile>[3],
      );
    }) as typeof actual.execFile,
  };
});

describe.skipIf(process.platform !== 'win32')('console host end stays off the daemon thread', () => {
  it('answers /health while a slow end is in progress', async () => {
    const td = await startTestDaemon();
    const marks: number[] = [];
    let stop = false;
    const polling = (async () => {
      while (!stop) {
        const response = await fetch(`http://127.0.0.1:${String(td.port)}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        expect(response.ok).toBe(true);
        marks.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    try {
      const started = Date.now();
      while (marks.length === 0 && Date.now() - started < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(marks.length).toBeGreaterThan(0);

      queueConsoleHostEnd({
        id: 'slow-end',
        window: { t0: observed.edge - 50, t1: observed.edge },
        log: () => undefined,
      });
      // Coalesce is 300 ms, then the stand-in holds the end for HOLD_MS.
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS + 1_500));

      expect(observed.finishedAt).toBeGreaterThan(observed.startedAt);
      expect(observed.finishedAt - observed.startedAt).toBeGreaterThanOrEqual(HOLD_MS - 200);
      const during = marks.filter((at) => at > observed.startedAt && at < observed.finishedAt);
      expect(during).not.toEqual([]);
      const gaps = marks.slice(1).map((at, index) => at - marks[index]!);
      expect(Math.max(...gaps)).toBeLessThan(1_500);
      // The blocking child must not have been the call that ran.
      expect(observed.syncHolds).toBe(0);
      expect(observed.asyncHolds).toBe(1);
    } finally {
      stop = true;
      await polling.catch(() => undefined);
      await td.stop();
    }
  }, 30_000);
});
