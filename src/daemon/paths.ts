/**
 * `~/.shellpuppet/` layout, permission hardening and the daemon state file
 * (design §2.2, §2.3, §4.1).
 *
 * Everything honours `SHELLPUPPET_HOME` so tests (and unusual setups) can
 * isolate themselves completely from the real per-user directory.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Daemon discovery record: written atomically, read by every client. */
export interface DaemonState {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export function shellpuppetHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['SHELLPUPPET_HOME'] ?? path.join(os.homedir(), '.shellpuppet');
}

export function daemonStatePath(home: string): string {
  return path.join(home, 'daemon.json');
}

export function daemonLogPath(home: string): string {
  return path.join(home, 'daemon.log');
}

export function configPath(home: string): string {
  return path.join(home, 'config.json');
}

/**
 * Create the home directory if absent and harden its permissions on first
 * creation (design §4.1). `fs.chmod` is a near-no-op on Windows, so there we
 * strip ACL inheritance and grant only the current user, with `(OI)(CI)` so
 * files created inside inherit the restriction. POSIX gets a real 0700.
 *
 * Hardening failures are reported, not fatal: a working daemon with a warning
 * beats a dead one, and the token file being unreadable to others is
 * defence-in-depth on top of loopback binding + bearer auth.
 */
export async function ensureHome(home: string): Promise<{ created: boolean; warning?: string }> {
  if (fs.existsSync(home)) return { created: false };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const user = process.env['USERNAME'];
    if (user === undefined || user === '') {
      return { created: true, warning: 'USERNAME not set: directory ACL not hardened' };
    }
    try {
      await execFileAsync(
        'icacls',
        [home, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`],
        { windowsHide: true },
      );
    } catch (error) {
      return { created: true, warning: `icacls hardening failed: ${String(error)}` };
    }
  } else {
    fs.chmodSync(home, 0o700);
  }
  return { created: true };
}

/**
 * What the state file holds: a daemon record; content that is not one (an
 * emptied, truncated or hand-edited file), kept so that only that same content
 * is ever removed; nothing; or a read that failed, which says nothing about
 * the content and so is left alone.
 */
export type DaemonStateFile =
  | { kind: 'record'; state: DaemonState }
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
  const state = parseDaemonState(raw);
  return state !== null ? { kind: 'record', state } : { kind: 'not-a-record', raw };
}

function parseDaemonState(raw: string): DaemonState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as DaemonState).port === 'number' &&
      typeof (parsed as DaemonState).token === 'string' &&
      typeof (parsed as DaemonState).pid === 'number'
    ) {
      return parsed as DaemonState;
    }
    return null;
  } catch {
    return null;
  }
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
export function removeDaemonStateIf(home: string, record: { pid: number; port: number }): void {
  const current = readDaemonState(home);
  if (current !== null && current.pid === record.pid && current.port === record.port) {
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
  const temp = path.join(home, `daemon.json.${String(state.pid)}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    fs.linkSync(temp, target);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Best effort.
    }
  }
}
