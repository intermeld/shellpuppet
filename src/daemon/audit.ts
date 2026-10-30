/**
 * Append-only action log at `~/.shellpuppet/audit.log` (design §4.5).
 *
 * THE RULE: typed content is never logged by default. Keystrokes are where the
 * secrets are: an SSH passphrase or API key typed into a prompt must
 * not end up in a plaintext log. Default entries record the action and the
 * input LENGTH; the command line for `start` is recorded because commands are
 * policy-visible by definition. Screen output is never logged.
 *
 * `audit.captureContent: true` in config.json opts into full input capture for
 * debugging, and docs/reference/security-model.md documents it as secret-capturing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../core/types.js';
import { NULL_LOGGER } from '../core/types.js';

export interface Auditor {
  readonly captureContent: boolean;
  record(
    actor: string,
    action: string,
    session?: string,
    meta?: Record<string, unknown>,
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
  return {
    captureContent: options.captureContent ?? false,
    record(actor, action, session, meta) {
      try {
        const entry = {
          time: new Date().toISOString(),
          actor,
          action,
          ...(session !== undefined ? { session } : {}),
          ...(meta !== undefined ? { meta } : {}),
        };
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
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
