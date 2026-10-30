/**
 * A caller's pattern gets a time budget (`src/core/regexBudget.ts`).
 *
 * The daemon is one event loop. A regular expression that backtracks
 * catastrophically holds it for longer than any timeout the waiter can
 * enforce, because the poll timer that would give up cannot run while the
 * evaluation is running, so `/health`, every other session and the wait's
 * own deadline all stop with it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOnScreen } from '../../src/core/find.js';
import { compilePolicy, evaluateCommand } from '../../src/core/policy.js';
import { RegexBudgetError, setDefaultRegexBudgetForTests, withRegexBudget } from '../../src/core/regexBudget.js';
import { REGEX_BUDGET_MS } from '../../src/core/types.js';
import { WaitConditionError, waitFor } from '../../src/core/waiter.js';
import type { WaitTarget } from '../../src/core/waiter.js';
import { TEST_REGEX_BUDGET_MS } from '../regex-budget-setup.js';

/** Exponential backtracking on a string that cannot match. */
const HOSTILE = '^(a+)+$';
const HOSTILE_SCREEN = `${'a'.repeat(30)}!`;

function targetShowing(screen: string): WaitTarget {
  return {
    getScreen: () => screen,
    lastChangeAt: () => Date.now(),
    isExited: () => false,
    hasPainted: () => true,
    lastInput: () => null,
    observePrompt: () => undefined,
    isStalePrompt: () => false,
  };
}

describe('withRegexBudget', () => {
  it('abandons a pattern that overruns, and names it', () => {
    const regex = new RegExp(HOSTILE);
    const startedAt = Date.now();
    expect(() =>
      withRegexBudget(HOSTILE, () => regex.exec(HOSTILE_SCREEN), 200),
    ).toThrow(RegexBudgetError);
    // Abandoned near its budget, not run to completion: this pattern against
    // this string takes minutes.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('returns what an ordinary pattern found, and costs next to nothing', () => {
    const regex = /wor(l)d/;
    const startedAt = Date.now();
    const found = withRegexBudget('wor(l)d', () => regex.exec('hello world'));
    expect(found?.[1]).toBe('l');
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('lets anything else the body throws through unchanged', () => {
    expect(() =>
      withRegexBudget('x', () => {
        throw new TypeError('not a budget problem');
      }),
    ).toThrow(TypeError);
  });
});

describe('the budget at each caller', () => {
  // The product's budget, not the one the suite gives patterns
  // (`test/regex-budget-setup.ts`): these show that each caller abandons a
  // runaway pattern in time with the figure the daemon runs with.
  beforeAll(() => setDefaultRegexBudgetForTests(REGEX_BUDGET_MS));
  afterAll(() => setDefaultRegexBudgetForTests(TEST_REGEX_BUDGET_MS));

  it('a wait on a hostile pattern is refused, rather than freezing everything', async () => {
    const startedAt = Date.now();
    await expect(
      waitFor(targetShowing(HOSTILE_SCREEN), { regex: HOSTILE }, { timeout: 5_000 }),
    ).rejects.toThrow(WaitConditionError);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('the refusal names the pattern, so the caller can fix the right thing', async () => {
    await expect(
      waitFor(targetShowing(HOSTILE_SCREEN), { regex: HOSTILE }, { timeout: 5_000 }),
    ).rejects.toThrow(/\^\(a\+\)\+\$/);
  });

  it('a find on a hostile pattern is refused once, not once per line', () => {
    const startedAt = Date.now();
    expect(() => findOnScreen(Array<string>(40).fill(HOSTILE_SCREEN), HOSTILE)).toThrow(
      RegexBudgetError,
    );
    // Forty lines, one budget: a per-line budget would be forty times this.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('a policy rule that will not finish refuses the command rather than hanging', () => {
    const policy = compilePolicy({ mode: 'denylist', deny: [HOSTILE] });
    const startedAt = Date.now();
    const decision = evaluateCommand(policy, HOSTILE_SCREEN);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Policy configuration error');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
