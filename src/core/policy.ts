/**
 * Command policy: allow/deny evaluation for `terminal_start` (design §4.3).
 *
 * Two invariants:
 *
 * 1. **Policy evaluates the pre-wrap command.** Callers pass the real command
 *    (`goose session`); the daemon applies the Windows `cmd.exe /c` wrapper
 *    *after* the policy decision. If policy saw wrapped commands, an allowlist
 *    would see `cmd.exe` for everything and be unsatisfiable.
 * 2. **Configuration errors fail closed.** A malformed pattern in an active
 *    policy denies every command with a clear reason, rather than silently
 *    not matching. A policy that cannot be evaluated as written must not be
 *    guessed at.
 *
 * Policy applies to commands only. It deliberately does not filter keystrokes:
 * that is unenforceable theatre once a shell is running, and pretending
 * otherwise would be worse than saying so.
 *
 * Pure evaluation. No I/O: config loading lives daemon-side.
 */

import type { PolicyConfig, PolicyDecision, PolicyMode } from './types.js';
import { RegexBudgetError, withRegexBudget } from './regexBudget.js';

interface CompiledRule {
  source: string;
  regex: RegExp;
}

export interface CompiledPolicy {
  mode: PolicyMode;
  allow: CompiledRule[];
  deny: CompiledRule[];
  /** Concurrent live sessions allowed; no limit when undefined. */
  maxSessions: number | undefined;
  /** Pattern sources that failed to compile. Non-empty ⇒ active policy denies all. */
  invalidPatterns: string[];
  /**
   * Present ⇒ the policy section itself could not be parsed as written (set
   * by the daemon's config validation, invariant 2). Deny everything,
   * regardless of mode: a bad SHAPE cannot even tell us the intended mode.
   */
  configError?: string;
}

/** The exact string patterns are matched against: command + args, space-joined. */
export function commandLine(command: string, args: string[] = []): string {
  return [command, ...args].join(' ');
}

/**
 * Compile a policy once at config load. Patterns are case-insensitive:
 * Windows commands are case-insensitive in reality (`Goose.exe` ≡ `goose.exe`),
 * and for deny rules matching more broadly is the safe direction.
 */
export function compilePolicy(config?: PolicyConfig): CompiledPolicy {
  const invalidPatterns: string[] = [];
  const compile = (sources: string[] | undefined): CompiledRule[] => {
    const rules: CompiledRule[] = [];
    for (const source of sources ?? []) {
      try {
        rules.push({ source, regex: new RegExp(source, 'i') });
      } catch {
        invalidPatterns.push(source);
      }
    }
    return rules;
  };
  return {
    mode: config?.mode ?? 'allow-all',
    allow: compile(config?.allow),
    deny: compile(config?.deny),
    maxSessions: config?.maxSessions,
    invalidPatterns,
    ...(config?.configError !== undefined ? { configError: config.configError } : {}),
  };
}

/**
 * Decide whether a command may start a session.
 *
 * - `allow-all`: everything passes; the lists are inert.
 * - `denylist`: refused if any deny pattern matches.
 * - `allowlist`: refused unless an allow pattern matches. Deny patterns are
 *   still honoured first, so a deny rule can never be silently ignored by a
 *   mode switch.
 */
export function evaluateCommand(
  policy: CompiledPolicy,
  command: string,
  args: string[] = [],
): PolicyDecision {
  // Checked BEFORE the allow-all early return: a structurally invalid policy
  // section cannot even tell us the intended mode, so no mode is trusted.
  if (policy.configError !== undefined) {
    return {
      allowed: false,
      reason:
        `Policy configuration error: ${policy.configError} All commands are ` +
        `refused until the policy in ~/.shellpuppet/config.json is fixed.`,
    };
  }

  if (policy.mode === 'allow-all') return { allowed: true };

  if (policy.invalidPatterns.length > 0) {
    return {
      allowed: false,
      reason:
        `Policy configuration error: invalid pattern(s): ` +
        `${policy.invalidPatterns.join(', ')}. All commands are refused until the ` +
        `policy in ~/.shellpuppet/config.json is fixed.`,
    };
  }

  const line = commandLine(command, args);

  // Every rule gets a budget, and a rule that overruns it refuses the command
  // (`regexBudget.ts`). That is invariant 2 again: a policy that cannot be
  // evaluated as written must not be guessed at, and the alternative is a
  // rule in a config file blocking the whole daemon's event loop for as long
  // as it backtracks. Deny and allow are treated alike, because the safe
  // direction for both is to refuse.
  const decide = (
    rules: CompiledRule[],
    onMatch: (rule: CompiledRule) => PolicyDecision,
  ): PolicyDecision | null => {
    for (const rule of rules) {
      let matched: boolean;
      try {
        matched = withRegexBudget(rule.source, () => rule.regex.test(line));
      } catch (error) {
        if (error instanceof RegexBudgetError) {
          return {
            allowed: false,
            reason:
              `Policy configuration error: the rule ${rule.source} did not finish ` +
              `evaluating within its budget, so this command is refused. Each ` +
              `command is judged on its own, but the rule will go on failing on ` +
              `lines like this one until the policy in ~/.shellpuppet/config.json ` +
              `is fixed.`,
            rule: rule.source,
          };
        }
        throw error;
      }
      if (matched) return onMatch(rule);
    }
    return null;
  };

  const denied = decide(policy.deny, (rule) => ({
    allowed: false,
    reason: `Command refused by deny rule: ${rule.source}`,
    rule: rule.source,
  }));
  if (denied !== null) return denied;

  if (policy.mode === 'denylist') return { allowed: true };

  const allowed = decide(policy.allow, (rule) => ({ allowed: true, rule: rule.source }));
  if (allowed !== null) return allowed;
  return {
    allowed: false,
    reason: `Command is not on the allowlist: ${line}`,
  };
}

/** Enforce the concurrent-session cap, when one is configured. There is none by default. */
export function checkSessionCapacity(
  policy: CompiledPolicy,
  liveSessionCount: number,
): PolicyDecision {
  if (policy.maxSessions !== undefined && liveSessionCount >= policy.maxSessions) {
    return {
      allowed: false,
      reason:
        `Session limit reached (${String(policy.maxSessions)} live sessions). ` +
        `Kill a session or raise policy.maxSessions.`,
    };
  }
  return { allowed: true };
}
