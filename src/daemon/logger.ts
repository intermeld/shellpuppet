/**
 * File-backed logger for the daemon. The daemon runs fully detached with
 * `stdio: 'ignore'`, so a log file is the only place its story can go.
 * Logging must never crash the daemon, so failures are swallowed.
 */

import * as fs from 'node:fs';
import type { Logger } from '../core/types.js';

export function createFileLogger(filePath: string): Logger {
  const write = (level: string, message: string, meta?: Record<string, unknown>): void => {
    try {
      const line =
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          message,
          ...(meta !== undefined ? { meta } : {}),
        }) + '\n';
      fs.appendFileSync(filePath, line);
    } catch {
      // Never let logging take the daemon down.
    }
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
