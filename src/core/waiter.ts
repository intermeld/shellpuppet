/**
 * Wait predicates: block until a condition holds on a live screen.
 *
 * The single most important primitive for reliable terminal automation: stop
 * guessing at sleeps (design §3.1). Supports text, regex and quiescence
 * conditions, terminated by process exit or timeout.
 *
 * Pure logic over an abstract target. No I/O; timers only. The daemon adapts a
 * session to `WaitTarget`.
 */

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  WAIT_POLL_INTERVAL_MS,
} from './types.js';
import type { WaitCondition, WaitOptions, WaitResult } from './types.js';
import { detectPrompt } from './promptDetector.js';
import type { DetectedPrompt } from './promptDetector.js';

/** Question and options only. The filter's rows stay off anything a caller serialises. */
function promptForCaller(prompt: DetectedPrompt): NonNullable<WaitResult['prompt']> {
  return { question: prompt.question, options: prompt.options, signature: prompt.signature };
}
import { echoEnd } from './echo.js';
import { RegexBudgetError, withRegexBudget } from './regexBudget.js';

/**
 * What the waiter needs to observe, and what it reports back. Implemented by
 * the daemon's session.
 */
export interface WaitTarget {
  /** Current rendered screen (viewport) as plain text. */
  getScreen(): string;
  /** Epoch ms of the most recent output. Session creation seeds this value. */
  lastChangeAt(): number;
  isExited(): boolean;
  /**
   * True once the rendered screen has shown anything at all. Bytes alone are
   * not paint: ConPTY emits mode-set sequences (`ESC[?9001h ESC[?1004h`)
   * ~140 ms after spawn, before the program has written a thing, and those
   * render nothing. Measured on Windows 11.
   */
  hasPainted(): boolean;
  /** The most recent input written to the program, verbatim; null before any. */
  lastInput(): string | null;
  /**
   * Report the detected prompt's signature from a look at the screen, or null
   * for none, so `isStalePrompt` can tell an answered prompt from a live one
   * (see `StalePromptGuard`).
   */
  observePrompt(signature: string | null): void;
  /** True while `signature` is the prompt the last input answered, not yet seen to go. */
  isStalePrompt(signature: string): boolean;
}

export interface WaiterInternals {
  /** Poll interval override, for tests only. */
  pollIntervalMs?: number;
}

/** Thrown for caller mistakes: bad condition shape or an unparsable regex. */
export class WaitConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaitConditionError';
  }
}

/**
 * Resolve when the condition holds, the process exits or the timeout lapses.
 * Never rejects for runtime reasons: the result's `matched`/`reason` carry the
 * outcome, because "it timed out" is an answer, not an error. It rejects only
 * for the caller's own mistakes: a malformed condition, which throws
 * synchronously, and a pattern that overruns its evaluation budget, which
 * cannot be known until it is run and so rejects (`regexBudget.ts`). Both are
 * `WaitConditionError`, which the daemon answers with a 400.
 *
 * Semantics worth knowing:
 * - `text` is a case-insensitive substring match; `regex` is case-insensitive.
 * - **The echo trap:** matching text you have just typed matches the *echo* of
 *   the input (measured at 0 ms), not the program's output. By default the
 *   waiter does not tell them apart, so wait on output-only text or use
 *   `quiet`. `matchAfterInput: true` closes the trap: matches at or before the
 *   echo of the last input are ignored (see `echo.ts` for how the echo is
 *   placed, and when it cannot be). Both behaviours are tested.
 * - `quiet` holds once the program has PAINTED something and then produced no
 *   output for the given time. A program that has never painted is not quiet,
 *   it is not started: silence counted from session creation would report a
 *   CLI ready before its first byte, and a prompt typed on that false ready
 *   would be discarded. A test pins this.
 * - `debounce` (text/regex/prompt): after the first match, keep polling until
 *   the screen has been stable for that long, so a mid-paint TUI can settle.
 *   The match is not re-checked after settling: it appeared, which is what
 *   was asked. The overall timeout still applies while settling.
 * - `prompt` resolves as soon as a permission prompt is on screen, INCLUDING
 *   one already there when the wait began. It means "wait until a prompt is
 *   showing", not "wait for the next one". There is one exception, on by
 *   default: the prompt that was showing when the caller's last input was
 *   sent is treated as answered until the screen has been seen without it
 *   (`StalePromptGuard`). A supervision loop that has just answered one
 *   prompt gets the NEXT one, never the one it answered on a screen
 *   the program has not yet repainted. `matchAfterInput: false` restores the
 *   plain rule.
 * - Match is checked before exit: an exited process whose final screen contains
 *   the target still reports the match.
 */
export function waitFor(
  target: WaitTarget,
  condition: WaitCondition,
  options: WaitOptions & WaiterInternals = {},
): Promise<WaitResult> {
  const provided = [
    condition.text !== undefined,
    condition.regex !== undefined,
    condition.quiet !== undefined,
    condition.prompt === true,
  ].filter(Boolean).length;
  if (provided !== 1) {
    throw new WaitConditionError(
      `Exactly one of text, regex, quiet or prompt must be provided (got ${String(provided)}).`,
    );
  }
  if (condition.quiet !== undefined && (!Number.isFinite(condition.quiet) || condition.quiet < 0)) {
    throw new WaitConditionError('quiet must be a non-negative number of milliseconds.');
  }
  // timeout/debounce get the same scrutiny as quiet. A NaN timeout (the CLI's
  // `--timeout abc` becomes Number('abc')) would make the deadline comparison
  // below permanently false: the wait, and the one-shot client awaiting the
  // HTTP response, would hang forever, the exact failure class this project
  // exists to eliminate. A NaN debounce would instead never "settle" and
  // mislabel a real match as a timeout.
  if (
    options.timeout !== undefined &&
    (!Number.isFinite(options.timeout) || options.timeout < 0)
  ) {
    throw new WaitConditionError('timeout must be a non-negative number of milliseconds.');
  }
  if (
    options.debounce !== undefined &&
    (!Number.isFinite(options.debounce) || options.debounce < 0)
  ) {
    throw new WaitConditionError('debounce must be a non-negative number of milliseconds.');
  }

  // Both text and regex compile to a global, case-insensitive pattern so that
  // a search can start at an offset (the echo guard below) without
  // lowercasing the screen, which can change its length for some Unicode
  // and misalign every offset. `text` is escaped, so it stays a plain
  // substring match.
  let pattern: RegExp | null = null;
  let patternReason: 'text' | 'regex' = 'text';
  /** What to name in a budget refusal: the caller's own words for it. */
  let patternSource = condition.text ?? '';
  if (condition.regex !== undefined) {
    patternSource = condition.regex;
    try {
      // Multiline: the screen is lines joined with \n, and `^42` written by a
      // caller means "a line starting with 42", the same per-line semantics
      // terminal_find has. Without `m` the anchor silently binds to the start
      // of the whole screen and never matches.
      pattern = new RegExp(condition.regex, 'gim');
      patternReason = 'regex';
    } catch (cause) {
      throw new WaitConditionError(
        `Invalid regular expression: ${condition.regex} (${String(cause)})`,
      );
    }
  } else if (condition.text !== undefined) {
    pattern = new RegExp(condition.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  }
  /**
   * Index of the first match at or after `from`, or -1.
   *
   * A caller's own regex runs under a budget, because a pattern that
   * backtracks catastrophically blocks the event loop for longer than this
   * wait's own timeout: the poll timer that would give up never gets to run,
   * and neither does anything else the daemon owes anyone (see
   * `regexBudget.ts`). Per evaluation, not per wait: a screen the pattern
   * copes with costs nothing, and one it does not is refused the moment it
   * appears.
   *
   * A `text` condition is not bounded and does not need to be: it is escaped
   * into a literal above, which has no quantifiers to backtrack through, and
   * a wait can poll thousands of times before its deadline.
   */
  const bounded = condition.regex !== undefined;
  const matchAt = (screen: string, from: number): number => {
    if (pattern === null) return -1;
    const search = (): RegExpExecArray | null => {
      pattern.lastIndex = from;
      return pattern.exec(screen);
    };
    const found = bounded ? withRegexBudget(patternSource, search) : search();
    return found === null ? -1 : found.index;
  };

  // Default: on for prompt (a supervisor never wants the question it has
  // just answered handed back), off for text/regex (an opt-in guard).
  const afterInput = options.matchAfterInput ?? condition.prompt === true;

  const timeoutMs = Math.min(
    Math.max(options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS, 0),
    MAX_WAIT_TIMEOUT_MS,
  );
  const debounceMs = Math.max(options.debounce ?? 0, 0);
  const pollMs = options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS;

  const startedAt = Date.now();
  let matchedAt: number | null = null;
  let matchedReason: 'text' | 'regex' | 'prompt' | null = null;
  let matchedPrompt: DetectedPrompt | null = null;
  /** Last tick: the only prompt on screen was the one the last input answered. */
  let staleOnly = false;
  /** Last tick: matches existed, but only at or before the echo of the last input. */
  let echoOnly = false;

  return new Promise<WaitResult>((resolve, reject) => {
    /**
     * The next poll, so an abort can cancel it rather than let it fire once
     * more into a request nobody is reading.
     */
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      finish(false, 'aborted');
    };

    // Only a non-match carries an explanation, and only where the waiter
    // knows one. Each is a different answer from "the condition never
    // held", and the caller's next move depends on which it was.
    const explain = (): string | undefined => {
      if (condition.quiet !== undefined && !target.hasPainted()) {
        return 'The program has not painted anything yet, so quiet cannot hold: it is still starting, or prints nothing.';
      }
      if (condition.prompt === true && staleOnly) {
        return (
          'The prompt on screen is the one that was showing when your last input was sent, and the ' +
          'screen has not been seen without it since. The input may not have reached the program. ' +
          'Snapshot to check; pass matchAfterInput:false to accept it anyway.'
        );
      }
      if (pattern !== null && echoOnly) {
        return (
          'Matches were found only at or before the echo of your last input and were ignored ' +
          '(matchAfterInput). If the output you expect repeats what you typed, wait for something ' +
          'else or use quiet.'
        );
      }
      return undefined;
    };
    let settled = false;
    const finish = (matched: boolean, reason: WaitResult['reason']): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      const detail = matched ? undefined : explain();
      resolve({
        matched,
        reason,
        waitedMs: Date.now() - startedAt,
        screen: target.getScreen(),
        ...(matchedPrompt !== null ? { prompt: promptForCaller(matchedPrompt) } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    };

    const step = (): void => {
      const now = Date.now();
      const screen = target.getScreen();

      if (matchedAt === null) {
        if (pattern !== null) {
          // The echo guard: with matchAfterInput, a match must lie after the
          // echo of the last input, when that echo can be placed at all.
          const from = afterInput ? (echoEnd(screen, target.lastInput() ?? '') ?? 0) : 0;
          if (matchAt(screen, from) !== -1) {
            matchedAt = now;
            matchedReason = patternReason;
          } else {
            echoOnly = from > 0 && matchAt(screen, 0) !== -1;
          }
        } else if (condition.prompt === true) {
          // Re-detected on every tick while settling below, because a
          // mid-paint TUI can change WHICH prompt is drawn; the result must
          // carry the prompt as it stands when the wait resolves, not a
          // half-painted earlier read of it.
          const detected = detectPrompt(screen);
          target.observePrompt(detected?.signature ?? null);
          if (detected === null) {
            staleOnly = false;
          } else if (afterInput && target.isStalePrompt(detected.signature)) {
            // The question the caller has just answered, on a screen the
            // program has not repainted yet. Handing it back would have the
            // supervisor answer it again, into whatever has focus by then.
            staleOnly = true;
          } else {
            staleOnly = false;
            matchedAt = now;
            matchedReason = 'prompt';
            matchedPrompt = detected;
          }
        }
        if (matchedAt !== null && debounceMs === 0) {
          finish(true, matchedReason ?? 'text');
          return;
        }
      } else if (matchedReason === 'prompt') {
        const stillThere = detectPrompt(screen);
        target.observePrompt(stillThere?.signature ?? null);
        if (stillThere === null) {
          // The prompt went away while we were settling: answered by the
          // human at the viewer, or redrawn past. Reporting `matched: true`
          // with the remembered prompt would hand the caller a question that
          // is no longer on screen, and a supervisor acting on it would answer
          // a prompt that no longer exists. Retract the match and keep
          // waiting: the condition asked for a prompt that is THERE.
          matchedAt = null;
          matchedPrompt = null;
          matchedReason = null;
        } else {
          matchedPrompt = stillThere;
        }
      }

      if (matchedAt !== null) {
        // Settling: resolve once the screen has been stable for debounceMs.
        // An exited process's screen is final and so trivially settled, and the
        // match must not be lost to the exit check below.
        if (now - target.lastChangeAt() >= debounceMs || target.isExited()) {
          finish(true, matchedReason ?? 'text');
          return;
        }
      } else if (
        condition.quiet !== undefined &&
        // No paint, no quiet: silence from a program that has not drawn
        // anything is "not started", not "finished and idle".
        target.hasPainted() &&
        now - target.lastChangeAt() >= condition.quiet
      ) {
        finish(true, 'quiet');
        return;
      }

      if (target.isExited()) {
        finish(false, 'exited');
        return;
      }
      if (now - startedAt >= timeoutMs) {
        finish(false, 'timeout');
        return;
      }
      pollTimer = setTimeout(tick, pollMs);
    };

    /**
     * A pattern that overruns its budget is the caller's mistake, so it is
     * reported as one rather than left to escape from a timer callback, where
     * nothing is listening and the daemon's uncaughtException handler would
     * answer it by stopping.
     */
    const tick = (): void => {
      try {
        step();
      } catch (error) {
        if (error instanceof RegexBudgetError) {
          reject(new WaitConditionError(error.message));
          return;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    // Checked before the first look as well as after: a caller that has
    // already gone is not owed one.
    if (options.signal?.aborted === true) {
      finish(false, 'aborted');
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    tick();
  });
}
