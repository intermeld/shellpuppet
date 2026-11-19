import type { ReadingRules } from '../types.js';
import type { StyledLine } from '../../core/renderer.js';

const BAR = /^ {2}│/;
const QUESTION = /^ {2}│ {2}> {2}\S/;
const OPTION = /^ {2}│ {2}[123] \(([○•●])\) \S/;
const COMMAND = /^ {2}│ {2}[│:]/;
const BLANK_BAR = /^ {2}│\s*$/;
const FOOTER = /^ {2}[123]\/3:select(?:\s|$)/;

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
    if (options.length > 0 && options.every((row, index) => row === options[0]! + index)) {
      return [options[0]!, options[options.length - 1]!];
    }
    return false;
  },
};
