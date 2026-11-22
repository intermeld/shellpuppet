import type { NudgeReadiness, NudgeView } from '../types.js';
import { completed, composer, ink, suggestion } from './frame.js';
import type { Composer } from './frame.js';
import type { StyledLine } from '../../core/renderer.js';

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
    const from = i === frame.first ? 2 : 0;
    if (row.text.length > from && !ink(row, from, row.text.length, s => !s.italic && !s.inverse && s.fg !== '#b8860b')) return false;
    text += (i === last ? tail : row.text + ' '.repeat(row.wrapPadding ?? 0)).slice(from);
  }
  return text === view.expectedDraft;
}

export function readiness(view: NudgeView): NudgeReadiness {
  const lines = view.styled;
  if (!lines || lines.length !== view.rows.length || lines.some((l, i) => l.text !== view.rows[i])) return 'unknown';
  const frame = composer(lines);
  if (!frame) return 'unknown';
  if (!completed(lines[frame.top - 1])) return 'unknown';
  const first = lines[frame.first]!;
  if (view.expectedDraft !== undefined) return exactDraft(view, lines, frame) ? 'ready' : 'draft';
  if (frame.bottom !== frame.first + 1) return 'draft';
  if (view.cursor?.y !== frame.first) return 'unknown';
  const body = first.text.slice(2);
  if (body !== '' && ink(first, 2, first.text.length, s => s.fg === '#b8860b' && s.italic && !s.inverse)) {
    return body === suggestion && view.cursor.x <= 2 ? 'ready' : 'unknown';
  }
  if (body === '' && view.cursor.x === 2) return 'ready';
  return 'draft';
}
