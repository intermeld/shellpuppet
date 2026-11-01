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
 * Ending the host reclaims the process. Windows PowerShell 5.1's Get-Process
 * holds no handle, and Process.Kill opens its own by pid. The end reads the
 * process handle first, which opens and caches it; a failure to open is the
 * host gone. It then checks the name and the listed creation time, and kills
 * through that cached handle only when both match. The open handle keeps
 * Windows from reusing the pid until the script releases it. A call with no
 * creation time is refused before any process is opened. Every host in the
 * batch is ended by one PowerShell, started asynchronously, so the daemon
 * keeps answering while it runs. The queue settles only after that call
 * finishes. The daemon's own pseudoconsole handle stays open until the
 * daemon exits, and the host is given no CTRL_CLOSE_EVENT.
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
  /** Resolves when every queued batch has listed and its ends have finished. */
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

/** One attributed host handed to a batch end. `error === null` means it was ended. */
export interface ConsoleHostEndResult {
  pid: number;
  error: unknown;
}

export interface ConsoleHostQueueOptions {
  parentPid: number;
  list: (parentPid: number) => Promise<readonly ConsoleHostProcess[]>;
  /**
   * End one attributed host. May return a promise: the queue settles only
   * after it finishes. Not called when `endBatch` is set.
   */
  endProcess?: (pid: number, host?: ConsoleHostProcess) => void | Promise<void>;
  /**
   * End every host this batch attributed, in one call. The queue settles
   * only after the promise finishes. `ESRCH` finishes that item; any other
   * error retries it.
   */
  endBatch?: (
    items: readonly { pid: number; host: ConsoleHostProcess }[],
  ) => Promise<readonly ConsoleHostEndResult[]>;
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
 * Queue ended sessions and list once for each batch. A host is ended only
 * after one-to-one attribution has chosen that process. The queue settles
 * only once those ends have finished.
 */
export function createConsoleHostQueue(options: ConsoleHostQueueOptions): ConsoleHostQueue {
  if (options.endBatch === undefined && options.endProcess === undefined) {
    throw new Error('console host queue has no way to end a process');
  }
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

  const noteEndFailure = (item: QueuedConsoleHost, pid: number, error: unknown): void => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      finish(item.id);
      return;
    }
    item.log('warn', 'console host not ended', {
      id: item.id,
      pid,
      reason: `console host could not be ended: ${errorText(error)}`,
    });
    retry(item);
  };

  const noteEnded = (item: QueuedConsoleHost, pid: number): void => {
    finish(item.id);
    item.log('info', 'console host ended', { id: item.id, pid });
  };

  const endAll = async (
    items: readonly { item: QueuedConsoleHost; pid: number; match: ConsoleHostProcess }[],
  ): Promise<void> => {
    if (items.length === 0) return;
    if (options.endBatch) {
      let results: readonly ConsoleHostEndResult[];
      try {
        results = await options.endBatch(items.map(({ pid, match }) => ({ pid, host: match })));
      } catch (error) {
        for (const { item, pid } of items) noteEndFailure(item, pid, error);
        return;
      }
      const byPid = new Map(results.map((result) => [result.pid, result]));
      for (const { item, pid } of items) {
        const result = byPid.get(pid);
        if (result === undefined) {
          noteEndFailure(item, pid, new Error('console host end did not report a result'));
          continue;
        }
        if (result.error === null) noteEnded(item, pid);
        else noteEndFailure(item, pid, result.error);
      }
      return;
    }
    const endProcess = options.endProcess;
    if (endProcess === undefined) return;
    // Together, so one slow host does not hold the others behind it. The
    // queue still settles only once every one of them has finished.
    await Promise.all(items.map(async ({ item, pid, match }) => {
      try {
        await endProcess(pid, match);
      } catch (error) {
        noteEndFailure(item, pid, error);
        return;
      }
      noteEnded(item, pid);
    }));
  };

  const run = (batch: readonly QueuedConsoleHost[]): void => {
    running += 1;
    void options.list(options.parentPid).then(
      async (hosts) => {
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
        const toEnd: { item: QueuedConsoleHost; pid: number; match: ConsoleHostProcess }[] = [];
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
          toEnd.push({ item, pid, match: assignment.match });
        }
        // Settling waits for this. A promise returned by the end is part of
        // the batch, not work that happens after the queue has gone idle.
        await endAll(toEnd);
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

/** How close a process start time must be to the listed creation time. */
const HOST_IDENTITY_MS = 50;

/** One end for a batch. PowerShell can take seconds to start; do not block on it. */
const HOST_END_TIMEOUT_MS = 20_000;

function expectedCreationTime(pid: number, creationTime: number | undefined): number {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw Object.assign(new Error('console host pid is not a process id'), { code: 'ESRCH' });
  }
  // Name alone is not an identity. Callers have the time the list recorded.
  if (creationTime === undefined) {
    throw Object.assign(new Error('console host creation time is required'), { code: 'ESRCH' });
  }
  if (!Number.isInteger(creationTime)) {
    throw Object.assign(new Error('console host creation time is not a time'), { code: 'ESRCH' });
  }
  return creationTime;
}

/**
 * The check and the handle kill, once per host, in one process. `$PID` is
 * PowerShell's own process, so the target id has another name. Get-Process
 * holds no handle on Windows PowerShell 5.1: the handle is opened by reading
 * it, and Kill then uses that cached handle rather than opening another by
 * pid. A throw, or a handle that comes back empty, is the host gone (2), not
 * a retry. Stdout codes are
 * 0 ended, 2 gone, 3 not that host. A throw is 1, so one host's failure does
 * not skip the rest of the batch. The start time is always compared: there is
 * no sentinel that skips it.
 */
function endScript(targets: readonly { pid: number; expected: number }[]): string {
  const hosts = targets.map(({ pid, expected }) => [
    `$targetId = ${String(pid)}`,
    `$expected = ${String(expected)}`,
    'try {',
    '  $proc = Get-Process -Id $targetId -ErrorAction SilentlyContinue',
    '  if ($null -eq $proc) { Write-Output "$targetId 2" }',
    '  else {',
    '    $opened = $true',
    '    try {',
    '      $openedHandle = $proc.Handle',
    '      if ($null -eq $openedHandle -or $openedHandle -eq [IntPtr]::Zero) { $opened = $false }',
    '    } catch { $opened = $false }',
    '    if (-not $opened) { Write-Output "$targetId 2" }',
    '    else {',
    '      $image = $proc.ProcessName',
    '      $code = 0',
    "      if ($image -ne 'conhost' -and $image -ne 'OpenConsole') { $code = 3 }",
    '      else {',
    '        $start = [DateTimeOffset]::new($proc.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()',
    `        if ([Math]::Abs($start - $expected) -gt ${String(HOST_IDENTITY_MS)}) { $code = 3 }`,
    '      }',
    '      if ($code -eq 0) { $proc.Kill() }',
    '      Write-Output "$targetId $code"',
    '    }',
    '  }',
    '} catch {',
    "  $detail = ($_.Exception.Message -replace '\\s+', ' ').Trim()",
    '  Write-Output "$targetId 1 $detail"',
    '}',
  ].join('\n'));
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    ...hosts,
    'exit 0',
  ].join('\n');
}

interface ReportedEnd {
  status: number;
  message: string;
}

function parseEndReport(stdout: string): Map<number, ReportedEnd> {
  const reported = new Map<number, ReportedEnd>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+) (\d+)(?: (.*))?$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number(match[1]);
    const status = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(status)) continue;
    reported.set(pid, { status, message: match[3] ?? '' });
  }
  return reported;
}

function gone(): Error {
  return Object.assign(new Error('console host is gone'), { code: 'ESRCH' });
}

function failureCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return error.code;
}

function resultsFromReport(
  runnable: readonly { pid: number }[],
  stdout: string,
  fallback: unknown,
): ConsoleHostEndResult[] {
  const reported = parseEndReport(stdout);
  const fallbackCode = failureCode(fallback);
  return runnable.map(({ pid }) => {
    const line = reported.get(pid);
    if (line === undefined) {
      if (fallbackCode === 'ESRCH') return { pid, error: gone() };
      if (fallback instanceof Error) return { pid, error: fallback };
      return { pid, error: new Error('console host end did not report a result') };
    }
    if (line.status === 0) return { pid, error: null };
    // 2: the pid is gone. 3: it is no longer the listed host. Either way the
    // host we meant has gone, and the process that has the pid is not ours.
    if (line.status === 2 || line.status === 3) return { pid, error: gone() };
    const message = line.message.trim();
    return { pid, error: new Error(message === '' ? 'console host could not be ended' : message) };
  });
}

function runEndScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: HOST_END_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const text = typeof stdout === 'string' ? stdout : '';
        if (error) {
          // The script always exits 0. A host's own result is a stdout code,
          // so a non-zero status here is PowerShell failing, not "gone".
          const wrapped = error instanceof Error ? error : new Error(errorText(error), { cause: error });
          reject(Object.assign(wrapped, { stdout: text }));
          return;
        }
        resolve(text);
      },
    );
    child.unref();
  });
}

/**
 * End every listed host in one asynchronous PowerShell. Each pid was read
 * from a process list, so by the time this runs Windows may have given it to
 * another process. A bare `process.kill` would then reach that process,
 * including one on another console.
 */
export function endConsoleHostProcesses(
  targets: readonly { pid: number; creationTime?: number }[],
): Promise<readonly ConsoleHostEndResult[]> {
  const results: ConsoleHostEndResult[] = [];
  const runnable: { pid: number; expected: number }[] = [];
  for (const target of targets) {
    try {
      runnable.push({
        pid: target.pid,
        expected: expectedCreationTime(target.pid, target.creationTime),
      });
    } catch (error) {
      results.push({ pid: target.pid, error });
    }
  }
  if (runnable.length === 0) return Promise.resolve(results);
  return runEndScript(endScript(runnable)).then(
    (stdout) => results.concat(resultsFromReport(runnable, stdout, null)),
    (error: unknown) => {
      const stdout = (error as { stdout?: unknown }).stdout;
      const text = typeof stdout === 'string' ? stdout : '';
      return results.concat(resultsFromReport(runnable, text, error));
    },
  );
}

/**
 * End `pid` only when it is still the console host listed at `creationTime`.
 * The time is required: without it the call is refused and nothing is opened.
 * Reads that process's handle first, which opens and caches it, then checks
 * the name and the start time, and kills through the cached handle. A pid
 * reused after the open is not the one killed, and the open handle keeps
 * Windows from reusing the pid until it is closed. Rejects with `ESRCH` when
 * the pid is gone, the handle cannot be opened, or the process is no longer
 * that host, and the caller leaves that process running. The PowerShell is
 * asynchronous.
 */
export function endConsoleHostProcess(pid: number, creationTime?: number): Promise<void> {
  return endConsoleHostProcesses([{ pid, creationTime }]).then((ended) => {
    const result = ended.find((entry) => entry.pid === pid);
    if (result === undefined) throw gone();
    if (result.error === null) return;
    if (result.error instanceof Error) throw result.error;
    throw new Error(errorText(result.error));
  });
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
    endBatch: (items) => endConsoleHostProcesses(items.map((item) => ({
      pid: item.pid,
      creationTime: item.host.creationTime,
    }))),
    knownWindows: () => [...knownConsoleHostWindows].map(([id, window]) => ({ id, window })),
    resolved: (id) => { knownConsoleHostWindows.delete(id); },
  });
  daemonQueue.push(item);
}
