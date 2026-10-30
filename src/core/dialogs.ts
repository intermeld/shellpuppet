/**
 * Permission dialogs that a TUI draws on its own screen, recognised by a
 * signature rather than by the shapes `promptDetector.ts` reads.
 *
 * Some agent CLIs ask for permission in a dialog drawn inside their own
 * interface: a title and the request, with the choices on ONE row, as buttons.
 * OpenCode draws `△ Permission required` with `Allow once   Always allow
 * Reject` under it, and MiMo Code, built from OpenCode, draws the same dialog
 * with `Allow always` in the middle, or with two choices.
 * None of the chooser shapes fits a row of buttons, and a heuristic loose
 * enough to read one would read every row of words two spaces apart.
 *
 * So a dialog is described as data: a pattern for its title and one for its
 * row of choices. A live dialog is drawn at the bottom of the screen, so the
 * row of choices is looked for among the last few lines with anything but
 * the dialog's own border on them, and the title in the lines above it. A
 * framed copy of the dialog near the end of the screen, with no more than
 * `below` lines of other text under it, is still read as one: it is the
 * same characters. The built-in list covers the programs above, and
 * requires the border they draw down the left of the dialog, which a diff, a
 * file listing or a transcript quoting the dialog's words does not
 * reproduce. Config `prompts.dialogs` adds more, so a new program's dialog
 * can be recognised without a release. A recognised dialog is a prompt like
 * any other: the session shows as waiting, `terminal_wait prompt:true`
 * returns it and the stall alert fires.
 *
 * Patterns are matched against one line at a time, so a pattern that does
 * not start with `^` matches anywhere in a line; OpenCode draws a sidebar on
 * the same rows as the dialog, after it. Each signature's search runs under
 * the regular-expression time budget (`regexBudget.ts`): a pattern from
 * config is text a person wrote, and one that runs past the budget is
 * reported and set aside for a minute (`SET_ASIDE_MS`) rather than tried on
 * every scan. It is tried again after that, built-in ones included, as an
 * agent signature is (`reasoning.ts`): an ordinary pattern can run past a
 * wall-clock budget once on a loaded machine.
 */

import { RegexBudgetError, SET_ASIDE_MS, withRegexBudget } from './regexBudget.js';
import type { DetectedPrompt } from './promptDetector.js';

/** One program's dialog, as data. The shape of a `prompts.dialogs` entry. */
export interface DialogSignature {
  /** Which program draws it, for the person reading the list. */
  name: string;
  /** A regular expression for the dialog's title, matched against one line. */
  title: string;
  /**
   * A regular expression for the row of choices, matched against one line
   * below the title. What it matches, less any leading border, split at runs
   * of two or more spaces, is the list of options.
   */
  choices: string;
  /** How many lines above the choices the title may sit. Default 40. */
  within?: number;
  /**
   * How many lines with anything but the dialog's border on them may sit
   * below the choices. Default 4.
   */
  below?: number;
}

export const DEFAULT_DIALOG_WITHIN = 40;
export const DEFAULT_DIALOG_BELOW = 4;
const MAX_DIALOG_WITHIN = 100;
const MAX_DIALOG_BELOW = 20;

/** Built-in signatures, checked before the chooser shapes. */
export const BUILT_IN_DIALOGS: readonly DialogSignature[] = [
  {
    // OpenCode offers three choices, the middle one "Always allow"; MiMo
    // Code, built from it, calls that one "Allow always", and leaves it out
    // when the command deletes files.
    name: 'OpenCode and MiMo Code',
    title: '^ *┃ +△ Permission required',
    choices: '^ *┃ +Allow once {2,}(?:(?:Always allow|Allow always) {2,})?Reject',
  },
];

interface CompiledDialog {
  name: string;
  source: string;
  title: RegExp;
  choices: RegExp;
  within: number;
  below: number;
  /**
   * When the signature last ran past its budget. It is set aside for
   * `SET_ASIDE_MS` after that, then tried again.
   */
  overBudgetAt: number | null;
  /** Whether it is one of `BUILT_IN_DIALOGS`, which no config can change. */
  builtIn: boolean;
}

function wholeNumber(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

/**
 * Compile signatures, setting aside any that cannot be used and saying why,
 * in words a person can act on. `builtIn` marks the list as `BUILT_IN_DIALOGS`.
 */
export function compileDialogs(list: readonly unknown[], builtIn = false): {
  dialogs: CompiledDialog[];
  problems: string[];
  /** The positions in `list` of the entries that compiled. */
  usable: number[];
} {
  const dialogs: CompiledDialog[] = [];
  const problems: string[] = [];
  const usable: number[] = [];
  list.forEach((entry, index) => {
    const at = `prompts.dialogs[${String(index)}]`;
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${at} must be an object with name, title and choices: ignored`);
      return;
    }
    const { name, title, choices, within, below } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name === '') {
      problems.push(`${at}.name must be a non-empty string: ignored`);
      return;
    }
    if (typeof title !== 'string' || title === '' || typeof choices !== 'string' || choices === '') {
      problems.push(`${at} (${name}) needs title and choices as non-empty regular expressions: ignored`);
      return;
    }
    if (within !== undefined && !wholeNumber(within, MAX_DIALOG_WITHIN)) {
      problems.push(`${at} (${name}).within must be a whole number from 1 to ${String(MAX_DIALOG_WITHIN)}: ignored`);
      return;
    }
    if (below !== undefined && !wholeNumber(below, MAX_DIALOG_BELOW) && below !== 0) {
      problems.push(`${at} (${name}).below must be a whole number from 0 to ${String(MAX_DIALOG_BELOW)}: ignored`);
      return;
    }
    try {
      dialogs.push({
        name,
        source: `${title} / ${choices}`,
        title: new RegExp(title, 'u'),
        choices: new RegExp(choices, 'u'),
        within: (within as number | undefined) ?? DEFAULT_DIALOG_WITHIN,
        below: (below as number | undefined) ?? DEFAULT_DIALOG_BELOW,
        overBudgetAt: null,
        builtIn,
      });
      usable.push(index);
    } catch (error) {
      problems.push(`${at} (${name}) has a pattern that does not compile (${String(error)}): ignored`);
    }
  });
  return { dialogs, problems, usable };
}

let active: CompiledDialog[] = compileDialogs(BUILT_IN_DIALOGS, true).dialogs;
let reportOverBudget: (name: string, builtIn: boolean) => void = () => undefined;

/**
 * Recognise the built-in dialogs plus `extra`, the entries from config, and
 * name the one to tell, with whether the signature is built in, when a
 * signature runs past its budget (the daemon logs it). Returns what was wrong
 * with `extra`; the entries that are fine are used.
 */
export function useDialogSignatures(
  extra: readonly unknown[],
  onOverBudget: (name: string, builtIn: boolean) => void = () => undefined,
): string[] {
  const builtIn = compileDialogs(BUILT_IN_DIALOGS, true).dialogs;
  const { dialogs, problems } = compileDialogs(extra);
  active = [...builtIn, ...dialogs];
  reportOverBudget = onOverBudget;
  return problems;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Leading whitespace and box-drawing borders (U+2500 to U+257F). */
const LEADING_BORDER = /^[\s─-╿]+/u;

/** A recognised dialog on screen, or null. `now` is the time of the scan. */
export function dialogPrompt(
  raw: readonly string[],
  dialogs: readonly CompiledDialog[] = active,
  now: number = Date.now(),
): DetectedPrompt | null {
  for (const dialog of dialogs) {
    if (dialog.overBudgetAt !== null && now - dialog.overBudgetAt < SET_ASIDE_MS) continue;
    let found: DetectedPrompt | null = null;
    try {
      found = withRegexBudget(dialog.source, () => matchDialog(raw, dialog));
    } catch (error) {
      if (!(error instanceof RegexBudgetError)) throw error;
      // Set aside rather than tried on every scan, and reported each time it
      // trips: a person reading daemon.log sees whether a signature keeps
      // running long or tripped once under load.
      dialog.overBudgetAt = now;
      reportOverBudget(dialog.name, dialog.builtIn);
    }
    if (found !== null) return found;
  }
  return null;
}

/** Text that is not whitespace or box drawing. */
const TEXT = /[^\s─-╿]/u;

/** How many rows of bare border, at most, may sit under the choices besides `below`. */
const MAX_BORDER_ROWS = 10;

function matchDialog(raw: readonly string[], dialog: CompiledDialog): DetectedPrompt | null {
  const content: number[] = [];
  raw.forEach((line, index) => {
    if (line.trim() !== '') content.push(index);
  });
  // The row of choices of a live dialog is near the bottom: at most `below`
  // lines with content under it. A row that holds nothing but the dialog's
  // own border is not counted: a narrow screen can put a wrapped key hint, a
  // status line and a bare border row under the buttons. A row of choices
  // with no title above it in reach is not a dialog, and the next one up is
  // tried.
  for (let i = content.length - 1; i >= Math.max(0, content.length - dialog.below - 1 - MAX_BORDER_ROWS); i--) {
    const c = content[i]!;
    const bottom = dialog.choices.exec(raw[c] ?? '');
    if (bottom === null) continue;
    const lead = (raw[c] ?? '').slice(0, bottom.index + Math.max(0, bottom[0].search(TEXT)));
    const border = new Set(lead.replace(/[^─-╿]/gu, ''));
    const under = content
      .slice(i + 1)
      .filter((u) => [...(raw[u] ?? '').replace(/\s/gu, '')].some((ch) => !border.has(ch)));
    if (under.length > dialog.below) continue;
    // The nearest title above: a copy of the title further down the screen
    // is not this dialog's.
    for (let t = c - 1; t >= Math.max(0, c - dialog.within); t--) {
      const titleLine = raw[t] ?? '';
      const title = dialog.title.exec(titleLine);
      if (title === null) continue;
      const titleText = title[0].replace(LEADING_BORDER, '');
      const question = normalise(titleText.replace(/^[^\p{L}\p{N}]+/u, ''));
      const options = bottom[0].replace(LEADING_BORDER, '').trim().split(/\s{2,}/);
      // The border the dialog draws down its left: the box drawing in front
      // of the title's text.
      const frame = [...new Set(titleLine.slice(0, title.index + title[0].length - titleText.length))].filter(
        (ch) => /[─-╿]/u.test(ch),
      );
      const request = requestText(raw.slice(t + 1, c), frame);
      return {
        question,
        options,
        signature: [dialog.name, question, request, ...options].join(' | '),
        // The title down to the row of choices, the request between them included.
        rows: [t, c],
      };
    }
  }
  return null;
}

/**
 * What the dialog asks about: the text of every row between its title and
 * its choices, each without the dialog's own border in front of it (`frame`,
 * the box drawing in front of the title), with each run of whitespace as one
 * space. Other box drawing is text: a `─` that a wrap leaves at the start of
 * a row is part of the request. It keeps two requests apart that draw the
 * same title and buttons, so answering one does not mark the next as already
 * answered.
 *
 * Nothing between the title and the choices is left out, a sidebar drawn on
 * the same rows included. Leaving text out is what can make two different
 * requests one signature, and then the second is taken as already answered
 * and a wait for a prompt never returns it. The cost runs the other way and
 * is milder: a resize, or a change in text drawn beside the dialog, makes the
 * same dialog a new signature, so the stall alert's clock starts again, and
 * a dialog just answered may be offered once more if that happens before it
 * closes. A request the program wraps at a word boundary keeps its signature
 * at any width when nothing is drawn beside it.
 */
function requestText(rows: readonly string[], frame: readonly string[]): string {
  const border = new RegExp(`^[\\s${frame.join('')}]+`, 'u');
  return normalise(rows.map((line) => line.replace(border, '')).join(' '));
}
