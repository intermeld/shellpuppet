import { lineSegments } from '@rockorager/uucode/linebreak';
import { graphemeWidths, stringWidth } from '@rockorager/uucode/width';
import type { StyledLine } from '../../core/renderer.js';
import type { NudgeView } from '../types.js';

/** Codex uses Unicode line breaks, with textwrap's alphanumeric hyphen splitter. */
function* words(text: string): Generator<string> {
  let start = 0;
  for (const { end } of lineSegments(text)) {
    // textwrap delegates hyphen-minus to its splitter and ignores soft hyphens.
    if (end < text.length && (text[end - 1] === '-' || text[end - 1] === '\u00ad')) continue;
    yield* text.slice(start, end).split(/(?<=[\p{Alphabetic}\p{N}]-)(?=[\p{Alphabetic}\p{N}])/u);
    start = end;
  }
}

/** Pack the next piece if it fits. Spaces at a soft break hang off the preceding row. */
function* wrappedRows(text: string, width: number): Generator<string> {
  let row = '';
  let cells = 0;
  for (const word of words(text)) {
    const ink = word.replace(/ +$/u, '');
    const inkWidth = stringWidth(ink);
    if (row && cells + inkWidth > width) {
      yield row.replace(/ +$/u, '');
      row = '';
      cells = 0;
    }
    if (inkWidth > width) {
      for (const glyph of graphemeWidths(ink)) {
        if (cells > 0 && cells + glyph.width > width) {
          yield row;
          row = '';
          cells = 0;
        }
        row += glyph.segment;
        cells += glyph.width;
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
  if (!expected || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(expected)) return false;
  let count = rows.length;
  while (count > 1 && rows[count - 1]!.text.trim() === '') count--;
  // Two cells for the prompt or continuation indent, one for the right margin.
  const width = (view.viewportCols ?? 0) - 3;
  if (count === 1) {
    if (rows[0]?.text !== '› ' + expected || (width > 0 && stringWidth(expected) > width)) return false;
  } else {
    if (width < 1) return false;
    let i = 0;
    for (const piece of wrappedRows(expected, width)) {
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
  // An identical block directly above (only blank rows between) leaves it unclear which
  // copy is the live composer. An earlier copy in the transcript, separated by other
  // output, is a past turn and does not count.
  return !view.rows.slice(0, at).some((text, i) => text === rows[0]!.text && i + count <= at &&
    rows.slice(1, count).every((line, n) => line.text === view.rows[i + n + 1]) &&
    view.rows.slice(i + count, at).every((between) => between.trim() === ''));
}
