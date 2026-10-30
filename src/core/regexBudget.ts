/**
 * A time budget for evaluating a caller's regular expression.
 *
 * A pattern is data the caller supplies, and some patterns cost more than the
 * machine has. `^(a+)+$` against twenty-seven characters and a full stop
 * backtracks for longer than any timeout the waiter can enforce, because the
 * evaluation is one synchronous step of the event loop: the poll timer that
 * would have given up never runs, `/health` never answers and every other
 * session stops being served until it finishes.
 *
 * V8 can be told to stop. Running the evaluation through `node:vm` with a
 * `timeout` arms the isolate's interrupt, which regular-expression backtracking
 * checks, so a runaway pattern raises `ERR_SCRIPT_EXECUTION_TIMEOUT` after the
 * budget rather than running to completion. The call costs under a millisecond,
 * which is nothing beside a poll interval or one HTTP request.
 *
 * The interrupt belongs to the isolate, not to the context: when the watchdog
 * fires, V8 terminates whatever JavaScript the isolate is running, and the
 * body it is running is this realm's closure with this realm's RegExp. That is
 * the case the first unit test exercises (a main-realm pattern that would take
 * minutes, abandoned inside its budget), and the case a reader who takes the
 * `timeout` option as context-scoped would expect to hang. Replace the
 * `runInContext` call with a direct call and every test that uses a hostile
 * pattern hangs until an outside watchdog kills it.
 *
 * This is not a sandbox and is not pretending to be one: the body runs in this
 * realm with this realm's objects, and the only thing `vm` is used for is the
 * interrupt. The caller is already authenticated and could run any command it
 * liked; what this protects is everybody else's share of the daemon.
 *
 * Pure logic. No I/O.
 */

import { Script, createContext } from 'node:vm';
import { REGEX_BUDGET_MS } from './types.js';

/** A pattern that ran out of its budget. Callers map this to a 400. */
export class RegexBudgetError extends Error {
  constructor(
    readonly pattern: string,
    readonly budgetMs: number,
  ) {
    super(
      `The pattern ${pattern} took longer than ${String(budgetMs)} ms to evaluate and was ` +
        `abandoned. Patterns with nested repetition (such as (a+)+) can backtrack ` +
        `catastrophically on ordinary screen text; anchor it, or match a simpler thing.`,
    );
    this.name = 'RegexBudgetError';
  }
}

/**
 * One context and one compiled script for the whole process. Both are reusable
 * because the only thing crossing into the context is the body to call, and a
 * body is always synchronous and never re-entrant. The previous value is put
 * back afterwards so a future nested use would behave, rather than silently
 * leaving the last body reachable.
 */
const CONTEXT = createContext({ body: null as unknown });
const CALL_BODY = new Script('body()');

/**
 * Run `body` under `budgetMs` of wall-clock execution, and throw
 * `RegexBudgetError` naming `pattern` if it overruns. Anything else the body
 * throws propagates unchanged.
 */
export function withRegexBudget<T>(
  pattern: string,
  body: () => T,
  budgetMs: number = REGEX_BUDGET_MS,
): T {
  const sandbox = CONTEXT as { body: unknown };
  const previous = sandbox.body;
  sandbox.body = body;
  try {
    return CALL_BODY.runInContext(CONTEXT, { timeout: Math.max(1, budgetMs) }) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new RegexBudgetError(pattern, budgetMs);
    }
    throw error;
  } finally {
    sandbox.body = previous;
  }
}
