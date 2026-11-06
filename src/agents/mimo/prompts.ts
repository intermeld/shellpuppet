import type { PromptShape } from '../types.js';
import { prompts as openCodePrompts } from '../opencode/prompts.js';

/** The first line of a message clack logs: `●  Accessing workspace:`. */
const CLACK_LOG = /^[●◆◇▲■] {2}(\S.*)$/;
const CLACK_GUTTER = /^│(?: |$)/;

/**
 * The message clack logged directly above the line at `index`: its first
 * line (`●  Accessing workspace:`) and the lines in the gutter under it.
 * Empty when what is above is not a logged message.
 *
 * A line longer than the terminal is wide goes on at the start of the next
 * row, out of the gutter. Such a row is joined to the row above it as it
 * stands, since the break can fall inside a word, but only when the row above
 * fills the screen's width as far as the screen shows it (its longest line, or
 * one short where the break trimmed a space). Any other line out of the gutter
 * is not part of the message.
 */
function loggedAbove(raw: string[], index: number): string[] {
  const width = Math.max(...raw.map((line) => line.trimEnd().length));
  const lines: string[] = [];
  let wrapped = '';
  for (let at = index - 1; at >= 0; at--) {
    const line = (raw[at] ?? '').trimEnd();
    const first = CLACK_LOG.exec(line);
    if (first !== null) return [`${first[1] ?? ''}${wrapped}`, ...lines];
    if (CLACK_GUTTER.test(line)) {
      lines.unshift(`${line.slice(1).trim()}${wrapped}`);
      wrapped = '';
      continue;
    }
    if (line.trim() === '') return [];
    if ((raw[at - 1] ?? '').trimEnd().length < width - 1) return [];
    wrapped = `${line}${wrapped}`;
  }
  return [];
}

export const prompts: PromptShape[] = [...openCodePrompts, { kind: 'rows', clackMessage: loggedAbove }];
