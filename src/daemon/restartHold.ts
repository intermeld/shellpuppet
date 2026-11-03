import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../core/types.js';

export interface RestartHold {
  expiresAt: number;
  pid: number;
  replacing?: { pid: number; startedAt: string };
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
          !Number.isSafeInteger(hold.replacing.pid) || hold.replacing.pid <= 0 ||
          typeof hold.replacing.startedAt !== 'string' || hold.replacing.startedAt.length === 0)) {
      throw new Error('invalid');
    }
    if (hold.expiresAt <= Date.now()) {
      clearRestartHold(home);
      return null;
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
  return new Error(`The ShellPuppet daemon is stopped for a restart (${timing}). Try again shortly, or run \`shellpuppet daemon start\` to end the hold.`);
}
