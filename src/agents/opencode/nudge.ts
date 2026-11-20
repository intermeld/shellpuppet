import type { StyledLine } from '../../core/renderer.js';
import { barFrame, barIsBusy } from '../barNudge.js';
import { matchesWrappedDraft, onlyBlankRowsAfter } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

// Both footers start with the folder. The welcome screen adds agent shortcuts
// and can show a separate version row. After a turn it shows context usage.
const FOOTER = /^(?:[A-Za-z]:[\\/]|[\\/~]|…|\.\.?[\\/]).*? {2,}(shift\+tab agents|\d+(?:\.\d+)?[KMB]? \(\d+%\)) {2}ctrl\+p commands$/u;
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

export function readiness(view: NudgeView): NudgeReadiness {
  const bar = barFrame(view);
  if (bar === null) return 'unknown';
  const { rows } = view;
  const { foot, gutter, end } = bar;
  const inset = gutter + '  ';
  const status = rows[foot - 1]!;
  if (!status.startsWith(inset) || !/^Build · \S/u.test(status.slice(inset.length))) return 'unknown';
  // The running footer can replace the folder with the interrupt control.
  if (barIsBusy(view, reading)) return 'busy';
  if (rows[foot]!.trimEnd().length !== end || !hasFooter(rows, foot, gutter.length - 1)) return 'unknown';

  // OpenCode paints a fresh gutter on every continuation, even when xterm
  // marks the padding and status rows as wraps. Read between the two pads.
  let top = foot - 2;
  while (top > 0 && rows[top - 1]!.startsWith(gutter)) top--;
  if (foot - top < 4 || rows[top]!.trimEnd() !== gutter || rows[foot - 2]!.trimEnd() !== gutter) return 'unknown';
  const pieces: string[] = [];
  for (let i = top + 1; i < foot - 2; i++) {
    const row = rows[i]!.trimEnd();
    if (row.length > end || (row !== gutter && !row.startsWith(inset))) return 'unknown';
    pieces.push(row.slice(inset.length));
  }
  if (view.expectedDraft !== undefined) {
    return pieces.every(piece => piece !== '') && matchesWrappedDraft(pieces, view.expectedDraft) ? 'ready' : 'draft';
  }
  return pieces.length === 1 && (pieces[0] === '' || isPlaceholder(pieces[0]!, view.styled?.[top + 1], inset.length))
    ? 'ready' : 'draft';
}
