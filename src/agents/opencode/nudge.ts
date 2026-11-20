import type { StyledLine } from '../../core/renderer.js';
import { barFrame, barIsBusy } from '../barNudge.js';
import { matchesWrappedDraft, onlyBlankRowsAfter } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

// The idle footer starts with the folder. The running footer replaces it with
// progress cells and the interrupt control. Both end with the same key hints.
const CONTROLS = String.raw`(shift\+tab agents|\d+(?:\.\d+)?[KMB]? \(\d+%\)) {2}ctrl\+p commands`;
const FOOTER = new RegExp(String.raw`^(?:[A-Za-z]:[\\/]|[\\/~]|…|\.\.?[\\/]).*? {2,}${CONTROLS}$`, 'u');
const BUSY_FOOTER = new RegExp(String.raw`^[⬝■]{8} esc interrupt {2,}${CONTROLS}$`, 'u');
const BUSY_TAB = /^ {3}.*[⠀-⣿] \S.* {2,}\+\s*$/u;
const WELCOME_VERSION = /^(?: {2}⊙ \d+ MCP failed \/mcps)? {2,}\d+\.\d+\.\d+$/u;
const SUGGESTION = /^Ask anything… ".+"$/u;

function hasFooter(rows: readonly string[], foot: number, indent: number): boolean {
  const footer = rows[foot + 1] ?? '';
  if (!footer.startsWith(' '.repeat(indent))) return false;
  const match = FOOTER.exec(footer.slice(indent).trimEnd());
  if (match === null) return false;
  if (onlyBlankRowsAfter(rows, foot + 1)) return true;
  if (match[1] !== 'shift+tab agents') return false;
  const tail = rows.slice(foot + 2).filter(row => row.trim() !== '');
  return tail.length === 1 && WELCOME_VERSION.test(tail[0]!.trimEnd());
}

function isPlaceholder(text: string, line: StyledLine | undefined, from: number): boolean {
  if (!SUGGESTION.test(text) || line === undefined) return false;
  for (let i = from; i < from + text.length; i++) {
    if (!line.spans.some(span => span.from <= i && i < span.to && span.fg === '#808080')) return false;
  }
  return true;
}

function isBusyFooter(row: string, indent: number): boolean {
  return row.startsWith(' '.repeat(indent)) && BUSY_FOOTER.test(row.slice(indent).trimEnd());
}

function composerTop(rows: readonly string[], foot: number, gutter: string): number {
  let top = foot - 2;
  while (top > 0 && rows[top - 1]!.startsWith(gutter)) top--;
  return top;
}

/** Compare the whole gutter block, ignoring the eight-cell progress animation in the recognised footer. */
export function composerBlock(rows: readonly string[]): string {
  const bar = barFrame({ rows });
  if (bar === null) return rows.join('\n');
  const top = composerTop(rows, bar.foot, bar.gutter);
  const block = rows.slice(top);
  const footer = rows[bar.foot + 1] ?? '';
  if (isBusyFooter(footer, bar.gutter.length)) {
    block[bar.foot + 1 - top] = footer.replace(/[⬝■]{8}/u, '⬝'.repeat(8));
  }
  return block.join('\n');
}

export function readiness(view: NudgeView): NudgeReadiness {
  const bar = barFrame(view);
  if (bar === null) return 'unknown';
  const { rows } = view;
  const { foot, gutter, end } = bar;
  const inset = gutter + '  ';
  const status = rows[foot - 1]!;
  if (!status.startsWith(inset) || !/^Build · \S/u.test(status.slice(inset.length))) return 'unknown';
  const busy = isBusyFooter(rows[foot + 1] ?? '', gutter.length);
  if (busy) {
    if (!onlyBlankRowsAfter(rows, foot + 1) || status.trimEnd().length > end ||
      !/^Build · \S+(?: \S+)*$/u.test(status.slice(inset.length).trimEnd())) return 'busy';
  } else {
    // The tab spinner and other running markers can block input during a partial redraw.
    if (BUSY_TAB.test(rows[0] ?? '') || barIsBusy(view, reading)) return 'busy';
    if (!hasFooter(rows, foot, gutter.length - 1)) return 'unknown';
  }
  if (rows[foot]!.trimEnd().length !== end) return 'unknown';

  // OpenCode paints a fresh gutter on every continuation, even when xterm
  // marks the padding and status rows as wraps. Read between the two pads.
  const top = composerTop(rows, foot, gutter);
  if (foot - top < 4 || rows[top]!.trimEnd() !== gutter || rows[foot - 2]!.trimEnd() !== gutter) return 'unknown';
  const pieces: string[] = [];
  for (let i = top + 1; i < foot - 2; i++) {
    const row = rows[i]!.trimEnd();
    if (row.length > end || (row !== gutter && !row.startsWith(inset))) return 'unknown';
    pieces.push(row.slice(inset.length));
  }
  if (view.expectedDraft !== undefined) {
    if (pieces.every(piece => piece !== '') && matchesWrappedDraft(pieces, view.expectedDraft)) return 'ready';
    return busy ? 'busy' : 'draft';
  }
  if (busy) return pieces.length === 1 && pieces[0] === '' ? 'queue' : 'busy';
  return pieces.length === 1 && (pieces[0] === '' || isPlaceholder(pieces[0]!, view.styled?.[top + 1], inset.length))
    ? 'ready' : 'draft';
}
