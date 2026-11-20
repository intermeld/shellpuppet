import type { ReadingRules } from '../types.js';
import type { StyledLine } from '../../core/renderer.js';

const RADIO = /^ {2}│ {2}([123]) \([○•●]\) /;
const FOOTER = /^ {2}1\/3:select\b/i;
const BAR = /^ {2}│/;
const QUESTION = /^ {2}│ {2}> /;
// The box's own marker for a command's first row. A wrap (`:`) cannot start a
// command, and reasoning text can begin with a colon.
const COMMAND_FIRST = /^ {2}│ {2}│ /;
// A row that starts Grok's reasoning inside the bar (`♦ Thinking…`, `♦ Thought for`).
const REASONING_START = /^ {2}│ {2}♦ /;

function inkAt(line: StyledLine | undefined, column: number) {
  return line?.spans.find((span) => span.from <= column && column < span.to);
}

/** The physical bar is repainted even when xterm still marks the row as wrapped. */
function boxBody(line: StyledLine | undefined): string | undefined {
  if (!line || !/^ {2}│(?: {2}|$)/u.test(line.text)) return undefined;
  const bar = inkAt(line, 2);
  return bar?.fg === '#c8c8c8' && bar.bg === '#404040' ? line.text.slice(5) : undefined;
}

function isBoxAction(line: StyledLine | undefined): boolean {
  if (!line || !/^[!-~] \S/u.test(boxBody(line) ?? '')) return false;
  const key = inkAt(line, 5);
  const label = inkAt(line, 7);
  return key?.fg === '#c8c8c8' && key.bg === '#404040' &&
    label?.fg === '#6c6c6c' && label.bg === '#404040' && label.to === line.text.length;
}

/** Grok Build 1.0.89 can repaint its whole radio list over soft wraps. */
function actionBox(lines: readonly StyledLine[]): readonly [number, number] | null {
  let footer = lines.length - 1;
  while (footer >= 0 && lines[footer]!.text.trim() === '') footer--;
  const count = /^ {2}1\/([1-9]\d*):select\b/u.exec(lines[footer]?.text ?? '');
  if (!count) return null;
  let row = footer - 1;
  // The optional status line below the closing bar uses palette ink on the transcript background.
  const status = inkAt(lines[row], 2);
  if (status?.fg === 'p6' && status.bg === '#141414') row--;
  if (boxBody(lines[row]) !== '') return null;
  const bottom = row;
  row--;
  let choices = 0;
  let selected = 0;
  for (;; row--) {
    // Some shortcuts are omitted, including the number beside the final radio.
    const radio = /^(?:[1-9]\d*| ) \(([○•●])\) \S/u.exec(boxBody(lines[row]) ?? '');
    if (!radio) break;
    choices++;
    if (radio[1] !== '○') selected++;
  }
  if (choices < 2 || choices !== Number(count[1]) || selected !== 1) return null;

  while (boxBody(lines[row]) === '') row--;
  if (boxBody(lines[row]) === 'Auto-review blocked this action.  Ctrl+F to view explanation') row--;
  while (boxBody(lines[row]) === '') row--;

  if (!isBoxAction(lines[row])) return null;
  while (isBoxAction(lines[row - 1])) row--;

  // Walk only marked command rows. A plain bar row above the command may belong to reasoning.
  const actionRow = row;
  while (/^[│:] /u.test(boxBody(lines[row - 1]) ?? '')) row--;
  if (row === actionRow || !COMMAND_FIRST.test(lines[row]!.text)) return null;
  if (boxBody(lines[row - 1])?.startsWith('> ')) row--;
  if (boxBody(lines[row - 1]) === '') row--;
  return [row, bottom];
}

export const readingRules: ReadingRules = {
  claimPromptRows: (lines, prompt) => {
    const action = actionBox(lines);
    if (action) return action;
    const options = prompt?.optionRows;
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
