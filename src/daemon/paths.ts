/**
 * `~/.shellpuppet/` layout, permission hardening and the daemon state file
 * (design §2.2, §2.3, §4.1).
 *
 * Everything honours `SHELLPUPPET_HOME` so tests (and unusual setups) can
 * isolate themselves completely from the real per-user directory.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { envValue } from '../core/environment.js';

/** Restart evidence that may outlive the daemon that first verified it. */
export interface RestartHandoff {
  restartFrom?: string | null;
  /** This handoff supersedes an older independent source. */
  restartSourcePending?: boolean;
  /** Present while verification is pending. Lists possible writers, oldest first. */
  restartCandidates?: string[];
}

/** Daemon discovery record: written atomically, read by every client. */
export interface DaemonState extends RestartHandoff {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
  /** Random identity for this daemon process, independent of pid and wall time. */
  instanceId?: string;
  /** Set by the daemon entry from the client's internal start marker. */
  startedWrapped?: boolean;
}

export function shellpuppetHome(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, 'SHELLPUPPET_HOME') ?? path.join(os.homedir(), '.shellpuppet');
}

export function daemonStatePath(home: string): string {
  return path.join(home, 'daemon.json');
}

// Windows PowerShell ships with the .NET Framework ACL APIs. Paths are data
// in the environment, including homes containing quotes or wildcard characters.
const windowsAclScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
function Is-Private($acl, $flags) {
  $rules = @($acl.GetAccessRules($true, $true, $sid.GetType()))
  return ($acl.AreAccessRulesProtected -and $acl.GetOwner($sid.GetType()) -eq $sid -and
    $rules.Count -eq 1 -and !$rules[0].IsInherited -and $rules[0].IdentityReference -eq $sid -and
    $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl' -and
    [int]$rules[0].InheritanceFlags -eq $flags -and [int]$rules[0].PropagationFlags -eq 0)
}
function Protect-Item($item, $directory) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected reparse point' }
  $inherit = if ($directory) { 'OICI' } else { '' }
  $desired = 'D:P(A;' + $inherit + ';FA;;;' + $sid.Value + ')'
  $flags = if ($directory) { 3 } else { 0 }
  $acl = $item.GetAccessControl()
  $section = [Security.AccessControl.AccessControlSections]::Access
  if (!(Is-Private $acl $flags)) {
    $acl.SetSecurityDescriptorSddlForm($desired, $section)
    if ($acl.GetOwner($sid.GetType()) -ne $sid) { $acl.SetOwner($sid) }
    $item.SetAccessControl($acl)
    $acl = $item.GetAccessControl()
    if (!(Is-Private $acl $flags)) {
      throw 'Owner-only ACL verification failed'
    }
  }
}
$dir = [IO.DirectoryInfo]::new($env:SP_PRIVATE_HOME)
Protect-Item $dir $true
foreach ($name in ([string]$env:SP_PRIVATE_FILES).Split('|', [StringSplitOptions]::RemoveEmptyEntries)) {
  $item = [IO.FileInfo]::new([IO.Path]::Combine($dir.FullName, $name))
  if ($name -in 'audit.log','daemon.log' -and !$item.Exists) {
    $item.Open([IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite).Dispose()
    $item.Refresh()
  }
  if ($item.Exists) { Protect-Item $item $false }
}
[Console]::Write($sid.Value + '|' + $identity.Owner.Value)
`;

interface WindowsHome {
  path: string;
  sid: string;
  setFileOwner: boolean;
}

let privateWindowsHome: WindowsHome | undefined;

function systemTool(...parts: string[]): string {
  return path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', ...parts);
}

function secureWindowsHome(home: string): WindowsHome {
  const powershell = systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe');
  const files = ['daemon.json', 'launcher-claims.json', 'previous-sessions.json', 'restart-source.json', 'config.json', 'daemon.log', 'audit.log'];
  try {
    const identity = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(windowsAclScript, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: 'pipe', timeout: 15_000, encoding: 'utf8',
      env: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', SP_PRIVATE_HOME: path.resolve(home),
        SP_PRIVATE_FILES: files.join('|') },
    }).trim();
    const [sid, owner] = identity.split('|');
    if (!sid || !owner || !/^S-1-[0-9-]+$/.test(sid)) throw new Error('Missing Windows identity.');
    return { path: path.resolve(home), sid, setFileOwner: owner !== sid };
  } catch {
    throw new Error('Could not verify owner-only Windows permissions in the ShellPuppet home.');
  }
}

/** Prepare and write the private inode before linking or renaming it into place. */
function withPrivateTemp(target: string, contents: string, publish: (temporary: string) => void): void {
  const temporary = target + '.' + randomUUID() + '.tmp';
  if (process.platform === 'win32') {
    const home = fs.realpathSync.native(path.dirname(target));
    if (privateWindowsHome?.path !== home) privateWindowsHome = secureWindowsHome(home);
  }
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      if (process.platform === 'win32') {
        // The new empty file inherits only the verified home ACL. Replace
        // inheritance with an explicit grant before writing the first byte.
        const security = privateWindowsHome!;
        const icacls = systemTool('icacls.exe');
        const options = { windowsHide: true, stdio: 'pipe' as const, timeout: 15_000 };
        execFileSync(icacls, [temporary, '/inheritance:r', '/grant:r', '*' + security.sid + ':F', '/L', '/Q'], options);
        // An elevated token can create files owned by its Administrators group.
        if (security.setFileOwner) execFileSync(icacls, [temporary, '/setowner', '*' + security.sid, '/L', '/Q'], options);
      }
      fs.writeFileSync(fd, contents);
    } finally { fs.closeSync(fd); }
    publish(temporary);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function writePrivateRecord(target: string, value: unknown, beforePublish?: () => void): void {
  withPrivateTemp(target, JSON.stringify(value), temporary => {
    beforePublish?.();
    fs.renameSync(temporary, target);
  });
}

export function daemonLogPath(home: string): string {
  return path.join(home, 'daemon.log');
}

export function configPath(home: string): string {
  return path.join(home, 'config.json');
}

/** Repair existing homes too, before reading a credential or publishing one. */
export function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    privateWindowsHome = secureWindowsHome(fs.realpathSync.native(home));
  } else {
    fs.chmodSync(home, 0o700);
  }
}

/**
 * The state file can hold a live discovery record, a credential-free restart
 * handoff for the next owner, or content that is neither (an
 * emptied, truncated or hand-edited file), kept so that only that same content
 * is ever removed; nothing; or a read that failed, which says nothing about
 * the content and so is left alone.
 */
export type DaemonStateFile =
  | { kind: 'record'; state: DaemonState }
  | { kind: 'restart-handoff'; handoff: RestartHandoff }
  | { kind: 'not-a-record'; raw: string }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

export function inspectDaemonState(home: string): DaemonStateFile {
  let raw: string;
  try {
    raw = fs.readFileSync(daemonStatePath(home), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  return parseDaemonState(raw);
}

export function isDaemonInstanceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
}

export function restartSourceId(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'restartFrom' in value &&
    isDaemonInstanceId(value.restartFrom) ? value.restartFrom : null;
}

function parseDaemonState(raw: string): DaemonStateFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as DaemonState).port === 'number' &&
      typeof (parsed as DaemonState).token === 'string' &&
      typeof (parsed as DaemonState).pid === 'number'
    ) {
      return { kind: 'record', state: parsed as DaemonState };
    }
    const handoff = parsed as RestartHandoff | null;
    if (handoff && (restartSourceId(handoff) !== null || (handoff.restartFrom === null &&
        Array.isArray(handoff.restartCandidates) && handoff.restartCandidates.every(isDaemonInstanceId)))) {
      return { kind: 'restart-handoff', handoff };
    }
  } catch { /* Incomplete or hand-edited discovery record. */ }
  return { kind: 'not-a-record', raw };
}

export function readDaemonState(home: string): DaemonState | null {
  const file = inspectDaemonState(home);
  return file.kind === 'record' ? file.state : null;
}

export function removeDaemonState(home: string): void {
  try {
    fs.unlinkSync(daemonStatePath(home));
  } catch {
    // Already gone, which is fine.
  }
}

/**
 * Remove the state file only while it still names `record`'s daemon, so that
 * clearing a stale record cannot delete one that another daemon has just
 * claimed in its place.
 */
export function removeDaemonStateIf(home: string, record: { pid: number; port: number; instanceId?: string }): void {
  const current = readDaemonState(home);
  if (current !== null && current.pid === record.pid && current.port === record.port &&
      (record.instanceId === undefined || current.instanceId === record.instanceId)) {
    removeDaemonState(home);
  }
}

/**
 * Remove a state file that holds no daemon record, only while it still holds
 * exactly the content `raw` that was judged. A claim links a complete file
 * into place, so a record claimed in the meantime stays; a writer outside
 * ShellPuppet that rewrites the file in place can still lose its write.
 */
export function removeDaemonStateIfNotARecord(home: string, raw: string): void {
  const current = inspectDaemonState(home);
  if (current.kind === 'not-a-record' && current.raw === raw) {
    removeDaemonState(home);
  }
}

/**
 * Atomically CLAIM the state file (design §2.2's crash-safe startup, extended
 * for the auto-start race). Two daemons racing must not both believe they won:
 *
 * 1. content is written to a temp file in the same directory (never partial);
 * 2. `fs.link(temp, daemon.json)` publishes it: link() fails with EEXIST if
 *    the file exists, so exactly one racer succeeds. (A plain rename() would
 *    overwrite and let the LAST writer win while both think they did.)
 *
 * Returns false when a file is already there. The caller then judges what it
 * holds: it defers to a running daemon, or clears a record whose daemon has
 * gone, or a file that holds no record, and retries.
 */
export function claimDaemonState(home: string, state: DaemonState): boolean {
  const target = daemonStatePath(home);
  let claimed = false;
  withPrivateTemp(target, JSON.stringify(state, null, 2), temporary => {
    try {
      fs.linkSync(temporary, target);
      claimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  });
  return claimed;
}
