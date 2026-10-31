/**
 * On Windows a session's console host is a child of the daemon, and node-pty
 * 1.1.0 leaves it running after the session ends. These tests start sessions
 * on a daemon of their own. Each end waits until the daemon's queue has
 * listed and ended the host, then a process snapshot confirms it.
 *
 * A CIM query of one parent's children takes about fourteen seconds here, so
 * the file does not poll and does not run a second query to confirm. The
 * queue's own list is that query. After it finishes, a process snapshot
 * confirms the host. The snapshot is a toolhelp list in one PowerShell
 * process, compiled once. The kill test leaves the surviving session up so
 * the stop test ends it together with its own session, in one list.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whenConsoleHostBatchSettled } from '../../src/core/windowsConsoleHost.js';
import { api, eventually, makeTempHome, processAlive, removeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

interface HostProcess {
  pid: number;
  /** Unix milliseconds. */
  creationTime: number;
}

const SNAPSHOT_END = 'SHELLPUPPET-SNAPSHOT-END';

const snapshotScript = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ShellPuppetProcessSnapshot {
  const uint TH32CS_SNAPPROCESS = 2;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  public static string List(uint parentPid) {
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      StringBuilder rows = new StringBuilder();
      PROCESSENTRY32 entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(entry);
      bool more = Process32First(snap, ref entry);
      while (more) {
        string name = entry.szExeFile ?? "";
        if (entry.th32ParentProcessID == parentPid && (name.Equals("conhost.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("OpenConsole.exe", StringComparison.OrdinalIgnoreCase))) {
          long unix = -1;
          IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID);
          if (handle != IntPtr.Zero) {
            long creation, exit, kernel, user;
            if (GetProcessTimes(handle, out creation, out exit, out kernel, out user)) unix = (creation - 116444736000000000L) / 10000L;
            CloseHandle(handle);
          }
          rows.Append(entry.th32ProcessID).Append(' ').Append(name).Append(' ').Append(unix).Append((char)10);
        }
        entry.dwSize = (uint)Marshal.SizeOf(entry);
        more = Process32Next(snap, ref entry);
      }
      return rows.ToString();
    } finally { CloseHandle(snap); }
  }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  $text = [ShellPuppetProcessSnapshot]::List([uint32]$line)
  [Console]::Out.Write($text)
  [Console]::Out.WriteLine('${SNAPSHOT_END}')
  [Console]::Out.Flush()
}
`;

let helper: ChildProcessWithoutNullStreams | undefined;
let helperPid: number | undefined;
let snapshotBuffer = '';
let snapshotError = '';
const snapshotWaiters: Array<(body: string) => void> = [];

function takeSnapshotOutput(chunk: string): void {
  snapshotBuffer += chunk;
  for (;;) {
    const end = snapshotBuffer.indexOf(SNAPSHOT_END);
    if (end === -1) return;
    const lineEnd = snapshotBuffer.indexOf('\n', end);
    if (lineEnd === -1) return;
    const body = snapshotBuffer.slice(0, end);
    snapshotBuffer = snapshotBuffer.slice(lineEnd + 1);
    const waiter = snapshotWaiters.shift();
    if (waiter !== undefined) waiter(body);
  }
}

function parseSnapshot(body: string): HostProcess[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+ /.test(line))
    .map((line) => {
      const parts = line.split(' ');
      const pid = Number(parts[0]);
      const creationTime = Number(parts[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(creationTime) || creationTime < 0) {
        throw new Error(`process snapshot line was incomplete: ${line}`);
      }
      return { pid, creationTime };
    });
}

/** Console hosts whose parent is this process. The helper is started in `beforeAll`. */
function snapshot(): Promise<HostProcess[]> {
  const child = helper;
  if (child === undefined) return Promise.reject(new Error('process snapshot helper is not running'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process snapshot timed out: ${snapshotError}`));
    }, 30_000);
    snapshotWaiters.push((body) => {
      clearTimeout(timer);
      try {
        resolve(parseSnapshot(body));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('process snapshot failed'));
      }
    });
    child.stdin.write(`${String(process.pid)}\n`);
  });
}

function startSnapshotHelper(): void {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', snapshotScript], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  helper = child;
  helperPid = child.pid;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', takeSnapshotOutput);
  child.stderr.on('data', (chunk: string) => {
    snapshotError += chunk;
  });
}

function stopSnapshotHelper(): void {
  const pid = helperPid;
  helperPid = undefined;
  helper = undefined;
  if (pid === undefined) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

function hostKey(host: HostProcess): string {
  return `${String(host.pid)} ${String(host.creationTime)}`;
}

function sameHosts(left: readonly HostProcess[], right: readonly HostProcess[]): boolean {
  return left.map(hostKey).sort().join('\n') === right.map(hostKey).sort().join('\n');
}

function addedHosts(current: readonly HostProcess[], baseline: readonly HostProcess[]): HostProcess[] {
  const known = new Set(baseline.map(hostKey));
  return current
    .filter((host) => !known.has(hostKey(host)))
    .sort((left, right) => left.creationTime - right.creationTime);
}

const shell = (): string => process.env['ComSpec'] ?? 'cmd.exe';

async function startSession(daemon: TestDaemon, body: Record<string, unknown>): Promise<string> {
  const started = await api(daemon.port, daemon.token, '/sessions', { body });
  expect(started.status).toBe(200);
  const id = started.body['id'];
  expect(typeof id).toBe('string');
  return id as string;
}

async function waitUntilExited(daemon: TestDaemon, ids: readonly string[]): Promise<void> {
  await eventually(async () => {
    const listed = await api(daemon.port, daemon.token, '/sessions');
    const sessions = listed.body['sessions'] as { id: string; exited: boolean }[];
    return ids.every((id) => sessions.some((session) => session.id === id && session.exited));
  }, 20_000);
}

async function expectHostGone(pid: number): Promise<void> {
  await eventually(() => !processAlive(pid), 2_000);
}

describe.skipIf(process.platform !== 'win32')('Windows console hosts of a test daemon', () => {
  const homes: string[] = [];
  let baseline: HostProcess[] = [];
  /** The kill test's daemon and the host it must leave alive, for the stop test. */
  let carried: { daemon: TestDaemon; survivorPid: number } | undefined;

  beforeAll(async () => {
    startSnapshotHelper();
    baseline = await snapshot();
  });

  afterAll(() => {
    stopSnapshotHelper();
    for (const home of homes) removeTempHome(home);
  });

  async function daemon(): Promise<TestDaemon> {
    const started = await startTestDaemon({ home: makeTempHome('shellpuppet-conhost-') });
    homes.push(started.home);
    return started;
  }

  async function stop(started: TestDaemon | undefined): Promise<void> {
    if (started === undefined) return;
    try {
      await started.daemon.stop();
    } catch {
      // Already stopped.
    }
    removeTempHome(started.home);
  }

  async function endStrays(): Promise<void> {
    const left = await snapshot().catch(() => [] as HostProcess[]);
    const known = new Set(baseline.map((host) => host.pid));
    for (const host of left) {
      if (known.has(host.pid)) continue;
      try {
        process.kill(host.pid);
      } catch {
        // Already gone.
      }
    }
  }

  it('returns the console-host count to its starting value after a program exits on its own', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    try {
      started = await daemon();
      const id = await startSession(started, {
        command: shell(),
        args: ['/d', '/c', 'exit'],
        shell: false,
        openViewer: false,
      });
      await waitUntilExited(started, [id]);
      // The list takes about ten seconds. A seam that resolved at the call
      // would still be inside this half-second, with the host still running.
      const waited = Date.now();
      await whenConsoleHostBatchSettled();
      expect(Date.now() - waited).toBeGreaterThan(500);
      await eventually(async () => sameHosts(await snapshot(), baseline), 5_000);
      passed = true;
    } finally {
      if (!passed) await endStrays();
      await stop(started);
    }
  }, 90_000);

  it('ends the killed session\'s console host and leaves the other session\'s host', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    try {
      started = await daemon();
      const command = { command: shell(), shell: false, openViewer: false };
      const first = await startSession(started, command);
      const second = await startSession(started, command);
      expect(second).not.toBe(first);
      const hosts = addedHosts(await snapshot(), baseline);
      expect(hosts, JSON.stringify(hosts)).toHaveLength(2);
      const earlier = hosts[0];
      const later = hosts[1];
      if (earlier === undefined || later === undefined) throw new Error('expected two console hosts');
      if (earlier.creationTime === later.creationTime) {
        throw new Error('the two console hosts have the same creation time');
      }
      const killed = await api(started.port, started.token, `/sessions/${first}`, { method: 'DELETE' });
      expect(killed.status).toBe(200);
      await whenConsoleHostBatchSettled();
      await expectHostGone(earlier.pid);
      expect(processAlive(later.pid)).toBe(true);
      carried = { daemon: started, survivorPid: later.pid };
      passed = true;
    } finally {
      if (!passed) {
        carried = undefined;
        await endStrays();
        await stop(started);
      }
    }
  }, 90_000);

  it('ends a live session\'s console host when the daemon stops', async () => {
    let started: TestDaemon | undefined;
    let passed = false;
    const survivorPid = carried?.survivorPid;
    try {
      started = carried?.daemon ?? (await daemon());
      carried = undefined;
      const before = await snapshot();
      await startSession(started, { command: shell(), shell: false, openViewer: false });
      const hosts = addedHosts(await snapshot(), before);
      expect(hosts, JSON.stringify(hosts)).toHaveLength(1);
      const host = hosts[0];
      if (host === undefined) throw new Error('expected one console host');
      await started.daemon.stop();
      await whenConsoleHostBatchSettled();
      await expectHostGone(host.pid);
      if (survivorPid !== undefined) await expectHostGone(survivorPid);
      await eventually(async () => sameHosts(await snapshot(), baseline), 5_000);
      passed = true;
    } finally {
      if (!passed) await endStrays();
      await stop(started);
      for (const home of homes) removeTempHome(home);
    }
  }, 90_000);
});
