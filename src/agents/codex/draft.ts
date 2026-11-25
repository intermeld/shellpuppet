import type { StyledLine } from '../../core/renderer.js';
import { stringWidth } from '../../core/stringWidth.js';
import type { NudgeView } from '../types.js';
import { draftWords } from './lineBreaks.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Pack the next piece if it fits. Spaces at a soft break hang off the preceding row. */
function* wrappedRows(words: readonly string[], width: number): Generator<string> {
  let row = '';
  let cells = 0;
  for (const word of words) {
    const ink = word.replace(/ +$/u, '');
    const inkWidth = stringWidth(ink);
    if (row && cells + inkWidth > width) {
      yield row.replace(/ +$/u, '');
      row = '';
      cells = 0;
    }
    if (inkWidth > width) {
      for (const { segment } of graphemes.segment(ink)) {
        const glyphWidth = stringWidth(segment);
        if (cells > 0 && cells + glyphWidth > width) {
          yield row;
          row = '';
          cells = 0;
        }
        row += segment;
        cells += glyphWidth;
      }
    } else {
      row += ink;
      cells += inkWidth;
    }
    row += word.slice(ink.length);
    cells += word.length - ink.length;
  }
  yield row;
}

export function matchesDraft(rows: readonly StyledLine[], expected: string, view: NudgeView, at: number): boolean {
  if (!expected) return false;
  const words = draftWords(expected);
  if (!words) return false;
  let count = rows.length;
  while (count > 1 && rows[count - 1]!.text.trim() === '') count--;
  // Two cells for the prompt or continuation indent, one for the right margin.
  const width = (view.viewportCols ?? 0) - 3;
  if (count === 1) {
    if (rows[0]?.text !== '› ' + expected || (width > 0 && stringWidth(expected) > width)) return false;
  } else {
    if (width < 1) return false;
    let i = 0;
    for (const piece of wrappedRows(words, width)) {
      if (i >= count || rows[i]?.text !== (i === 0 ? '› ' : '  ') + piece) return false;
      i++;
    }
    if (i !== count) return false;
  }
  // A cursor beyond the visible draft can reveal trailing spaces or a newline.
  // Codex gives a completely full final row an empty row for its insertion point.
  const last = at + count - 1;
  const end = stringWidth(rows[count - 1]!.text);
  const full = end === width + 2;
  // The footer has one blank row above it, in addition to any insertion row.
  if (rows.length - count > (full ? 2 : 1)) return false;
  const cursor = view.cursor;
  if (cursor && cursor.y >= last) {
    if (cursor.y === last) {
      if (cursor.x > end) return false;
    } else if (!full || cursor.y !== last + 1 || cursor.x !== 2) return false;
  }
  // A transcript copy is distinguishable from the selected editor only while
  // its cursor is at the end of this editor. A menu or another field can leave
  // the same text painted below a completed turn without owning its focus.
  let earlierCopy = false;
  for (let i = 0; i < at; i++) {
    if (view.rows[i] !== rows[0]!.text || i + count > at ||
      !rows.slice(1, count).every((line, n) => line.text === view.rows[i + n + 1])) continue;
    if (view.rows.slice(i + count, at).every((between) => between.trim() === '')) return false;
    earlierCopy = true;
  }
  return !earlierCopy || (cursor?.y === last && cursor.x === end);
}
