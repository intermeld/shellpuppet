/**
 * Windows console hosts that node-pty 1.1.0 leaves behind.
 *
 * ConPTY creates the host while `spawn` runs, and that call returns only
 * after the host exists. The session stores the time immediately before and
 * after it. Nothing is listed then, and a start does not wait.
 *
 * After the session ends, it is queued. One short-lived PowerShell runs
 * `Get-CimInstance` for every session queued within a few hundred
 * milliseconds and asks for the daemon's children. The host that is ended is
 * the one `conhost.exe` or `OpenConsole.exe` whose parent is the daemon and
 * whose creation time falls in that window, widened by a few milliseconds.
 * Zero or several, or a list that fails or times out, ends nothing, and the
 * reason is logged once.
 *
 * The list is not on any path a caller waits on. It compiles nothing: no
 * `Add-Type`, no P/Invoke. `TRACK_WINDOWS_CONSOLE_HOST` is the switch, on
 * only for Windows. POSIX never queues.
 *
 * Ending the host reclaims the process. The daemon's own pseudoconsole
 * handle stays open until the daemon exits, and the host is given no
 * CTRL_CLOSE_EVENT.
 */

import { execFile } from 'node:child_process';

/** Windows only. Sessions queue a console host only when this is set. */
export const TRACK_WINDOWS_CONSOLE_HOST: boolean = process.platform === 'win32';

/**
 * How far outside the raw spawn window a creation time may still be that
 * session's host. Wider than this and a host from the next spawn can fall in.
 */
export const CONSOLE_HOST_WINDOW_TOLERANCE_MS = 5;

/** Sessions that end within this of each other share one process list. */
export const CONSOLE_HOST_COALESCE_MS = 300;

/**
 * How long one list may take. A CIM query of one parent's children takes
 * about ten seconds on this machine, cold or warm.
 */
export const CONSOLE_HOST_QUERY_TIMEOUT_MS = 45_000;

/** A console host as one list returned it. Creation time is Unix milliseconds. */
export interface ConsoleHostProcess {
  pid: number;
  parentPid: number;
  name: string;
  creationTime: number;
}

/** Times taken immediately before and after the synchronous spawn. */
export interface SpawnWindow {
  t0: number;
  t1: number;
}

export type ConsoleHostSelection =
  | { match: ConsoleHostProcess }
  | { match: null; reason: string };

/** What one ended session asks the shared list to do. */
export interface QueuedConsoleHost {
  id: string;
  window: SpawnWindow;
  log: (level: 'info' | 'warn', message: string, meta: Record<string, unknown>) => void;
}

export interface ConsoleHostQueue {
  push(item: QueuedConsoleHost): void;
  /** Resolves when every queued batch has listed and ended. */
  whenSettled(): Promise<void>;
}

const CONSOLE_HOST_NAMES = new Set(['conhost.exe', 'openconsole.exe']);

function isConsoleHostName(name: string): boolean {
  return CONSOLE_HOST_NAMES.has(name.toLowerCase());
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown failure';
}

/**
 * A list timed out when the child was killed or a signal was delivered.
 * The message text is not consulted: a failure that merely mentions a
 * timeout is still a failed list.
 */
function queryTimedOut(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('killed' in error && error.killed === true) return true;
  if ('signal' in error && typeof error.signal === 'string' && error.signal !== '') return true;
  if ('cause' in error && error.cause !== error) return queryTimedOut(error.cause);
  return false;
}

/** Why a list could not be used. A timeout is its own reason. */
export function queryFailureReason(error: unknown): string {
  if (queryTimedOut(error)) return 'console host query timed out';
  return `console host query failed: ${errorText(error)}`;
}

/**
 * The console host created during `window`, among `hosts`.
 * Anything other than exactly one host, with this parent and a console-host
 * name, is not ended.
 */
export function selectConsoleHost(
  window: SpawnWindow,
  hosts: readonly ConsoleHostProcess[],
  parentPid: number,
  toleranceMs = CONSOLE_HOST_WINDOW_TOLERANCE_MS,
): ConsoleHostSelection {
  const from = window.t0 - toleranceMs;
  const to = window.t1 + toleranceMs;
  const candidates = hosts.filter(
    (host) =>
      host.parentPid === parentPid &&
      isConsoleHostName(host.name) &&
      host.creationTime >= from &&
      host.creationTime <= to,
  );
  if (candidates.length === 1) {
    const match = candidates[0];
    if (match !== undefined) return { match };
  }
  if (candidates.length === 0) {
    return { match: null, reason: 'no console host was created in the session window' };
  }
  return {
    match: null,
    reason: `${String(candidates.length)} console hosts were created in the session window`,
  };
}

export interface ConsoleHostQueueOptions {
  parentPid: number;
  list: (parentPid: number) => Promise<readonly ConsoleHostProcess[]>;
  endProcess: (pid: number) => void;
  coalesceMs?: number;
  toleranceMs?: number;
}

/**
 * Queue ended sessions and list once for each batch. `endProcess` is called
 * with a pid only after `selectConsoleHost` has chosen that one process.
 */
export function createConsoleHostQueue(options: ConsoleHostQueueOptions): ConsoleHostQueue {
  const coalesceMs = options.coalesceMs ?? CONSOLE_HOST_COALESCE_MS;
  const toleranceMs = options.toleranceMs ?? CONSOLE_HOST_WINDOW_TOLERANCE_MS;
  const pending: QueuedConsoleHost[] = [];
  const waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const idle = (): boolean => timer === null && !running && pending.length === 0;

  const notify = (): void => {
    if (!idle()) return;
    const ready = waiters.splice(0);
    for (const resolve of ready) resolve();
  };

  const run = (batch: readonly QueuedConsoleHost[]): void => {
    running = true;
    void options.list(options.parentPid).then(
      (hosts) => {
        const ended = new Set<number>();
        for (const item of batch) {
          const selected = selectConsoleHost(item.window, hosts, options.parentPid, toleranceMs);
          if (selected.match === null) {
            item.log('warn', 'console host not ended', { id: item.id, reason: selected.reason });
            continue;
          }
          const pid = selected.match.pid;
          if (ended.has(pid)) continue;
          ended.add(pid);
          try {
            options.endProcess(pid);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ESRCH') continue;
            item.log('warn', 'console host not ended', {
              id: item.id,
              pid,
              reason: `console host could not be ended: ${errorText(error)}`,
            });
            continue;
          }
          item.log('info', 'console host ended', { id: item.id, pid });
        }
      },
      (error: unknown) => {
        const reason = queryFailureReason(error);
        for (const item of batch) {
          item.log('warn', 'console host not ended', { id: item.id, reason });
        }
      },
    ).finally(() => {
      running = false;
      notify();
    });
  };

  return {
    push(item: QueuedConsoleHost): void {
      pending.push(item);
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const batch = pending.splice(0);
        if (batch.length > 0) run(batch);
        else notify();
      }, coalesceMs);
      timer.unref();
    },
    whenSettled(): Promise<void> {
      if (idle()) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function parseHostLines(stdout: string): ConsoleHostProcess[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.map((line) => {
    const parts = line.split(' ');
    if (parts.length !== 4) {
      throw new Error('console host query failed: a process line was incomplete');
    }
    const pid = Number(parts[0]);
    const parentPid = Number(parts[1]);
    const name = parts[2] ?? '';
    const creationTime = Number(parts[3]);
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(parentPid) ||
      name === '' ||
      !Number.isInteger(creationTime)
    ) {
      throw new Error('console host query failed: a process line was incomplete');
    }
    return { pid, parentPid, name, creationTime };
  });
}

/** One CIM query: console hosts whose parent is `parentPid`. No compiled code. */
export function listConsoleHosts(
  parentPid: number,
  timeoutMs = CONSOLE_HOST_QUERY_TIMEOUT_MS,
): Promise<ConsoleHostProcess[]> {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return Promise.reject(new Error('console host query failed: parent pid is not a process id'));
  }
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(parentPid)}" |`,
    "Where-Object { $_.Name -eq 'conhost.exe' -or $_.Name -eq 'OpenConsole.exe' } |",
    'ForEach-Object {',
    '  $unix = [DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()',
    "  '{0} {1} {2} {3}' -f [int]$_.ProcessId, [int]$_.ParentProcessId, $_.Name, $unix",
    '}',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(errorText(error), { cause: error }));
          return;
        }
        try {
          resolve(parseHostLines(stdout));
        } catch (parseError) {
          reject(parseError instanceof Error ? parseError : new Error('console host query failed'));
        }
      },
    );
    child.unref();
  });
}

function terminateProcess(pid: number): void {
  process.kill(pid);
}

let daemonQueue: ConsoleHostQueue | null = null;

/**
 * Resolves when the daemon's queue has finished the batches already pushed.
 * Nothing is listed at the call. Tests wait here instead of polling; the
 * daemon does not.
 */
export function whenConsoleHostBatchSettled(): Promise<void> {
  if (daemonQueue === null) return Promise.resolve();
  return daemonQueue.whenSettled();
}

/** Queue one ended session. The list runs later, off the caller's stack. */
export function queueConsoleHostEnd(item: QueuedConsoleHost): void {
  if (!TRACK_WINDOWS_CONSOLE_HOST) return;
  daemonQueue ??= createConsoleHostQueue({
    parentPid: process.pid,
    list: (parentPid) => listConsoleHosts(parentPid),
    endProcess: terminateProcess,
  });
  daemonQueue.push(item);
}
