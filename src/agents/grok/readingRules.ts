import type { ReadingRules } from '../types.js';
import type { StyledLine } from '../../core/renderer.js';

const BAR = /^ {2}│/;
const QUESTION = /^ {2}│ {2}> {2}\S/;
const OPTION = /^ {2}│ {2}[123] \(([○•●])\) \S/;
const COMMAND = /^ {2}│ {2}[│:]/;
const BLANK_BAR = /^ {2}│\s*$/;
const FOOTER = /^ {2}[123]\/3:select(?:\s|$)/;
const COMMAND_FIRST = /^ {2}│ {2}│ /;
const QUESTION_SHAPED = /^ {2}│ {2}> /;
const LITERAL_REDIRECTION = /^ {2}│ {2}> \S/;
const REASONING_START = /^ {2}│ {2}♦ (?:Thinking|Thought)/;

// Grok Build 1.0.70 permission fixtures. Build 1.0.89 also uses the prose
// colour and draws the heading at #6e6e6e rather than #6c6c6c.
const REASONING_INK = '#929292';
const REASONING_HEADING_INKS = new Set(['#6c6c6c', '#6e6e6e']);
const BOX_QUESTION_INK = '#e1e1e1';
const BOX_SELECTED_INK = '#e1e1e1';
const BOX_UNSELECTED_INK = '#c8c8c8';
const BOX_FOOTER_INK = '#808080';

/** The first non-space text cell after the bar, excluding the bar's own ink. */
function textInk(line: StyledLine): string | null {
  for (let column = 5; column < line.text.length; column++) {
    if (!/\s/u.test(line.text[column]!)) {
      return line.spans.find((span) => span.from <= column && column < span.to)?.fg ?? null;
    }
  }
  return null;
}

/** Every non-blank text cell from the text's first column must have the required ink. */
function wholeRowInk(line: StyledLine, ink: string, from = 5): boolean {
  let found = false;
  for (let column = from; column < line.text.length; column++) {
    if (/\s/u.test(line.text[column]!)) continue;
    found = true;
    if (!line.spans.some((span) => span.from <= column && column < span.to && span.fg === ink)) return false;
  }
  return found;
}

function boxQuestion(line: StyledLine | undefined): boolean {
  return line !== undefined && QUESTION.test(line.text) && wholeRowInk(line, BOX_QUESTION_INK);
}

function boxOption(line: StyledLine | undefined): boolean {
  const radio = line === undefined ? null : OPTION.exec(line.text);
  if (line === undefined || radio === null) return false;
  return wholeRowInk(line, radio[1] === '○' ? BOX_UNSELECTED_INK : BOX_SELECTED_INK);
}

function liveFooter(line: StyledLine | undefined): boolean {
  return line !== undefined && !line.wrapped && FOOTER.test(line.text) &&
    wholeRowInk(line, BOX_FOOTER_INK, 2);
}

/** The complete, live radio set at the foot of a permission box. */
function liveOptions(lines: readonly StyledLine[], rows: readonly number[] | undefined): boolean {
  if (rows?.length !== 3 || rows.some((row, index) => row !== rows[0]! + index ||
    lines[row]?.text[5] !== String(index + 1) || !boxOption(lines[row]))) return false;
  if (rows.filter((row) => /^ {2}│ {2}[123] \([•●]\)/.test(lines[row]!.text)).length !== 1) return false;
  const after = rows[2]! + 1;
  return BLANK_BAR.test(lines[after]?.text ?? '') && liveFooter(lines[after + 1]) &&
    lines.slice(after + 2).every((line) => line.wrapped || line.text.trim() === '');
}

/** A visible question followed by a marked command and its complete live choices. */
function visibleCommandInterval(lines: readonly StyledLine[], index: number): boolean {
  let question = index;
  while (question > 0 && (BAR.test(lines[question - 1]!.text) || lines[question - 1]!.wrapped)) question--;
  for (; question <= index; question++) {
    if (!boxQuestion(lines[question])) continue;
    let firstOption = question + 1;
    while (firstOption < lines.length && !boxOption(lines[firstOption])) firstOption++;
    if (index >= firstOption || !liveOptions(lines, [firstOption, firstOption + 1, firstOption + 2])) continue;
    const run = lines.slice(question + 1, firstOption);
    if (!COMMAND_FIRST.test(run[0]?.text ?? '') ||
      run.some((line) => REASONING_START.test(line.text) || QUESTION_SHAPED.test(line.text) ||
        (!BAR.test(line.text) && !line.wrapped) ||
        (!BLANK_BAR.test(line.text) && !wholeRowInk(line, REASONING_INK, line.wrapped ? 0 : 5)))) continue;
    return true;
  }
  return false;
}

/** A command's first marker before literal redirection and live choices. */
function literalCommandStart(lines: readonly StyledLine[], index: number): boolean {
  if (!COMMAND_FIRST.test(lines[index]?.text ?? '') || !wholeRowInk(lines[index]!, REASONING_INK)) return false;
  let redirection = index + 1;
  while (redirection < lines.length && !LITERAL_REDIRECTION.test(lines[redirection]!.text)) {
    const line = lines[redirection]!;
    if ((!BAR.test(line.text) && !line.wrapped) || REASONING_START.test(line.text) ||
      QUESTION.test(line.text) || boxOption(line) ||
      (!BLANK_BAR.test(line.text) && !wholeRowInk(line, REASONING_INK, line.wrapped ? 0 : 5))) return false;
    redirection++;
  }
  if (redirection >= lines.length || !wholeRowInk(lines[redirection]!, REASONING_INK)) return false;
  return liveOptions(lines, [redirection + 1, redirection + 2, redirection + 3]);
}

/** An option after only box command rows, or the separately painted footer. */
function boxQuestionWithEvidence(lines: readonly StyledLine[], index: number): boolean {
  if (!boxQuestion(lines[index])) return false;
  if (liveFooter(lines[index + 1])) return true;
  for (let next = index + 1; next < lines.length; next++) {
    const line = lines[next]!;
    if (boxOption(line)) return true;
    if (!COMMAND.test(line.text) && !BLANK_BAR.test(line.text)) break;
  }
  return false;
}

function reasoningBar(lines: readonly StyledLine[], index: number): boolean {
  const line = lines[index];
  if (line === undefined || !BAR.test(line.text)) return false;
  if (visibleCommandInterval(lines, index)) return false;
  if (literalCommandStart(lines, index)) return false;
  if (line.text.trim() === '│') {
    let next = index + 1;
    while (lines[next]?.text.trim() === '') next++;
    if (boxQuestionWithEvidence(lines, next) || boxOption(lines[next])) return false;
  }
  const ink = textInk(line);
  if (ink === REASONING_INK || (ink !== null && REASONING_HEADING_INKS.has(ink))) return true;
  // Text shape and wrap flags cannot establish a box. Unrecognised colours,
  // including missing styles, always stay in the hidden block.
  return !boxQuestionWithEvidence(lines, index) && !boxOption(line);
}

export const readingRules: ReadingRules = {
  // A full-width repaint can set the next independently painted bar's wrap
  // flag. The bar itself establishes the row boundary.
  ownWrappedRow: (line) => BAR.test(line.text),
  startReasoning: (lines, index) => !BAR.test(lines[index]!.text) || reasoningBar(lines, index),
  continueReasoning: reasoningBar,
  claimPromptRows: (lines, prompt) => {
    const [first, last] = prompt.rows;
    const bars = lines.slice(first, last + 1);
    if (!bars.some((line) => BAR.test(line.text))) return null;

    // Claim the whole interval only when the question, complete options and
    // intervening command rows establish one box. Otherwise the box-inked
    // question and options stand alone while reasoning continues to hide.
    const question = lines.findIndex((line, index) => index >= first && index <= last && boxQuestion(line));
    if (lines.some((_, index) => literalCommandStart(lines, index))) return null;
    const options = prompt.optionRows?.filter((row) => row >= first && row <= last && boxOption(lines[row])) ?? [];
    if (question >= 0) {
      if (options.length !== 3 || prompt.optionRows?.length !== 3 ||
        options[0]! <= question ||
        options.some((row, index) => row !== options[0]! + index ||
          lines[row]!.text[5] !== String(index + 1)) ||
        options.filter((row) => /^ {2}│ {2}[123] \([•●]\)/.test(lines[row]!.text)).length !== 1 ||
        lines.slice(question + 1, options[0]).some((line) => !COMMAND.test(line.text) && !BLANK_BAR.test(line.text))) {
        return [question, question];
      }
      return [question, options[2]!];
    }
    if (liveOptions(lines, prompt.optionRows)) {
      const firstOption = prompt.optionRows![0]!;
      let above = firstOption - 1;
      while (above >= 0 && (BAR.test(lines[above]!.text) || lines[above]!.wrapped)) above--;
      const run = lines.slice(above + 1, firstOption);
      // The first command marker establishes a truncated box. A heading or
      // question in the run makes its boundary ambiguous, so claim nothing.
      if (COMMAND_FIRST.test(run[0]?.text ?? '') &&
        run.every((line) => !QUESTION_SHAPED.test(line.text) && !REASONING_START.test(line.text) &&
          (BAR.test(line.text) || line.wrapped) &&
          (BLANK_BAR.test(line.text) || wholeRowInk(line, REASONING_INK, line.wrapped ? 0 : 5)))) {
        return [above + 1, firstOption + 4];
      }
    }
    if (options.length > 0 && options.every((row, index) => row === options[0]! + index)) {
      return [options[0]!, options[options.length - 1]!];
    }
    return false;
  },
};
