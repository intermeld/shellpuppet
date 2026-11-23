import type { NudgeReadiness, NudgeView } from '../types.js';
import { busyHint, composer, hints, ink } from './frame.js';
import type { Composer } from './frame.js';
import type { StyledLine } from '../../core/renderer.js';
import type { CursorPosition } from '../../core/types.js';

const queueTitle = /^ Queue · \d+ queued · \/queue list · Ctrl\+R collapse$/u;

/** The progress caption and clocks animate independently of the input widget. */
export function composerBlock(rows: readonly string[], cursor?: CursorPosition): string {
  if (rows.at(-3) !== busyHint) return JSON.stringify([rows, cursor]);
  const title = rows.find(row => queueTitle.test(row));
  return JSON.stringify([busyHint, rows.at(-2), rows.at(-4)?.match(/─+ ([^─]+) ─$/u)?.[1],
    rows.at(-1)?.includes('enter interrupt'), title, cursor]);
}

/** Join only physical wraps. Padding at a soft wrap and spaces before the cursor belong to the draft. */
function exactDraft(view: NudgeView, lines: readonly StyledLine[], frame: Composer): boolean {
  const cursor = view.cursor;
  const last = frame.bottom - 1;
  if (cursor?.y !== last || view.expectedDraft === undefined) return false;
  const physical = view.untrimmedRow?.(last);
  let tail = lines[last]!.text;
  if (physical) {
    const width = view.untrimmedRow?.(frame.bottom)?.text.length;
    if (!width || cursor.x > width) return false;
    const end = physical.text.length - (width - cursor.x);
    if (end < tail.length || physical.text.slice(end).trim() !== '') return false;
    tail = physical.text.slice(0, end);
  } else if (!/^[\x20-\x7e❯]*$/u.test(tail) || cursor.x !== tail.length) {
    return false;
  }
  let text = '';
  for (let i = frame.first; i <= last; i++) {
    const row = lines[i]!;
    const from = i === frame.first ? (frame.busy ? 4 : 2) : 0;
    if (row.text.length > from && !ink(row, from, row.text.length, s =>
      s.fg === null && !s.bold && !s.dim && !s.italic && !s.inverse)) return false;
    text += (i === last ? tail : row.text + ' '.repeat(row.wrapPadding ?? 0)).slice(from);
  }
  return text === view.expectedDraft;
}

export function readiness(view: NudgeView): NudgeReadiness {
  const lines = view.styled;
  if (!lines || lines.length !== view.rows.length || lines.some((l, i) => l.text !== view.rows[i])) return 'unknown';
  const frame = composer(lines);
  if (!frame) return 'unknown';
  const first = lines[frame.first]!;
  if (frame.busy) {
    if (lines.some(line => queueTitle.test(line.text)) && (!view.afterSubmit || view.expectedDraft !== undefined)) return 'busy';
    if (view.expectedDraft !== undefined) return view.queueDraft && exactDraft(view, lines, frame) ? 'ready' : 'busy';
    if (view.cursor?.y !== frame.first || view.cursor.x !== 4 || frame.bottom !== frame.first + 1 ||
        first.text !== busyHint || !ink(first, 0, first.text.length, s => s.fg === '#b8860b' && s.italic)) return 'busy';
    return 'queue';
  }
  if (!frame.idle || view.queueDraft) return 'unknown';
  if (view.expectedDraft !== undefined) return exactDraft(view, lines, frame) ? 'ready' : 'draft';
  if (frame.bottom !== frame.first + 1) return 'draft';
  if (view.cursor?.y !== frame.first) return 'unknown';
  const body = first.text.slice(2);
  if (body !== '' && ink(first, 2, first.text.length, s => s.fg === '#b8860b' && s.italic && !s.inverse)) {
    return hints.has(body) && view.cursor.x === 2 ? 'ready' : 'unknown';
  }
  if (body === '') return view.cursor.x > 2 ? 'draft' : 'unknown';
  return ink(first, 2, first.text.length, s => s.fg === null && !s.bold && !s.dim && !s.italic && !s.inverse)
    ? 'draft' : 'unknown';
}
