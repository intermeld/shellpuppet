/**
 * Permission-prompt detection over rendered screen text. An agent CLI
 * stuck on a permission prompt should raise an alert instead of waiting for
 * the next manual snapshot, because a prompt only serviced when a human or
 * manager happens to look costs tens of idle minutes per prompt.
 *
 * This is a HEURISTIC over untrusted screen content. It decides only whether
 * the screen LOOKS LIKE it is waiting on a human choice; it never decides the
 * answer. False negatives cost what the status quo already costs (a wait for
 * the next snapshot); false positives cost one spurious notification. Both
 * are acceptable, so the patterns favour the shapes real agent CLIs draw.
 *
 * Calibrated against real screens from three CLIs (the fixtures are
 * verbatim): Qoder (`❯` marker, tight option blocks), Codex (`›`/`>` markers,
 * LONG WRAPPED option text between numbered rows and `Press enter to
 * confirm or esc to cancel` footers) and Grok (radio rows `1 (○)` / `2 (•)`
 * inside a `│` box border, NO dot after the number; its folder-trust question
 * puts each option's key after it, `Yes, proceed   y`). It also reads
 * pointer-only choosers with unnumbered rows (inquirer.js, and Claude Code's
 * own folder-trust prompt), letter-keyed menus, `(Y)es/(N)o` and bracketed
 * letter lists, and the steps `@clack/prompts` draws for the scaffolding
 * wizards of create-vite, `sv create` and others: a select, a multi-select or
 * a confirm under a `◆` headline, or `▲` while the step shows a validation
 * error. MiMo Code's folder-trust question is a clack select too. Two rules
 * keep out FALSE positives: a numbered findings list an agent printed above
 * its composer, under a line that happens to end in a question mark; and a
 * message Claude Code echoes into its transcript or holds in its composer,
 * whose `❯` and aligned lines look like a pointer chooser under a question
 * from an earlier message.
 *
 * A permission dialog drawn with its choices as one row of buttons
 * (OpenCode, MiMo Code) is recognised by its signature (`dialogs.ts`),
 * which config can extend. Their numbered question menu is recognised by
 * its fixed controls and custom-answer choice here.
 */

import { dialogPrompt } from './dialogs.js';

export interface DetectedPrompt {
  /** Best-effort headline for the prompt (e.g. "Permission Required"). */
  question: string;
  /** The visible options, in screen order, markers stripped. */
  options: string[];
  /**
   * Stable identity for the prompt as currently drawn: the same prompt
   * redrawn (cursor blink, spinner elsewhere) keeps its signature, so a
   * stall timer can accumulate across scans without resetting.
   */
  signature: string;
  /**
   * The first and last raw line of the screen the prompt's own drawing
   * occupies: its question when one is found, its options, and what is
   * drawn between them. For Grok's older radio box, whose command is plain
   * bar text above the options, the span also takes that command when a
   * bare bar closes it off from the lines above. A reader that puts parts
   * of a screen aside (`reasoning.ts` hides reasoning) leaves these lines
   * alone: a filter must never hide a question. A wait result does not
   * carry this.
   */
  rows: [number, number];
  /**
   * Why the screen was called live. `question` means the only signal was a
   * question-shaped line with nothing drawn below the options. The reasoning
   * filter leaves such a span unclaimed when every row of it sits inside a
   * reasoning block that began above the question. A wait result does not
   * carry this.
   */
  basis: 'marker' | 'footer' | 'question' | 'frame';
}

/**
 * A numbered option row, in either of the two shapes real CLIs draw. Dot
 * form: `❯ 1. Allow once` / `› 1. Yes, proceed (y)` / `>1. Sign in
 * with ChatGPT` (Codex draws the sign-in marker TIGHT against the digit) /
 * `2. Don't trust and exit`. Radio form: `│  1 (○) Yes, and don't ask
 * again` / `│  2 (•) Yes, proceed` (Grok: box border, no dot, the radio IS
 * the selection state). The capture group is the option number, used to keep
 * wrap-interleaved rows in one block.
 */
const OPTION_ROW = /^\s*(?:│\s*)?(?:[❯›]\s*|>\s*)?(\d+)(?:\.\s+|\s+\([○•●]\)\s+)\S/;
/**
 * A letter-keyed row: `[Y] Yes`, `(a) Apply the change`,
 * optionally pointed. The capture is the key, used to keep a block to rows
 * with DISTINCT keys, because a markdown checkbox list repeats `[x]`.
 */
const LETTER_ROW = /^\s*(?:│\s*)?(?:[❯›]\s*|>\s*)?[[(]([a-z])[\])]\s+\S/i;
/**
 * An option with its key after it, as Grok's folder-trust question draws
 * them: `Yes, proceed        y`. The label, two or more spaces, then a single
 * letter ending the line. Captures indent, label and key.
 */
const KEY_HINT_ROW = /^(\s*)(\S.*?)\s{2,}([a-z])$/i;
/**
 * A pointer against plain text: `❯ npm`, `> minimal`. It is the
 * inquirer.js shape, and Claude Code's own folder-trust prompt. Captures
 * indent, pointer and text. `›` is deliberately absent: Codex draws it on
 * its composer line, and every `›` chooser seen so far numbers its rows.
 */
const POINTER_ROW = /^(\s*)([❯>])\s+(\S.*)$/;
/**
 * Focus markers TUIs draw on the selected option: `❯`/`›` anywhere,
 * line-leading `>` only before a numbered or letter-keyed row (tight or
 * spaced) or a FILLED radio `(•)`/`(●)`, Grok's selected-row marker.
 */
const MARKER_LINE = /[❯›]|^\s*(?:│\s*)?>\s*(?:\d+\.|[[(][a-z][\])])|\([•●]\)/i;
/**
 * A step headline as `@clack/prompts` draws it: the step glyph, two spaces,
 * the message. Only a step still waiting matches: `◆`, or `▲` while it shows
 * a validation error. Clack redraws a step `◇` once it is answered and `■`
 * once it is cancelled, and its log lines reuse the step glyphs
 * (`◆  Project created`), so a headline counts only with choice rows under it.
 * A step with no message of its own is the glyph alone: MiMo Code asks its
 * folder-trust question in a message it logs above such a step.
 */
const CLACK_HEADLINE = /^[◆▲](?: {2}(\S.*))?$/;
/** The first line of a message clack logs: `●  Accessing workspace:`. */
const CLACK_LOG = /^[●◆◇▲■] {2}(\S.*)$/;
/**
 * A choice row in the `│` gutter clack draws down the left of a step. A
 * select draws radios (`●` for the selected option, `○` for the rest), a
 * confirm draws both radios on one row (`● Yes / ○ No`) and a multi-select
 * draws checkboxes (`◼` checked, `◻` not). The focused checkbox differs only
 * in colour, which screen text does not carry.
 */
const CLACK_ROW = /^│ {2}[●○◻◼] \S/;
/** A line in clack's gutter: a choice row, wrapped text, a footer or the bare bar. */
const CLACK_GUTTER = /^│(?: |$)/;
/** The line that closes a clack step, which may carry a validation message. */
const CLACK_BAR_END = /^└(?: |$)/;
/**
 * The rest of a validation message, on the lines under the `└` that carries
 * it: clack indents them three spaces, to line up with the message. An input
 * box is not one, whatever its indent: neither its pointer (`❯ Ask
 * anything`) nor its border.
 */
const VALIDATION_REST = /^ {3}[^\s❯›>─-╿]/;
/**
 * Classic single-line confirmations: `Continue? (y/n)`, `Proceed [y/N]:`
 * and the spelled-out `(Y)es/(N)o` / `[Y]es / [N]o` forms.
 */
const YES_NO_TAIL =
  /(\(y\/n\)|\[y\/n\]|\(yes\/no\)|\(y\)es\s*[/,|]?\s*\(n\)o|\[y\]es\s*[/,|]?\s*\[n\]o)\s*:?\s*$/i;
/**
 * A bracketed letter list ending the line: `[y,n,q,a,d,e,?]?` as git's
 * hunk staging draws it, `(y/N/a)`. Only a list that offers both y and n
 * counts (see `isYesNo`): `(a/b)` in prose is a ratio, not a question.
 */
const LETTER_LIST_TAIL = /[[(]\s*([a-z?](?:\s*[/,|]\s*[a-z?])+)\s*[\])]\s*[?:]?\s*$/i;
/**
 * `Press enter to continue` / `…to confirm or esc to cancel`: the footer
 * both Codex prompt classes draw, and a wait state in its own right on the
 * onboarding screens that have no option list at all. `Enter to confirm ·
 * Esc to cancel`, without "press", is Claude Code's.
 */
const PRESS_ENTER = /(?:press\s+)?\benter to (confirm|continue|select)/i;
/**
 * Lines that mean the program is WORKING, not waiting. Spinner verbs with
 * their ellipsis only. A bare `esc to cancel` must NOT count as busy, since
 * Codex's `Press enter to confirm or esc to cancel` footer sits BELOW the
 * option block and would veto the very prompt it belongs to. `Waiting for
 * response…` is Grok's response spinner: it appears BELOW a just-answered
 * option block while the block is still in the tail, and without the veto
 * the stale block would go on alerting until it scrolled away. The ellipsis
 * is REQUIRED, matching the verbs: plain prose that happens to say
 * "waiting for response" must not veto a live prompt (a false negative here
 * is an unalerted stall, the costly direction). Claude Code's spinner is busy
 * whatever verb it shows: a spinner glyph at the start of the line, the verb
 * or the task in hand, the ellipsis and often the time so far
 * (`✻ Calculating… (14s · thinking)`). The line it leaves when a turn ends
 * has no ellipsis (`✻ Cooked for 19m 12s · done 20:31`).
 */
const BUSY_LINE =
  /(generating|thinking|running|working|waiting for response)(\.{3}|…)|^\s*[·✢✳✶✻✽*] [^…]+…(?: \(.*\))?\s*$/i;
/** Horizontal rules and box-drawing rows (U+2500 to U+257F) carry no text content. */
const RULE_LINE = /^[\s─-╿-]*$/;
/**
 * How far up from the bottom of the screen a live prompt can plausibly sit.
 * Codex's wrapped option text plus footers span a dozen lines on their own,
 * so this is generous. The busy veto below the block does the real work of
 * rejecting scrollback.
 */
const TAIL_WINDOW = 20;
/**
 * How many non-rule lines above the option block the question search may
 * inspect. Codex separates its `Would you like to run…?` headline from the
 * options with the full command text, so one line is not enough; the search
 * still only ACCEPTS question-shaped lines, so a bigger budget cannot
 * misattribute ordinary transcript text.
 */
const QUESTION_SEARCH_BUDGET = 8;
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

/** The fixed controls at the foot of OpenCode and MiMo Code's question menu. */
const QUESTION_MENU_FOOTER = /^ *┃ {2}↑↓ select {2}enter submit {2}esc dismiss\s*$/u;
const QUESTION_MENU_OPTION = /^ *┃ {2}([1-4])\. (\S.*)$/u;
const QUESTION_MENU_DESCRIPTION = /^ *┃ {5}\S/u;
const QUESTION_MENU_TEXT = /^ *┃ {2}(\S.*)$/u;
const QUESTION_MENU_BAR = /^ *┃\s*$/u;

interface Line {
  text: string;
  /** Index into the screen's raw lines, blank ones included. */
  index: number;
}

interface Row {
  line: Line;
  /** The option as the consumer sees it: markers stripped, whitespace normalised. */
  option: string;
}

interface Block {
  rows: Row[];
  /** How the rows were found; decides what else must frame them. */
  kind: 'numbered' | 'letter' | 'key-hint' | 'pointer';
}

function contentLines(raw: string[]): Line[] {
  return raw
    .map((text, index) => ({ text: text.trimEnd(), index }))
    .filter((line) => line.text.trim() !== '');
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripMarkers(text: string): string {
  return normalise(text.replace(/^[\s│❯›>]+/, ''));
}

/** A single-line confirmation tail. See YES_NO_TAIL and LETTER_LIST_TAIL. */
function isYesNo(text: string): boolean {
  if (YES_NO_TAIL.test(text)) return true;
  const list = LETTER_LIST_TAIL.exec(text);
  if (list === null) return false;
  const letters = (list[1] ?? '').toLowerCase().split(/[\s/,|]+/);
  return letters.includes('y') && letters.includes('n');
}

/**
 * Decide whether the screen is showing a prompt that waits on a human.
 * Returns null when the screen looks busy or shows no prompt shape.
 */
export function detectPrompt(screen: string): DetectedPrompt | null {
  const raw = screen.split('\n');
  const lines = contentLines(raw);
  if (lines.length === 0) return null;
  const tail = lines.slice(-TAIL_WINDOW);

  const questionMenu = openCodeQuestionMenu(raw, lines);
  if (questionMenu !== null) return questionMenu;

  // A dialog a program draws on its own screen, recognised by its signature
  // (`dialogs.ts`): the most specific test there is, so it goes first.
  const dialog = dialogPrompt(raw);
  if (dialog !== null) return dialog;

  // A clack step draws its own frame, and the frame alone says whether the
  // step is waiting.
  const clack = clackPrompt(tail, raw);
  if (clack !== null) return clack;

  // Four chooser shapes, most specific first. A block that is found but
  // not LIVE (a numbered list in the transcript, say) does not end the
  // search: the shapes below it, and the single-line tails after, may be.
  const blocks = [
    numberedBlock(tail),
    letterBlock(tail),
    keyHintBlock(tail),
    pointerBlock(tail, raw),
  ];
  for (const block of blocks) {
    if (block === null) continue;
    const prompt = livePrompt(block, tail, raw);
    if (prompt !== null) return prompt;
  }

  // No live option block: a y/n tail on the LAST content line is still a prompt.
  const last = lines[lines.length - 1]!;
  if (isYesNo(last.text) && !BUSY_LINE.test(last.text)) {
    const question = normalise(last.text);
    return { question, options: [], signature: question, rows: [last.index, last.index], basis: 'frame' };
  }

  // A bare press-enter wait (the Codex onboarding screens): the last content
  // line asks for enter and nothing below it can contradict that.
  if (PRESS_ENTER.test(last.text)) {
    const question = normalise(last.text);
    return { question, options: [], signature: question, rows: [last.index, last.index], basis: 'frame' };
  }

  return null;
}

/** A live left-ruled question menu with its fixed footer and custom-answer choice. */
function openCodeQuestionMenu(raw: string[], lines: Line[]): DetectedPrompt | null {
  const footer = [...lines].reverse().find((line) => QUESTION_MENU_FOOTER.test(line.text));
  if (footer === undefined) return null;
  const after = lines.filter((line) => line.index > footer.index);
  // The programme may draw a status line below the menu, but another input
  // box or a resumed transcript means this menu is no longer waiting.
  if (after.length > 2 || after.some((line) => BUSY_LINE.test(line.text) || /[╭╰│❯›]/u.test(line.text))) return null;

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
    signature: normalise(raw.slice(first, footer.index + 1).join(' ')),
    rows: [first, footer.index],
    basis: 'footer',
  };
}

/**
 * A clack step waiting on its answer: a `◆` or `▲` headline, choice rows in
 * the gutter under it and the `└` that closes the step. The headline alone
 * says whether the step waits, because clack redraws a step once it is
 * answered or cancelled. A waiting step is also the last thing drawn: anything
 * under its `└` means nothing is waiting on it, as when a wizard is killed with
 * its question still on screen and the shell's output follows, or when an agent
 * prints a step-shaped diagram above its own input box. Only the rest of a
 * validation message may sit there, directly under the `└` that carries it and
 * indented as clack indents it (VALIDATION_REST).
 */
function clackPrompt(tail: Line[], raw: string[]): DetectedPrompt | null {
  const text = (index: number): string => (raw[index] ?? '').trimEnd();
  let lastRow: Line | null = null;
  for (const line of tail) {
    if (CLACK_ROW.test(line.text)) lastRow = line;
  }
  if (lastRow === null) return null;

  // Up the gutter to the headline: every line of a step is in the gutter,
  // wrapped message and option text included.
  let top = lastRow.index;
  while (CLACK_GUTTER.test(text(top - 1))) top--;
  const headline = CLACK_HEADLINE.exec(text(top - 1));
  if (headline === null) return null;

  // Down past the footer to the `└`. On a narrow screen the terminal wraps
  // the end of the footer out of the gutter onto a line of its own.
  let end = lastRow.index + 1;
  while (text(end) !== '' && !CLACK_BAR_END.test(text(end))) end++;
  if (!CLACK_BAR_END.test(text(end))) return null;
  if (raw.slice(lastRow.index + 1).some((line) => BUSY_LINE.test(line))) return null;
  let after = end + 1;
  if (/^└ {2}\S/.test(text(end))) while (VALIDATION_REST.test(text(after))) after++;
  if (raw.slice(after).some((line) => line.trim() !== '')) return null;

  // The message runs from the headline down to the first row, less the
  // `...` clack draws where it has scrolled rows out of view. A step with no
  // message of its own is asked by the message logged just above it.
  const message = headline[1] === undefined ? loggedAbove(raw, top - 1) : [headline[1]];
  const options: string[] = [];
  let radios = 0;
  let selected = 0;
  for (let index = top; index <= lastRow.index; index++) {
    if (!CLACK_ROW.test(text(index))) {
      const wrapped = text(index).slice(1).trim();
      if (options.length === 0 && wrapped !== '...') message.push(wrapped);
      continue;
    }
    // A confirm draws both of its choices on one row.
    for (const choice of text(index).slice(3).split(/ \/ (?=[●○] )/)) {
      const glyph = choice.charAt(0);
      if (glyph === '●' || glyph === '○') radios++;
      if (glyph === '●') selected++;
      options.push(normalise(choice.slice(2)));
    }
  }
  // A select has exactly one option selected, and so has a confirm.
  if (radios > 0 && selected !== 1) return null;

  // What moves with the selection stays out of the signature: the glyphs,
  // and the hint clack draws in brackets beside the focused or checked row.
  const withoutHint = (option: string): string => option.replace(/ \(.*$/, '');
  const question = normalise(message.join(' ')) || withoutHint(options[0] ?? '');
  return {
    question,
    options,
    signature: [question, ...options.map(withoutHint)].join(' | '),
    // From the headline to the bar end, a validation message under it included.
    rows: [top - 1, after - 1],
    basis: 'frame',
  };
}

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

/**
 * Numbered option rows anywhere in the tail, wrap-tolerant: Codex wraps a
 * long option's text across several lines, so consecutive-row detection
 * would never see its blocks. Rows whose numbers never
 * DECREASE belong to one chooser; a decrease means a new list started and
 * only the newest can be live.
 */
function numberedBlock(tail: Line[]): Block | null {
  let rows: Row[] = [];
  let previousNumber = 0;
  for (const line of tail) {
    const match = OPTION_ROW.exec(line.text);
    if (match === null) continue;
    const number = Number(match[1]);
    if (number < previousNumber) rows = [];
    previousNumber = number;
    rows.push({ line, option: stripMarkers(line.text) });
  }
  return rows.length >= 2 ? { rows, kind: 'numbered' } : null;
}

/**
 * Letter-keyed rows: `[Y] Yes` / `[N] No` / `[A] Always`. One block is rows
 * with DISTINCT keys no more than a few lines apart; a repeated key (a
 * checkbox list's `[x]`, `[x]`) or a gap starts over, keeping the newest.
 */
function letterBlock(tail: Line[]): Block | null {
  let rows: Row[] = [];
  let keys = new Set<string>();
  let lastIndex = -1;
  for (const line of tail) {
    const match = LETTER_ROW.exec(line.text);
    if (match === null) continue;
    const key = (match[1] ?? '').toLowerCase();
    if ((lastIndex !== -1 && line.index - lastIndex > 3) || keys.has(key)) {
      rows = [];
      keys = new Set();
    }
    keys.add(key);
    lastIndex = line.index;
    rows.push({ line, option: stripMarkers(line.text) });
  }
  return rows.length >= 2 ? { rows, kind: 'letter' } : null;
}

/**
 * Options with their keys after them, on adjacent rows that share an indent
 * and a key column: Grok's folder-trust question. Plenty of ordinary lines
 * end in a single letter, so the block must look like a yes/no chooser: each
 * key is the first letter of its label, as a key hint is, and the keys offer
 * both y and n. A table of y/n flags fails the first test and a list of
 * keyboard shortcuts the second.
 */
function keyHintBlock(tail: Line[]): Block | null {
  let rows: Row[] = [];
  let keys: string[] = [];
  let layout = '';
  let lastIndex = -1;
  for (const line of tail) {
    const match = KEY_HINT_ROW.exec(line.text);
    if (match === null) continue;
    const label = match[2] ?? '';
    const key = (match[3] ?? '').toLowerCase();
    if (label.charAt(0).toLowerCase() !== key) continue;
    // Rows of one chooser line up on both the indent and the key's column.
    const indent = (match[1] ?? '').length;
    const keyColumn = line.text.length - 1;
    const lineLayout = `${String(indent)}:${String(keyColumn)}`;
    if (line.index !== lastIndex + 1 || lineLayout !== layout) {
      rows = [];
      keys = [];
    }
    layout = lineLayout;
    lastIndex = line.index;
    rows.push({ line, option: normalise(line.text) });
    keys.push(key);
  }
  return keys.includes('y') && keys.includes('n') ? { rows, kind: 'key-hint' } : null;
}

/**
 * A pointer against unnumbered rows: the LAST pointer row in the tail plus
 * the rows ADJACENT to it whose text starts in the same column. That is the
 * shape inquirer.js and Claude Code's folder-trust prompt draw. Adjacent
 * means adjacent: a blank line or a rule ends the block, which is what keeps
 * a composer line (`❯ Try "…"`) apart from the status lines drawn under its
 * rule. Claude Code's idle screen would otherwise read as a three-option
 * chooser.
 */
function pointerBlock(tail: Line[], raw: string[]): Block | null {
  let pointer: { line: Line; textCol: number } | null = null;
  for (const line of tail) {
    const match = POINTER_ROW.exec(line.text);
    if (match === null) continue;
    const text = match[3] ?? '';
    if (!/[\p{L}\p{N}]/u.test(text)) continue; // `│ >   │`: a box, not a choice
    pointer = { line, textCol: line.text.length - text.length };
  }
  if (pointer === null) return null;
  const { textCol } = pointer;

  const sibling = (index: number): Line | null => {
    const text = (raw[index] ?? '').trimEnd();
    if (text.length <= textCol) return null;
    if (text.slice(0, textCol).trim() !== '') return null;
    if (/\s/.test(text.charAt(textCol))) return null;
    if (POINTER_ROW.test(text)) return null;
    return { text, index };
  };
  const above: Line[] = [];
  for (let i = pointer.line.index - 1; i >= 0; i--) {
    const line = sibling(i);
    if (line === null) break;
    above.unshift(line);
  }
  const below: Line[] = [];
  for (let i = pointer.line.index + 1; i < raw.length; i++) {
    const line = sibling(i);
    if (line === null) break;
    below.push(line);
  }
  const all = [...above, pointer.line, ...below];
  if (all.length < 2) return null;
  return { rows: all.map((line) => ({ line, option: stripMarkers(line.text) })), kind: 'pointer' };
}

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

/**
 * Whether a block is a prompt the program is WAITING on, and if so the
 * prompt as the consumer should see it.
 */
function livePrompt(block: Block, tail: Line[], raw: string[]): DetectedPrompt | null {
  const { rows, kind } = block;
  const blockStart = rows[0]!.line.index;
  const blockEnd = rows[rows.length - 1]!.line.index;
  // The program drawing BUSY output below the options means it moved on:
  // the block is history. (The `Press enter…` footer below the block is
  // the opposite: it confirms the prompt is live.)
  const below = tail.filter((line) => line.index > blockEnd);
  if (below.some((line) => BUSY_LINE.test(line.text))) return null;

  const hasMarker = tail.some(
    (line) => line.index >= blockStart && line.index <= blockEnd && MARKER_LINE.test(line.text),
  );
  const hasPressEnter = below.some((line) => PRESS_ENTER.test(line.text));
  const nothingBelow = below.every((line) => RULE_LINE.test(line.text));
  // A question mark above the bare bar that closes an older Grok command is
  // reasoning. The command below that bar is claimed on its own, further down.
  const commandStart = commandAboveRadios(raw, blockStart);
  let question = findQuestion(tail, blockStart);
  if (question !== null && commandStart < blockStart && question.index < commandStart) question = null;

  let live: boolean;
  let basis: DetectedPrompt['basis'];
  if (kind === 'key-hint') {
    // The key hints are the block's own markers; the question above must
    // frame it.
    live = question !== null;
    basis = 'frame';
  } else if (kind === 'letter') {
    // Distinct letter keys are the block. The weak signal the filter
    // declines is a numbered list with nothing below it, which is also how
    // reasoning draws a list. A letter menu is not that.
    live = hasMarker || hasPressEnter || (question !== null && nothingBelow);
    basis = 'frame';
  } else if (kind === 'pointer') {
    // The pointer is the block's own marker, so it proves nothing by itself:
    // Claude Code draws the same `❯` on each message in its transcript and on
    // the draft in its composer. An enter-to-confirm footer below frames the
    // block, or a question drawn with it, directly above with no blank line
    // between, as inquirer draws it. A transcript sets each message apart
    // with a blank line, so a question above an echoed message belongs to an
    // earlier one. What follows the choices cannot decide: inquirer draws a
    // description of the focused choice and a key-help line there.
    live = hasPressEnter || (question !== null && drawnTogether(tail, question.index, blockStart));
    basis = hasPressEnter ? 'footer' : 'marker';
  } else if (hasMarker) {
    // A focused-option marker or a press-enter footer is the strongest
    // signal a selector is live. Without either, a question-shaped headline
    // counts only when the block ENDS the screen: a program blocked on a
    // choice draws nothing after its options, while an agent that has
    // finished a turn draws its composer under the numbered list it printed.
    live = true;
    basis = 'marker';
  } else if (hasPressEnter) {
    live = true;
    basis = 'footer';
  } else {
    live = question !== null && nothingBelow;
    basis = 'question';
  }
  if (!live) return null;

  const options = rows.map((row) => row.option);
  const headline = question?.text ?? options[0]!;
  // The signature must survive the selection MOVING (arrow keys flip which
  // radio is filled). The prompt is still the same prompt, and resetting
  // the stall clock on every selection change would let a held prompt
  // evade the threshold forever. Normalise filled radios to hollow in the
  // signature only; `options` keeps the live state for the consumer.
  const stable = (text: string): string => text.replace(/\([•●]\)/g, '(○)');
  // From the question, when one is found, down to the last option row:
  // what a program draws between the two belongs to the question too.
  // With no question, an older Grok box still owns the command text a bare
  // bar, or a reasoning start, closes off above its radios, when that text
  // carries command evidence.
  let start = question?.index ?? blockStart;
  if (question === null) start = Math.min(start, commandStart);
  return {
    question: headline,
    options,
    signature: [headline, ...options].map(stable).join(' | '),
    rows: [start, blockEnd],
    basis,
  };
}

/**
 * Whether the prompt on screen is the one the caller has ALREADY ANSWERED.
 * A supervision loop is wait-for-prompt → answer → wait, and the second wait
 * can look before the program has repainted; it must not return the
 * question just answered as a new one.
 *
 * The guard remembers the prompt showing when input was last written and
 * treats it as stale until an observation has seen the screen without it, or
 * with a different prompt. An observation is a wait tick, a snapshot or the
 * daemon's stall scan. So a prompt with the SAME text drawn later is
 * new only once the earlier one was seen to go; a program that ignored the
 * input keeps showing a stale prompt, and the wait says so rather than
 * guessing.
 */
export class StalePromptGuard {
  private signatureAtInput: string | null = null;
  private cleared = false;

  /** Input is being written; `screen` is what the program showed at that moment. */
  noteInput(screen: string): void {
    this.signatureAtInput = detectPrompt(screen)?.signature ?? null;
    this.cleared = false;
  }

  /** A look at the screen found this prompt (or none, when null). */
  observe(signature: string | null): void {
    if (this.signatureAtInput !== null && signature !== this.signatureAtInput) {
      this.cleared = true;
    }
  }

  /** True while `signature` is the answered prompt, not yet seen to go away. */
  isStale(signature: string): boolean {
    return this.signatureAtInput !== null && signature === this.signatureAtInput && !this.cleared;
  }
}

/**
 * A question-shaped line above the option block: skips rules and box borders,
 * accepts a line that asks something or names a request ("Permission
 * Required", "Allow this command to run?", "Do you trust…", "Would you
 * like…"). Codex puts the command text between the headline and the
 * options, so the search inspects up to QUESTION_SEARCH_BUDGET non-rule
 * lines. It only ever RETURNS a question-shaped line, so the budget cannot
 * misattribute ordinary transcript text. A question mark anywhere counts,
 * not only at the end: Claude Code's trust prompt asks "…one you trust?
 * (Like your own code…" and inquirer's `? Select a template: (Use arrow keys)`
 * leads with it. Returns the line, its text normalised.
 */
function findQuestion(tail: Line[], blockStart: number): Line | null {
  const above = tail.filter((line) => line.index < blockStart);
  let inspected = 0;
  for (let i = above.length - 1; i >= 0 && inspected < QUESTION_SEARCH_BUDGET; i--) {
    const line = above[i]!;
    if (RULE_LINE.test(line.text)) continue;
    inspected++;
    const cleaned = normalise(line.text);
    if (
      GROK_BOX_QUESTION.test(line.text) ||
      /\?/.test(cleaned) ||
      /permission required/i.test(cleaned) ||
      /^allow\b/i.test(cleaned) ||
      /do you trust/i.test(cleaned) ||
      /^would you like\b/i.test(cleaned)
    ) {
      return { text: cleaned, index: line.index };
    }
  }
  return null;
}

/**
 * Whether two lines are drawn together: every line between them has content.
 * Blank lines are the only lines between two lines of the tail that the tail
 * leaves out.
 */
function drawnTogether(tail: Line[], upper: number, lower: number): boolean {
  return tail.filter((line) => line.index > upper && line.index < lower).length === lower - upper - 1;
}
