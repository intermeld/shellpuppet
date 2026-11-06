import type { PromptShape } from '../types.js';

/**
 * Grok's permission question row: two spaces, the bar, two spaces, `>`,
 * then a space. With or without a question mark, that row is the question
 * the box is asking. The composer is `│ >` with one space and does not match.
 */
const GROK_BOX_QUESTION = /^ {2}│ {2}> /;
/** Bar text in that same box: two spaces, the bar, two spaces, a word. */
const GROK_BAR_TEXT = /^ {2}│ {2}\S/;
/** The bare bar row that closes a command off from the reasoning above it. */
const GROK_BARE_BAR = /^ {2}│\s*$/;
/**
 * A line that starts Grok's reasoning. The command walk does not see the
 * signature. The thinking header is itself bar text, so the walk would
 * otherwise take it; the spinner is not bar text, and a run below it is
 * still closed off by it.
 */
const GROK_REASONING_START = /^ {2}│ {2}♦ Thinking|^ {3}[|/\\-] \S/;
/** A `$` on a command row, or a `:` continuation of one. */
const GROK_COMMAND_MARK = /\$|^ {2}│ {2}:/;

/**
 * An option with its key after it, as Grok's folder-trust question draws
 * them: `Yes, proceed        y`. The label, two or more spaces, then a single
 * letter ending the line. Captures indent, label and key.
 */
const KEY_HINT_ROW = /^(\s*)(\S.*?)\s{2,}([a-z])$/i;
/**
 * Where an older Grok box's command starts. The command is plain bar text
 * above the radios. The walk may cross the one bare bar between that text
 * and the radios. It stops at the next bare bar, or at a line that starts
 * Grok's reasoning (`♦ Thinking`, or the spinner). The run is taken only
 * when a line in it is command evidence: the box's `│  > ` question row,
 * a `$`, or a `:` continuation. Otherwise the run is the same shape as
 * reasoning, and the radios stay the start.
 */
function commandAboveRadios(raw: string[], firstOption: number): number {
  const text = (index: number): string => (raw[index] ?? '').trimEnd();
  if (!/^ {2}│ {2}\d+ \([○•●]\) /.test(text(firstOption))) return firstOption;
  const above = firstOption - 1;
  // The one bare bar between the command and the radios may be crossed.
  // Text sitting directly on the radios is the command itself.
  const gap = GROK_BARE_BAR.test(text(above));
  let cursor = gap ? above - 1 : above;
  let start = firstOption;
  let sawText = false;
  let sawEvidence = false;
  while (cursor >= 0 && GROK_BAR_TEXT.test(text(cursor)) && !GROK_REASONING_START.test(text(cursor))) {
    sawText = true;
    if (GROK_BOX_QUESTION.test(text(cursor)) || GROK_COMMAND_MARK.test(text(cursor))) sawEvidence = true;
    start = cursor;
    cursor--;
  }
  if (!sawText || !sawEvidence) return firstOption;
  if (GROK_BARE_BAR.test(text(cursor)) || GROK_REASONING_START.test(text(cursor))) return start;
  return firstOption;
}

/** Numbered radio choices are also a generic chooser shape. */
export const radioRows: PromptShape = {
  kind: 'rows',
  numbered: /^\s*(?:│\s*)?(?:[❯›]\s*|>\s*)?(\d+)\s+\([○•●]\)\s+\S/,
  marker: /\([•●]\)/,
};

export const prompts: PromptShape[] = [radioRows, {
  kind: 'rows', keyHint: KEY_HINT_ROW,
  questionPrefix: GROK_BOX_QUESTION, commandStart: commandAboveRadios,
}];
