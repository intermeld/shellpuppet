/**
 * Regex search over a rendered screen, with line numbers (`terminal_find`).
 * Pure function: the daemon feeds it snapshot lines.
 */

import { withRegexBudget } from './regexBudget.js';

export interface FindMatch {
  /** 1-based line number on the screen as rendered. */
  line: number;
  /** The full text of the matching line, right-trimmed. */
  text: string;
  /** The exact matched substring. */
  match: string;
}

export interface FindResult {
  matches: FindMatch[];
  /** True when results were cut off at the cap. */
  truncated: boolean;
}

/** Bound the response size: a pathological pattern can match every line. */
const MAX_MATCHES = 100;

/**
 * What the CLI and the MCP tool both say when nothing matched: one fixed line
 * that never repeats the pattern, so a watcher that searches the output for
 * its own pattern cannot mistake the absence line for a hit.
 */
export const NO_MATCHES = 'No matches.';

/**
 * Case-insensitive by default, like the waiter. Throws `SyntaxError` on an
 * invalid pattern, and `RegexBudgetError` on one that will not finish.
 * Callers map both to a client error.
 *
 * The whole search runs under ONE budget rather than one per line: a pattern
 * that backtracks on a screenful of text would otherwise be given the budget
 * again for every row, and a hundred and fifty rows is not a bound worth
 * having (`regexBudget.ts`).
 */
export function findOnScreen(lines: string[], pattern: string): FindResult {
  const regex = new RegExp(pattern, 'i');
  return withRegexBudget(pattern, () => {
    const matches: FindMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? '';
      const found = regex.exec(text);
      if (found !== null) {
        matches.push({ line: i + 1, text, match: found[0] });
        if (matches.length >= MAX_MATCHES) {
          return { matches, truncated: i < lines.length - 1 };
        }
      }
    }
    return { matches, truncated: false };
  });
}
