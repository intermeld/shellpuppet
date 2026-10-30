/**
 * Locate the echo of typed input on a rendered screen.
 *
 * `echoEnd` is the guard behind `matchAfterInput`; `screenShows` is the
 * check behind `terminal_type`'s verify.
 *
 * A text or regex wait that describes
 * the program's expected OUTPUT matches the echo of the caller's own input
 * first, within a millisecond, because the natural thing to wait for is
 * exactly what you asked the program to produce (`PY_FILES\s*=` matches a
 * submitted prompt that mentions it). Ignoring matches at or before the echo
 * removes the class instead of restating the warning in prose.
 *
 * Pure function; no I/O.
 */

/** How much of the input's printable head to look for. */
const NEEDLE_MAX_CHARS = 60;
/** Shorter than this is not distinctive enough to place on a screen. */
const NEEDLE_MIN_CHARS = 3;

/**
 * Offset in `screen` just past the LAST occurrence of the echo of `input`,
 * or null when no echo can be placed: control-only input (a bare Enter, an
 * arrow key), a printable head too short to be distinctive or a screen
 * that does not show it (hidden input, scrolled away, re-rendered beyond
 * recognition).
 *
 * Whitespace and box-drawing characters are ignored on both sides because
 * TUIs re-wrap a submitted prompt across rows with their own indentation
 * and border (`│ > the prompt…` / `│   continued`), the same reason
 * `screenShows` ignores them. The LAST occurrence is the
 * echo because it is the most recent rendering of that text: a transcript
 * shows the submitted prompt once, and anything printed before it is
 * history.
 */
export function echoEnd(screen: string, input: string): number | null {
  const needle = squash(printableHead(input)).slice(0, NEEDLE_MAX_CHARS);
  if (needle.length < NEEDLE_MIN_CHARS) return null;

  // Squash the screen the same way, keeping a map back to original offsets.
  const kept: number[] = [];
  let squashed = '';
  for (let i = 0; i < screen.length; i++) {
    const ch = screen[i] ?? '';
    if (CHROME.test(ch)) continue;
    squashed += ch;
    kept.push(i);
  }
  const at = squashed.lastIndexOf(needle);
  if (at === -1) return null;
  return (kept[at + needle.length - 1] ?? 0) + 1;
}

/**
 * Whether `text` is on `screen`, read the way a TUI draws typed text: wrapped
 * at the width of its input box. Whitespace is ignored on both sides, so a
 * line break or a continuation indent inside the text does not hide it.
 *
 * An input box may also draw a border down its edges (OpenCode's `┃` on the
 * left, Grok's `│` on the right) and a side panel on the same rows (OpenCode
 * on a wide screen), and both land between the wrapped pieces. So the rows are
 * also read one at a time. A row's part of the text ends:
 * - at the end of the row, or before a border that closes it;
 * - or before a gap of at least two spaces that leads to more text: a panel
 *   set apart by space. A single space, or box drawing after the gap, is
 *   part of what the row shows (a table's columns, two panes), not the end of
 *   the box.
 *
 * The text then carries on at the start of the next row, after its border and
 * an indent of at most MAX_INDENT spaces. Box drawing anywhere else is text:
 * typed box drawing must be on screen.
 *
 * A gap of two spaces cannot tell a side panel from a table's next column, so
 * what was already on screen must not make up the typed text's wrapped
 * pieces: `before` is the screen as it was just before the text was typed,
 * and each row's piece must be new where it stands: at least one of its
 * characters is new there, or text that stood just after it is gone (typed
 * text replacing a placeholder that began with the same word). Typed text
 * does one or the other where it lands; a table whose clock ticks, an earlier
 * message beside a changing panel or a panel's labels do neither. With no
 * `before`, everything counts as new. What this cannot tell
 * apart is new output elsewhere that happens to hold the same words at the
 * ends of its rows, such as old lines scrolling up. The plain check above,
 * whitespace ignored across the whole screen, reads every row, as it always
 * has.
 *
 * Reading the rows costs a few characters per place the text could start.
 * A screen built against the text (its first character everywhere, with gaps)
 * could make it far more, and the daemon reads the screen on its event loop,
 * so the reading stops after MAX_STEPS characters and says the text is not
 * there.
 */
export function screenShows(screen: string, text: string, before = ''): boolean {
  const needle = text.replace(/\s+/g, '');
  if (needle === '') return true;
  if (screen.replace(/\s+/g, '').includes(needle)) return true;
  // Every character the text needs must be on screen somewhere.
  for (const ch of new Set(needle)) if (!screen.includes(ch)) return false;

  const lines = screen.split('\n');
  const wrapped: Wrapped = {
    lines,
    earlier: before.split('\n'),
    rows: new Map(),
    needle,
    failed: new Uint8Array((lines.length + 1) * (needle.length + 1)),
    steps: 0,
  };
  const first = needle.charAt(0);
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? '';
    if (line === wrapped.earlier[row]) continue;
    for (let col = line.indexOf(first); col !== -1; col = line.indexOf(first, col + 1)) {
      if (wrappedMatch(wrapped, row, col, 0)) return true;
      if (wrapped.steps > MAX_STEPS) return false;
    }
  }
  return false;
}

/** The widest indent after a continuation row's border. */
const MAX_INDENT = 4;
/** How many characters `screenShows` reads row by row before it gives up. */
const MAX_STEPS = 1_000_000;

interface Wrapped {
  lines: string[];
  /** The screen's rows before the text was typed: a row still the same is not read. */
  earlier: string[];
  /** Each row's layout, worked out the first time the row is read. */
  rows: Map<number, RowLayout>;
  needle: string;
  /** Continuations already tried and failed: 1 at `row * (needle.length + 1) + matched`. */
  failed: Uint8Array;
  /** Characters read so far, against MAX_STEPS. */
  steps: number;
}

interface RowLayout {
  line: string;
  /** Per character: whitespace. */
  space: Uint8Array;
  /** Where the row's text starts, past its border and indent. */
  start: number;
  /** Spaces between the row's last leading box-drawing character (or the row's start) and its text. */
  indent: number;
  /** Where the row's text ends, before trailing spaces and a closing border. */
  end: number;
}

function layout(wrapped: Wrapped, row: number): RowLayout | null {
  const known = wrapped.rows.get(row);
  if (known !== undefined) return known;
  const line = wrapped.lines[row];
  if (line === undefined || line === wrapped.earlier[row]) return null;
  const space = new Uint8Array(line.length);
  const box = new Uint8Array(line.length);
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (/\s/.test(ch)) space[i] = 1;
    else if (BOX.test(ch)) box[i] = 1;
  }
  let start = 0;
  let indent = 0;
  for (; start < line.length && (space[start] === 1 || box[start] === 1); start++) {
    indent = box[start] === 1 ? 0 : indent + 1;
  }
  let end = line.length;
  while (end > start && (space[end - 1] === 1 || box[end - 1] === 1)) end--;
  const found: RowLayout = { line, space, start, indent, end };
  wrapped.rows.set(row, found);
  return found;
}

/**
 * Match the rest of the needle, from `matched` on, starting at
 * `rows[row][col]`. Where the row's part of the text may end (see
 * `screenShows`), both readings are tried: carry on along the row, or carry
 * on at the start of the next one. A row the match carries on to must add to
 * it, starting with its first character, and each row's piece must be new
 * where it stands (see `screenShows`).
 */
function wrappedMatch(wrapped: Wrapped, row: number, col: number, matched: number): boolean {
  const found = layout(wrapped, row);
  if (found === null) return false;
  const { line, space, end } = found;
  const { needle } = wrapped;
  const earlier = wrapped.earlier[row] ?? '';
  let added = false;
  // Whether a character of this row's piece is new where it stands.
  let fresh = false;
  let pieceEnd = col;
  let gap = 0;
  // A piece whose characters all stood there before is still new when text
  // that stood just after it, up to `to`, is gone: typed text replacing a
  // placeholder that began with the same word.
  const isNew = (to: number): boolean => fresh || vacated(line, space, earlier, pieceEnd, to);
  for (let c = col; c < end; c++) {
    if (++wrapped.steps > MAX_STEPS) return false;
    if (space[c] === 1) {
      gap++;
      continue;
    }
    const ch = line.charAt(c);
    if (gap >= 2 && added && !BOX.test(ch) && isNew(c) && continuesBelow(wrapped, row, matched)) return true;
    if (ch !== needle.charAt(matched)) return false;
    matched++;
    added = true;
    if (earlier.charAt(c) !== ch) fresh = true;
    pieceEnd = c + 1;
    gap = 0;
    if (matched === needle.length) {
      let next = pieceEnd;
      while (next < line.length && space[next] === 1) next++;
      return isNew(next < line.length ? next : Math.max(line.length, earlier.length));
    }
  }
  return added && isNew(Math.max(line.length, earlier.length)) && continuesBelow(wrapped, row, matched);
}

/** Whether `earlier` had text at a position from `from` to `to` that is blank in `line` now. */
function vacated(line: string, space: Uint8Array, earlier: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const was = earlier.charAt(i);
    if (was === '' || /\s/.test(was)) continue;
    if (i >= line.length || space[i] === 1) return true;
  }
  return false;
}

/** Whether the needle carries on from `matched` at the start of the row below. */
function continuesBelow(wrapped: Wrapped, row: number, matched: number): boolean {
  const key = (row + 1) * (wrapped.needle.length + 1) + matched;
  if (wrapped.failed[key] === 1) return false;
  const below = layout(wrapped, row + 1);
  if (below !== null && below.indent <= MAX_INDENT && wrappedMatch(wrapped, row + 1, below.start, matched)) {
    return true;
  }
  wrapped.failed[key] = 1;
  return false;
}

/** The first run of printable text in the input, escape sequences removed. */
function printableHead(input: string): string {
  const stripped = input.replace(
    // CSI (arrows, function keys, modes), SS3 and any other two-byte escape.
    // eslint-disable-next-line no-control-regex
    /\x1b(\[[0-9;?<>=]*[@-~]|O[A-Za-z]|.)/g,
    '',
  );
  // eslint-disable-next-line no-control-regex
  const runs = stripped.split(/[\x00-\x1f\x7f]+/).filter((run) => run.trim() !== '');
  return runs[0] ?? '';
}

/** Whitespace and the box-drawing block (U+2500 to U+257F): layout, not text. */
const CHROME = /[\s─-╿]/;
/** The box-drawing block alone. */
const BOX = /[─-╿]/;

function squash(value: string): string {
  return value.replace(/[\s─-╿]+/g, '');
}
