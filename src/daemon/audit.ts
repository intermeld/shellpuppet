/**
 * Append-only action log at `~/.shellpuppet/audit.log` (design §4.5).
 *
 * Typed entries record input length. A marked submit header or legacy reporting marker adds an outcome. Start
 * entries record the command line because commands are visible to policy.
 * Typed content and screen output stay out of the log.
 *
 * `audit.captureContent: true` in config.json includes terminal report bytes for
 * debugging. Typed input entries carry fixed metadata and a character count.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../core/types.js';
import { NULL_LOGGER } from '../core/types.js';

export interface Auditor {
  readonly captureContent: boolean;
  /** Append synchronously or throw. Operations that require an audit entry use this path. */
  recordRequired?: Auditor['record'];
  record(
    actor: string,
    action: string,
    session?: string,
    meta?: Record<string, unknown>,
    callerSession?: string,
  ): void;
}

export function auditLogPath(home: string): string {
  return path.join(home, 'audit.log');
}

/** An auditor that records nothing, used by unit-style tests. */
export const NULL_AUDITOR: Auditor = {
  captureContent: false,
  record: () => undefined,
};

export function createAuditor(
  home: string,
  options: { captureContent?: boolean } = {},
  logger: Logger = NULL_LOGGER,
): Auditor {
  const file = auditLogPath(home);
  let warned = false;
  const append: Auditor['record'] = (actor, action, session, meta, callerSession) => {
    const entry = {
      time: new Date().toISOString(),
      actor,
      action,
      ...(callerSession !== undefined ? { callerSession } : {}),
      ...(session !== undefined ? { session } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  };
  return {
    captureContent: options.captureContent ?? false,
    recordRequired: append,
    record(...args) {
      try {
        append(...args);
      } catch (error) {
        if (!warned) {
          warned = true;
          logger.warn('audit log write failed: auditing disabled for this run', {
            error: String(error),
          });
        }
      }
    },
  };
}
