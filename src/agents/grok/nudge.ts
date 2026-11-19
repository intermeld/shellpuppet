import { onlyBlankRowsAfter, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

export function readiness(view: NudgeView): NudgeReadiness {
  if (view.styled !== undefined && (view.styled.length !== view.rows.length ||
    view.styled.some((line, index) => line.text !== view.rows[index]))) return 'unknown';
  let at = -1;
  for (let i = view.rows.length - 1; i >= 0; i--) {
    if (/^ {2}│ > /u.test(view.rows[i] ?? '')) { at = i; break; }
  }
  const top = view.rows[at - 1] ?? '';
  const bottom = view.rows[at + 1] ?? '';
  if (at < 1 || !((/^ {2}╭─/u.test(top) && /^ {2}╰─/u.test(bottom)) ||
    (/^ {2}┌─/u.test(top) && /^ {2}└─/u.test(bottom)))) return 'unknown';
  const status = view.rows[at + 2] ?? '';
  const hints = view.rows[at + 3] ?? '';
  const afterTurn = /^ {2}Grok .+ [█░]{4,} \d+%$/u.test(status) &&
    /^ {2}(?:Enter:send {2}│ {2}Alt\+Enter:newline {2}│ {2})?Shift\+Tab:mode {2}│ {2}Ctrl\+x:shortcuts$/u.test(hints);
  // Before the first turn the status and key hints are replaced by a blank
  // row and a right-aligned build channel. The tip above the frame identifies
  // this layout; all three rows must be in the live bottom block.
  const welcome = status === '' && /^ {10,}\[stable\]$/u.test(hints) &&
    view.rows.slice(Math.max(0, at - 5), at - 1).some((row) => /^ {3}Tip: /u.test(row));
  if ((!afterTurn && !welcome) || !onlyBlankRowsAfter(view.rows, at + 3)) return 'unknown';
  const original = view.rows[at]!;
  const close = original.lastIndexOf('│');
  if (close <= 6) return 'unknown';
  const body = original.slice(6, close).trimEnd();
  const rows = [...view.rows];
  rows[at] = `> ${body}`;
  const styled = view.styled?.map((line, index) => index === at ? { ...line, text: rows[at]!, spans: [] } : line);
  return readingReadiness({ rows, styled, expectedDraft: view.expectedDraft }, { ...reading, composer: { text: '^> ' } }, {
    placeholder: '', continuations: false, placeholderInk: () => false,
  });
}
