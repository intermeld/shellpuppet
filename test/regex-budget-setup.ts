/**
 * Setup for every test file: a caller's pattern that names no budget of its
 * own gets two seconds, not the product's quarter of a second.
 *
 * The budget is wall-clock time (`src/core/regexBudget.ts`). On a machine
 * loaded by the rest of the run, an ordinary pattern can be descheduled past
 * 250 ms (`\d+ extensions` against a few short lines is one that was), and a
 * built-in dialog signature set aside that way stays aside for a minute,
 * failing the tests after it in its file as well. Two seconds is what a pattern
 * that searches rather than backtracks needs on a loaded machine, with room
 * to spare; a runaway pattern is still abandoned, two seconds in instead of a
 * quarter.
 *
 * `test/core/regexBudget.test.ts` puts the product's figure back for the tests
 * that show a runaway pattern abandoned in time at each caller.
 */

import { setDefaultRegexBudgetForTests } from '../src/core/regexBudget.js';

export const TEST_REGEX_BUDGET_MS = 2_000;

setDefaultRegexBudgetForTests(TEST_REGEX_BUDGET_MS);
