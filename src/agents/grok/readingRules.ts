import type { ReadingRules } from '../types.js';

const RADIO = /^ {2}│ {2}([123]) \([○•●]\) /;
const FOOTER = /^ {2}1\/3:select\b/i;
const BAR = /^ {2}│/;
const QUESTION = /^ {2}│ {2}> /;
// The box's own marker for a command's first row. A wrap (`:`) cannot start a
// command, and reasoning text can begin with a colon.
const COMMAND_FIRST = /^ {2}│ {2}│ /;
// A row that starts Grok's reasoning inside the bar (`♦ Thinking…`, `♦ Thought for`).
const REASONING_START = /^ {2}│ {2}♦ /;

export const readingRules: ReadingRules = {
  claimPromptRows: (lines, prompt) => {
    const options = prompt.optionRows;
    if (options?.length !== 3 || options.some((row, i) => RADIO.exec(lines[row]?.text ?? '')?.[1] !== String(i + 1))) return null;
    const firstOption = options[0]!;
    const lastOption = options[2]!;
    const footer = lines.findIndex((line, index) => index > lastOption && FOOTER.test(line.text));
    if (footer < 0 || lines.slice(footer + 1).some((line) => !line.wrapped && line.text.trim() !== '')) return null;

    // Walk the box's bar upwards from its live radios. Physical wraps are
    // part of their parent row, even when they have no bar in column three.
    let above = firstOption - 1;
    while (above >= 0 && (lines[above]!.wrapped || BAR.test(lines[above]!.text))) above--;
    const run = lines.slice(above + 1, firstOption);

    // This claim is only for a box whose question has scrolled away. With a
    // question-shaped row on screen, reasoning text and the question cannot
    // be told apart reliably, so the ordinary claim decides, unchanged. With
    // none, a reasoning start left in the run means the rows cannot be
    // trusted. Otherwise the run must begin with a command's first-row marker:
    // reasoning sits above the question, so any other row at the top of the
    // run may be reasoning, and then nothing is claimed.
    if (run.some((line) => QUESTION.test(line.text) || REASONING_START.test(line.text))) return null;
    if (!COMMAND_FIRST.test(run[0]?.text ?? '')) return null;
    return [above + 1, footer];
  },
};
