import type { DetectedPrompt } from '../../core/promptDetector.js';
import type { PromptLine as Line, PromptShape } from '../types.js';
import { normalise } from '../../core/promptText.js';

import type { DialogSignature } from '../../core/dialogs.js';
import type { StyledLine } from '../../core/renderer.js';

/** The fixed controls at the foot of OpenCode and MiMo Code's question menu. */
const QUESTION_MENU_FOOTER = /^ *┃ {2}↑↓ select {2}enter submit {2}esc dismiss\s*$/u;
const QUESTION_MENU_HEADER = /^ *┃ {2}Questions\s*$/u;
const QUESTION_MENU_OPTION = /^ *┃ {2}([1-4])\. (\S.*)$/u;
const QUESTION_MENU_DESCRIPTION = /^ *┃ {5}\S/u;
const QUESTION_MENU_TEXT = /^ *┃ {2}(\S.*)$/u;
const QUESTION_MENU_BAR = /^ *┃\s*$/u;

/** Cheap text gate for the styled clipped-panel rule. Descriptions may separate choices. */
export function hasClippedQuestionShape(raw: readonly string[], viewportRows?: number): boolean {
  const last = raw.length - 1;
  if (viewportRows !== undefined && raw.length !== viewportRows) return false;
  // The live panel's gutter is at cell two. An ordinary MiMo composer or
  // transcript cannot end in a clipped panel without that bottom-row gutter.
  const bottom = raw[last] ?? '';
  const marker = '⟦SP:selected⟧ ';
  const offset = bottom.startsWith(marker) ? marker.length : 0;
  if (bottom.charCodeAt(offset + 2) !== 0x2503 || bottom.charCodeAt(offset + 3) !== 0x20 ||
      bottom.charCodeAt(offset + 4) !== 0x20) return false;
  const line = (row: number): string => (raw[row] ?? '').replace(/^⟦SP:selected⟧ /u, '');
  if (!QUESTION_MENU_OPTION.test(line(last)) && !QUESTION_MENU_DESCRIPTION.test(line(last))) return false;
  let header = last - 1;
  while (header >= 0 && !QUESTION_MENU_HEADER.test(line(header))) header--;
  if (header < 1 || !QUESTION_MENU_BAR.test(line(header - 1)) || !QUESTION_MENU_BAR.test(line(header + 1))) return false;
  let questionEnd = header + 2;
  while (questionEnd < last && !QUESTION_MENU_BAR.test(line(questionEnd))) questionEnd++;
  if (questionEnd === header + 2 || questionEnd >= last) return false;
  let nextChoice = 1;
  for (let row = questionEnd + 1; row <= last; row++) {
    const choice = QUESTION_MENU_OPTION.exec(line(row));
    if (choice !== null) {
      if (Number(choice[1]) !== nextChoice++) return false;
    } else if (nextChoice === 1 || !QUESTION_MENU_DESCRIPTION.test(line(row))) return false;
  }
  return nextChoice >= 3;
}

/** OpenCode 2.2.5 draws the live menu on this panel, unlike its blue composer gutter. */
function panelStyle(line: StyledLine | undefined, from: number, to: number, colours: readonly string[]): boolean {
  if (line === undefined || to > line.text.length) return false;
  return Array.from({ length: to - from }, (_, offset) => line.spans.find(span =>
    span.from <= from + offset && span.to > from + offset)).every(span =>
    span !== undefined && span.bg === '#141414' && colours.includes(span.fg ?? '') &&
    !span.bold && !span.dim && !span.italic && !span.inverse);
}

function livePanelRow(raw: string, line: StyledLine | undefined, kind: 'bar' | 'header' | 'question' | 'option' | 'description'): boolean {
  const text = raw.trimEnd();
  if (line?.text !== text || !panelStyle(line, 2, 3, ['#fab283'])) return false;
  if (kind === 'bar') return true;
  const start = kind === 'description' ? 8 : 5;
  if (kind === 'option') {
    return (panelStyle(line, 5, 8, ['#fab283']) && panelStyle(line, 8, text.length, ['#fab283'])) ||
      (panelStyle(line, 5, 8, ['#808080']) && panelStyle(line, 8, text.length, ['#eeeeee']));
  }
  return panelStyle(line, start, text.length, kind === 'header' || kind === 'description' ? ['#808080'] : ['#eeeeee']);
}

/** A menu taller than the viewport has no footer or custom-answer row on screen. */
function clippedQuestionMenu(raw: string[], busy: (text: string) => boolean, viewportRows?: number, styled?: readonly StyledLine[]): DetectedPrompt | null {
  const last = raw.length - 1;
  if (!hasClippedQuestionShape(raw, viewportRows)) return null;

  let header = last - 1;
  while (header >= 0 && !QUESTION_MENU_HEADER.test(raw[header] ?? '')) header--;
  if (header < 1 || !QUESTION_MENU_BAR.test(raw[header - 1] ?? '') || !QUESTION_MENU_BAR.test(raw[header + 1] ?? '')) return null;
  if (styled?.length !== raw.length || !livePanelRow(raw[header]!, styled[header], 'header') ||
      !livePanelRow(raw[header - 1]!, styled[header - 1], 'bar') ||
      !livePanelRow(raw[header + 1]!, styled[header + 1], 'bar')) return null;
  // Earlier transcript and idle chrome can remain above a live panel.
  if (raw.slice(0, header).some((line) =>
    busy(line) || /\besc interrupt\b|^ {3,}[⠀-⣿] |^ {3,}\+ Thought\s*$|^ {5}▣ {2}\S/iu.test(line))) return null;

  const question: string[] = [];
  let cursor = header + 2;
  while (cursor < last && !QUESTION_MENU_BAR.test(raw[cursor] ?? '')) {
    const text = QUESTION_MENU_TEXT.exec(raw[cursor] ?? '');
    if (text === null || QUESTION_MENU_OPTION.test(raw[cursor] ?? '') ||
        !livePanelRow(raw[cursor]!, styled[cursor], 'question')) return null;
    question.push(text[1]!);
    cursor++;
  }
  if (question.length === 0 || cursor >= last) return null;
  if (!livePanelRow(raw[cursor]!, styled[cursor], 'bar')) return null;
  cursor++;

  const options: string[] = [];
  const optionRows: number[] = [];
  for (; cursor <= last; cursor++) {
    const line = raw[cursor] ?? '';
    const option = QUESTION_MENU_OPTION.exec(line);
    if (option !== null) {
      if (Number(option[1]) !== options.length + 1 || options.length === 4) return null;
      if (!livePanelRow(line, styled[cursor], 'option')) return null;
      options.push(normalise(option[2]!));
      optionRows.push(cursor);
    } else if (options.length === 0 || !QUESTION_MENU_DESCRIPTION.test(line) ||
               !livePanelRow(line, styled[cursor], 'description')) {
      return null;
    }
  }
  if (options.length < 2 || options.at(-1) === 'Type your own answer') return null;
  return {
    question: normalise(question.join(' ')),
    options,
    optionRows,
    signature: normalise(raw.slice(header, last + 1).join(' ')),
    rows: [header, last],
    basis: 'frame',
  };
}

/** A live left-ruled question menu with its fixed footer and custom-answer choice. */
function openCodeQuestionMenu(raw: string[], lines: Line[], busy: (text: string) => boolean, viewportRows?: number, styled?: readonly StyledLine[]): DetectedPrompt | null {
  const clipped = clippedQuestionMenu(raw, busy, viewportRows, styled);
  if (clipped !== null) return clipped;
  const footer = [...lines].reverse().find((line) => QUESTION_MENU_FOOTER.test(line.text));
  if (footer === undefined) return null;
  const after = lines.filter((line) => line.index > footer.index);
  // The programme may draw a status line below the menu, but another input
  // box or a resumed transcript means this menu is no longer waiting.
  if (after.length > 2 || after.some((line) => busy(line.text) || /[╭╰│❯›]/u.test(line.text))) return null;

  let cursor = footer.index - 1;
  while (QUESTION_MENU_BAR.test(raw[cursor] ?? '')) cursor--;
  const options: string[] = [];
  for (let count = 0; count < 4 && cursor >= 0; count++) {
    while (QUESTION_MENU_DESCRIPTION.test(raw[cursor] ?? '')) cursor--;
    const row = QUESTION_MENU_OPTION.exec(raw[cursor] ?? '');
    if (row === null) break;
    options.unshift(row[2]!);
    cursor--;
  }
  // The walk above collects option rows from the bottom. Their numbers must
  // be consecutive, with the final row offering the custom answer.
  if (options.length < 2 || options.length > 4 || options.at(-1) !== 'Type your own answer') return null;
  const firstOption = cursor + 1;
  const numbered = raw.slice(firstOption, footer.index).map((line) => QUESTION_MENU_OPTION.exec(line)?.[1]);
  if (numbered.filter((value) => value !== undefined).join(',') !== options.map((_, i) => String(i + 1)).join(',')) return null;
  if (!QUESTION_MENU_BAR.test(raw[cursor] ?? '')) return null;
  while (QUESTION_MENU_BAR.test(raw[cursor] ?? '')) cursor--;
  const question: string[] = [];
  while (cursor >= 0 && question.length < 8) {
    const row = QUESTION_MENU_TEXT.exec(raw[cursor] ?? '');
    if (row === null || QUESTION_MENU_OPTION.test(raw[cursor] ?? '')) break;
    question.unshift(row[1]!);
    cursor--;
  }
  if (question.length === 0) return null;
  const first = cursor + 1;
  return {
    question: normalise(question.join(' ')),
    options,
    optionRows: raw.slice(firstOption, footer.index).map((line, index) => QUESTION_MENU_OPTION.test(line) ? firstOption + index : -1).filter((index) => index >= 0),
    signature: normalise(raw.slice(first, footer.index + 1).join(' ')),
    rows: [first, footer.index],
    basis: 'footer',
  };
}

export const permissionDialog: DialogSignature = {
    // OpenCode offers three choices, the middle one "Always allow"; MiMo
    // Code, built from it, calls that one "Allow always", and leaves it out
    // when the command deletes files.
    name: 'OpenCode and MiMo Code',
    title: '^ *┃ +△ Permission required',
    choices: '^ *┃ +Allow once {2,}(?:(?:Always allow|Allow always) {2,})?Reject',
  };

export const prompts: PromptShape[] = [
  { kind: 'menu', order: 1, detect: (raw, lines, _tail, busy, viewportRows, styled) => openCodeQuestionMenu(raw, lines, busy, viewportRows, styled) },
  { kind: 'dialog', signature: permissionDialog },
];
