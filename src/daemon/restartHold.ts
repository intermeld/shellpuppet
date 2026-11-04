import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../core/types.js';

export interface RestartHold {
  expiresAt: number;
  pid: number;
  replacing?: { instanceId?: string; pid: number; port: number; startMode: 'direct' | 'wrapped' };
}
const warnedRecords = new Set<string>();

function warnOnce(home: string, raw: string, logger: Logger, message: string): void {
  const key = `${home}\0${raw}`;
  if (warnedRecords.has(key)) return;
  warnedRecords.add(key);
  logger.warn(message);
}

export function restartHoldPath(home: string): string {
  return path.join(home, 'restart-hold.json');
}

export function clearRestartHold(home: string): void {
  try { fs.unlinkSync(restartHoldPath(home)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function writeRestartHold(home: string, seconds: number, replacing?: RestartHold['replacing']): void {
  const cutoff = Date.now() - 3_600_000;
  for (const name of fs.readdirSync(home)) {
    if (!/^\.restart-hold-.+\.tmp$/.test(name)) continue;
    const candidate = path.join(home, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) fs.unlinkSync(candidate);
    } catch { /* Another writer may have removed it. */ }
  }
  const target = restartHoldPath(home);
  const temporary = path.join(home, `.restart-hold-${randomUUID()}.tmp`);
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ expiresAt: Date.now() + seconds * 1000, pid: process.pid,
        ...(replacing === undefined ? {} : { replacing }) }));
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
  } catch (error) {
    if (created) {
      try { fs.unlinkSync(temporary); }
      catch { /* A failed rename may already have moved it. */ }
    }
    throw error;
  }
}

export function readRestartHold(home: string, logger: Logger): RestartHold | null {
  let raw: string;
  try {
    const target = restartHoldPath(home);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      warnOnce(home, 'not-regular', logger, 'ignoring invalid restart hold record');
      return null;
    }
    raw = fs.readFileSync(target, 'utf8');
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    warnOnce(home, 'unreadable', logger, 'ignoring unreadable restart hold record');
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) throw new Error('invalid');
    const hold = value as RestartHold;
    if (!Number.isSafeInteger(hold.expiresAt) || !Number.isSafeInteger(hold.pid) || hold.pid <= 0 ||
        hold.expiresAt - Date.now() > 600_000) throw new Error('invalid');
    if (hold.replacing !== undefined &&
        (typeof hold.replacing !== 'object' || hold.replacing === null ||
          (hold.replacing.instanceId !== undefined &&
            (typeof hold.replacing.instanceId !== 'string' || hold.replacing.instanceId.length === 0)) ||
          !Number.isSafeInteger(hold.replacing.pid) || hold.replacing.pid <= 0 ||
          !Number.isSafeInteger(hold.replacing.port) || hold.replacing.port <= 0 || hold.replacing.port > 65_535 ||
          !['direct', 'wrapped'].includes(hold.replacing.startMode))) {
      throw new Error('invalid');
    }
    if (hold.expiresAt <= Date.now()) {
      clearRestartHold(home);
      return null;
    }
    // A manual stop hold outlives its one-shot CLI by design. A restart hold
    // belongs to the CLI still performing the replacement.
    if (hold.replacing !== undefined) {
      try { process.kill(hold.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
        // EPERM means the writer exists; all other errors are treated cautiously.
      }
    }
    return hold;
  } catch {
    warnOnce(home, raw, logger, 'ignoring invalid restart hold record');
    return null;
  }
}

export function restartHoldError(hold: RestartHold): Error {
  const remaining = Math.ceil((hold.expiresAt - Date.now()) / 1000);
  const timing = remaining > 0 ? `hold ends in ${String(remaining)} s` : 'hold expired while waiting';
  const replaced = hold.replacing === undefined ? '' :
    `; replacing pid ${String(hold.replacing.pid)}, port ${String(hold.replacing.port)}`;
  return new Error(`The ShellPuppet daemon is stopped for a restart (${timing}${replaced}). Try again shortly, or run \`shellpuppet daemon start\` to end the hold.`);
}
