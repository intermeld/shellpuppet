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
 * whose creation time falls in that exact window. Candidates are assigned
 * across the batch and other known session windows before any host is ended.
 * A host near another known window outside the batch is protected by a
 * 16 ms guard. Ambiguous and failed items are retried up to three times;
 * a work cap or exhausted retry budget leaves the host running and logs why.
 *
 * The list is not on any path a caller waits on. It compiles nothing: no
 * `Add-Type`, no P/Invoke. Production tracking is on only for Windows.
 * POSIX never queues.
 *
 * Ending the host reclaims the process. The daemon's own pseudoconsole
 * handle stays open until the daemon exits, and the host is given no
 * CTRL_CLOSE_EVENT.
 */

import { execFile } from 'node:child_process';

/** Windows only. Sessions queue a console host only when this is set. */
export const TRACK_WINDOWS_CONSOLE_HOST: boolean = process.platform === 'win32';

/** Sessions that end within this of each other share one process list. */
export const CONSOLE_HOST_COALESCE_MS = 300;

/**
 * How long one list may take. A CIM query of one parent's children takes
 * about ten seconds on this machine, cold or warm.
 */
export const CONSOLE_HOST_QUERY_TIMEOUT_MS = 45_000;

/** A Windows clock tick can be 15.625 ms; protect neighbouring live windows. */
export const CONSOLE_HOST_GUARD_MS = 16;
/** Limits synchronous matching even when a daemon has many sessions. */
export const CONSOLE_HOST_MAX_CANDIDATES = 1024;
export const CONSOLE_HOST_MAX_WINDOWS = 256;
export const CONSOLE_HOST_MAX_ATTEMPTS = 3;

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

export interface KnownConsoleHostWindow {
  id: string;
  window: SpawnWindow;
}

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

function matchingHosts(
  window: SpawnWindow,
  hosts: readonly ConsoleHostProcess[],
  parentPid: number,
): ConsoleHostProcess[] {
  return hosts.filter(
    (host) =>
      host.parentPid === parentPid &&
      isConsoleHostName(host.name) &&
      host.creationTime >= window.t0 &&
      host.creationTime <= window.t1,
  );
}

function unmatchedReason(count: number): string {
  if (count === 0) return 'no console host was created in the session window';
  if (count === 1) return 'console host belongs to more than one session window';
  return `${String(count)} console hosts were created in the session window`;
}

export interface ConsoleHostQueueOptions {
  parentPid: number;
  list: (parentPid: number) => Promise<readonly ConsoleHostProcess[]>;
  endProcess: (pid: number) => void;
  coalesceMs?: number;
  /** Includes live sessions and ended sessions awaiting a retry. */
  knownWindows?: () => readonly KnownConsoleHostWindow[];
  /** Called when an ended session is finished, including a bounded leak. */
  resolved?: (id: string) => void;
}

interface HostAssignment {
  id: string;
  candidates: ConsoleHostProcess[];
  match: ConsoleHostProcess | null;
}

/** Find a one-to-one assignment, optionally excluding one proposed pair. */
function matchWindows(
  windows: readonly HostAssignment[],
  excluded?: { id: string; pid: number },
): Map<string, number> {
  const owner = new Map<number, HostAssignment>();
  const visit = (window: HostAssignment, seen: Set<number>): boolean => {
    for (const host of window.candidates) {
      if (excluded?.id === window.id && excluded.pid === host.pid) continue;
      if (seen.has(host.pid)) continue;
      seen.add(host.pid);
      const previous = owner.get(host.pid);
      if (previous === undefined || visit(previous, seen)) {
        owner.set(host.pid, window);
        return true;
      }
    }
    return false;
  };
  for (const window of windows) {
    visit(window, new Set());
  }
  return new Map([...owner].map(([pid, window]) => [window.id, pid]));
}

/** Claim only pairs present in every largest one-to-one assignment. */
function assignUnambiguousHosts(assignments: HostAssignment[]): void {
  const candidates = assignments.filter((assignment) => assignment.candidates.length > 0);
  const matching = matchWindows(candidates);
  for (const assignment of candidates) {
    const pid = matching.get(assignment.id);
    if (pid === undefined || matchWindows(candidates, { id: assignment.id, pid }).size === matching.size) continue;
    assignment.match = assignment.candidates.find((host) => host.pid === pid) ?? null;
  }
}

/**
 * Queue ended sessions and list once for each batch. `endProcess` is called
 * with a pid only after one-to-one attribution has chosen that process.
 */
export function createConsoleHostQueue(options: ConsoleHostQueueOptions): ConsoleHostQueue {
  const coalesceMs = options.coalesceMs ?? CONSOLE_HOST_COALESCE_MS;
  const pending: QueuedConsoleHost[] = [];
  const attempts = new Map<string, number>();
  const waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = 0;

  const idle = (): boolean => timer === null && running === 0 && pending.length === 0;

  const notify = (): void => {
    if (!idle()) return;
    const ready = waiters.splice(0);
    for (const resolve of ready) resolve();
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const batch = pending.splice(0);
      if (batch.length > 0) run(batch);
      else notify();
    }, coalesceMs);
    timer.unref();
  };

  const finish = (id: string): void => {
    attempts.delete(id);
    options.resolved?.(id);
  };

  const retry = (item: QueuedConsoleHost): void => {
    const count = (attempts.get(item.id) ?? 0) + 1;
    if (count >= CONSOLE_HOST_MAX_ATTEMPTS) {
      item.log('warn', 'console host not ended', { id: item.id, reason: 'retry limit reached' });
      finish(item.id);
      return;
    }
    attempts.set(item.id, count);
    pending.push(item);
    schedule();
  };

  const run = (batch: readonly QueuedConsoleHost[]): void => {
    running += 1;
    void options.list(options.parentPid).then(
      (hosts) => {
        const batchIds = new Set(batch.map((item) => item.id));
        const others = (options.knownWindows?.() ?? []).filter((known) => !batchIds.has(known.id));
        const windows = [...batch, ...others];
        if (windows.length > CONSOLE_HOST_MAX_WINDOWS) {
          for (const item of batch) {
            item.log('warn', 'console host not ended', { id: item.id, reason: 'window cap exceeded' });
            retry(item);
          }
          return;
        }
        const assignments: HostAssignment[] = windows.map((known) => ({
          id: known.id,
          candidates: matchingHosts(known.window, hosts, options.parentPid),
          match: null,
        }));
        const candidateCount = assignments.reduce((count, assignment) => count + assignment.candidates.length, 0);
        if (candidateCount > CONSOLE_HOST_MAX_CANDIDATES) {
          for (const item of batch) {
            item.log('warn', 'console host not ended', { id: item.id, reason: 'candidate cap exceeded' });
            retry(item);
          }
          return;
        }
        assignUnambiguousHosts(assignments);
        for (const item of batch) {
          const assignment = assignments.find((entry) => entry.id === item.id);
          if (assignment === undefined || assignment.match === null) {
            const reason = unmatchedReason(assignment?.candidates.length ?? 0);
            item.log('warn', 'console host not ended', { id: item.id, reason });
            if (assignment?.candidates.length === 0) finish(item.id);
            else retry(item);
            continue;
          }
          const pid = assignment.match.pid;
          if (others.some((known) =>
            assignment.match !== null &&
            assignment.match.creationTime >= known.window.t0 - CONSOLE_HOST_GUARD_MS &&
            assignment.match.creationTime <= known.window.t1 + CONSOLE_HOST_GUARD_MS)) {
            item.log('warn', 'console host not ended', { id: item.id, pid, reason: 'host near another session window' });
            retry(item);
            continue;
          }
          try {
            options.endProcess(pid);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ESRCH') {
              finish(item.id);
              continue;
            }
            item.log('warn', 'console host not ended', {
              id: item.id,
              pid,
              reason: `console host could not be ended: ${errorText(error)}`,
            });
            retry(item);
            continue;
          }
          finish(item.id);
          item.log('info', 'console host ended', { id: item.id, pid });
        }
      },
      (error: unknown) => {
        const reason = queryFailureReason(error);
        for (const item of batch) {
          item.log('warn', 'console host not ended', { id: item.id, reason });
          retry(item);
        }
      },
    ).finally(() => {
      running -= 1;
      notify();
    });
  };

  return {
    push(item: QueuedConsoleHost): void {
      pending.push(item);
      schedule();
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
const knownConsoleHostWindows = new Map<string, SpawnWindow>();

/** Keep live and unresolved windows available while another batch lists. */
export function registerConsoleHostWindow(id: string, window: SpawnWindow, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') knownConsoleHostWindows.set(id, window);
}

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
    knownWindows: () => [...knownConsoleHostWindows].map(([id, window]) => ({ id, window })),
    resolved: (id) => { knownConsoleHostWindows.delete(id); },
  });
  daemonQueue.push(item);
}
