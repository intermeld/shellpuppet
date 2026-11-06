import type { DetectedPrompt } from '../../core/promptDetector.js';
import type { PromptLine as Line, PromptShape } from '../types.js';
import { normalise } from '../../core/promptText.js';

import type { DialogSignature } from '../../core/dialogs.js';

/** The fixed controls at the foot of OpenCode and MiMo Code's question menu. */
const QUESTION_MENU_FOOTER = /^ *┃ {2}↑↓ select {2}enter submit {2}esc dismiss\s*$/u;
const QUESTION_MENU_OPTION = /^ *┃ {2}([1-4])\. (\S.*)$/u;
const QUESTION_MENU_DESCRIPTION = /^ *┃ {5}\S/u;
const QUESTION_MENU_TEXT = /^ *┃ {2}(\S.*)$/u;
const QUESTION_MENU_BAR = /^ *┃\s*$/u;

/** A live left-ruled question menu with its fixed footer and custom-answer choice. */
function openCodeQuestionMenu(raw: string[], lines: Line[], busy: (text: string) => boolean): DetectedPrompt | null {
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
  { kind: 'menu', order: 1, detect: (raw, lines, _tail, busy) => openCodeQuestionMenu(raw, lines, busy) },
  { kind: 'dialog', signature: permissionDialog },
];
