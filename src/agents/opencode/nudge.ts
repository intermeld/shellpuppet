import type { StyledLine } from '../../core/renderer.js';
import type { CursorPosition } from '../../core/types.js';
import { barFrame } from '../barNudge.js';
import { onlyBlankRowsAfter } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';

const FOLDER = String.raw`(?:[A-Za-z]:[\\/]|[\\/~]|…|\.\.?[\\/])`;
const CONTROLS = String.raw`(shift\+tab agents|\d+(?:\.\d+)?[KMB]? \(\d+%\)(?: · \$\d+(?:\.\d+)?)?) {2}ctrl\+p commands`;
const FOOTER = new RegExp(String.raw`^${FOLDER}.*? {2,}${CONTROLS}$`, 'u');
const SIDEBAR_FOLDER = new RegExp(String.raw`^ {4}${FOLDER}`, 'u');
const BUSY_FOOTER = new RegExp(String.raw`^[⬝■]{8} esc interrupt {2,}${CONTROLS}$`, 'u');
const BUSY_TAB = /^ {3}.*[⠀-⣿] \S.* {2,}\+\s*$/u;
const WELCOME_VERSION = /^(?: {2}⊙ \d+ MCP(?: failed)? \/mcps)? {2,}\d+\.\d+\.\d+$/u;
const SUGGESTION = /^Ask anything… ".+"$/u;

/** Crop only the measured sidebar beside the frame. The version and any rows below the footer stay full width. */
function composerRows(rows: readonly string[], foot: number, end: number): readonly string[] {
  const footer = rows[foot + 1] ?? '';
  if (!footer.slice(0, end).endsWith('ctrl+p commands') || !SIDEBAR_FOLDER.test(footer.slice(end))) return rows;
  return rows.map((row, i) => i <= foot + 1 && row.slice(end, end + 4).trim() === ''
    ? row.slice(0, end).trimEnd() : row);
}

function idleFooter(rows: readonly string[], foot: number, indent: number): 'session' | 'welcome' | undefined {
  const footer = rows[foot + 1] ?? '';
  if (!footer.startsWith(' '.repeat(indent))) return undefined;
  const match = FOOTER.exec(footer.slice(indent).trimEnd());
  if (match === null) return undefined;
  if (onlyBlankRowsAfter(rows, foot + 1)) return 'session';
  const tail = rows.slice(foot + 2).filter(row => row.trim() !== '');
  if (match[1] === 'shift+tab agents' && tail.length === 1 && WELCOME_VERSION.test(tail[0]!.trimEnd())) return 'welcome';
}

function inInk(line: StyledLine | undefined, from: number, length: number, fg: string): boolean {
  if (!line) return false;
  for (let i = from; i < from + length; i++) {
    if (!line.spans.some(span => span.from <= i && i < span.to && span.fg === fg)) return false;
  }
  return true;
}

function isBusyFooter(row: string, indent: number): boolean {
  return row.startsWith(' '.repeat(indent)) && BUSY_FOOTER.test(row.slice(indent).trimEnd());
}

/** Both shortcuts use the theme's key and caption inks, including in Plan mode. */
function interruptInk(line: StyledLine | undefined, esc: number, end: number): boolean {
  const ctrl = end - 'ctrl+p commands'.length;
  const commands = end - 'commands'.length;
  const colourAt = (i: number) => line?.spans.find(span => span.from <= i && i < span.to)?.fg;
  const key = colourAt(ctrl);
  const caption = colourAt(commands);
  return !!key && !!caption && key !== caption &&
    inInk(line, ctrl, 6, key) && inInk(line, commands, 8, caption) &&
    inInk(line, esc, 3, key) && inInk(line, esc + 4, 9, caption);
}

function composerTop(rows: readonly string[], foot: number, gutter: string): number {
  let top = foot - 2;
  while (top > 0 && rows[top - 1]!.startsWith(gutter)) top--;
  return top;
}

export function idlePane(view: NudgeView): string | undefined {
  const bar = barFrame(view);
  if (!bar) return undefined;
  const main = composerRows(view.rows, bar.foot, bar.end);
  if (main === view.rows || idleFooter(main, bar.foot, bar.gutter.length - 1) !== 'session') return undefined;
  return JSON.stringify([main, view.cursor]);
}

/** Quiet covers cursor-only edits too. The eight progress cells animate while a turn runs. */
export function composerBlock(rows: readonly string[], cursor?: CursorPosition): string {
  const bar = barFrame({ rows });
  if (bar === null) return rows.join('\n');
  const main = composerRows(rows, bar.foot, bar.end);
  const top = composerTop(main, bar.foot, bar.gutter);
  const block = main.slice(top);
  const footer = main[bar.foot + 1] ?? '';
  if (isBusyFooter(footer, bar.gutter.length)) {
    block[bar.foot + 1 - top] = footer.replace(/[⬝■]{8}/u, '⬝'.repeat(8));
  }
  if (cursor) block.push(`${cursor.x},${cursor.y}`);
  return block.join('\n');
}

/** Keep spaces drawn in text ink, including at the right edge the viewport reader trims. */
function inputText(view: NudgeView, y: number, row: string, start: number, end: number): string {
  const physical = view.untrimmedRow?.(y) ?? view.styled?.[y];
  if (!physical) return row.slice(start);
  const visible = physical.text.slice(start, end).replace(/ +$/u, '');
  let last = start + visible.length;
  // ConPTY can extend the final glyph's ink through the padding on a full
  // repaint. The cursor still advances over actual trailing input spaces.
  if (visible && !SUGGESTION.test(visible)) {
    if (view.cursor?.y === y) last = Math.max(last, Math.min(view.cursor.x, end));
    return physical.text.slice(start, last);
  }
  for (const span of physical.spans) {
    if (span.from < end && span.to > last && span.fg !== null && span.fg !== '#ffffff' &&
      !(visible && span.fg === '#808080')) {
      last = Math.min(end, span.to);
    }
  }
  return physical.text.slice(start, last);
}

/** OpenCode wraps a word that will not fit, and splits a long word only at the physical edge. */
function matchesDraft(pieces: readonly string[], expected: string, width: number): boolean {
  let position = 0;
  for (const [i, piece] of pieces.entries()) {
    if (!piece || piece.length > width) return false;
    if (i > 0) {
      const previous = pieces[i - 1]!;
      const space = expected[position] === ' ' && !piece.startsWith(' ') ? 1 : 0;
      const word = /^\S+/u.exec(expected.slice(position + space))?.[0] ?? '';
      if (previous.length < width && ((space === 0 && !previous.endsWith(' ')) ||
        previous.length + space + word.length <= width)) return false;
      position += space;
    }
    if (!expected.startsWith(piece, position)) return false;
    position += piece.length;
  }
  return position === expected.length;
}

export function readiness(view: NudgeView): NudgeReadiness {
  const bar = barFrame(view);
  if (bar === null) return 'unknown';
  const { foot, gutter, end } = bar;
  const rows = composerRows(view.rows, foot, end);
  const inset = gutter + '  ';
  const status = rows[foot - 1]!.trimEnd();
  if (!status.startsWith(inset) || status.length > end ||
    !/^(?:Build|Plan) · \S+(?: \S+)*$/u.test(status.slice(inset.length))) return 'unknown';
  const busy = isBusyFooter(rows[foot + 1] ?? '', gutter.length);
  let welcome = false;
  if (busy) {
    const line = view.styled?.[foot + 1];
    const esc = gutter.length + 9;
    if (rows[foot + 1]!.trimEnd().length !== end || !interruptInk(line, esc, end)) return 'unknown';
    if (!onlyBlankRowsAfter(rows, foot + 1)) return 'busy';
  } else {
    // The live tab spinner can veto a partially repainted idle footer.
    if (BUSY_TAB.test(rows[0] ?? '')) return 'busy';
    const footer = idleFooter(rows, foot, gutter.length - 1);
    if (!footer) return 'unknown';
    welcome = footer === 'welcome';
  }
  if (rows[foot]!.trimEnd().length !== end) return 'unknown';

  const top = composerTop(rows, foot, gutter);
  if (foot - top < 4 || rows[top]!.trimEnd() !== gutter || rows[foot - 2]!.trimEnd() !== gutter) return 'unknown';
  const pieces: string[] = [];
  for (let i = top + 1; i < foot - 2; i++) {
    const row = rows[i]!.replace(/ +$/u, '');
    if (row.length > end || (row !== gutter && !row.startsWith(inset))) return 'unknown';
    pieces.push(inputText(view, i, row, inset.length, end));
  }
  const occupied = busy ? 'busy' : 'draft';
  if (view.expectedDraft !== undefined) {
    const cursor = view.cursor;
    if (cursor && (cursor.y <= top || cursor.y >= foot - 2 || cursor.x < inset.length || cursor.x >= end)) return occupied;
    return matchesDraft(pieces, view.expectedDraft, end - inset.length - 2) ? 'ready' : occupied;
  }
  if (pieces.length !== 1) return occupied;
  const text = pieces[0]!;
  if (welcome && SUGGESTION.test(text) && inInk(view.styled?.[top + 1], inset.length, text.length, '#808080')) return 'ready';
  if (welcome || text !== '' || view.cursor?.x !== inset.length || view.cursor.y !== top + 1) return occupied;
  return busy ? 'queue' : 'ready';
}
