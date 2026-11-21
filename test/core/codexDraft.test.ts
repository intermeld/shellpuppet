import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { matchesDraft } from '../../src/agents/codex/draft.js';
import { draftWords } from '../../src/agents/codex/lineBreaks.js';
import { stringWidth } from '../../src/core/stringWidth.js';

// End offsets from @rockorager/uucode 2.2.1 lineSegments, with textwrap's
// alphanumeric hyphen splitter applied as in the reviewed Codex reader.
const cases = JSON.parse(readFileSync(join(__dirname, '../fixtures/nudge/codex-line-breaks.json'), 'utf8')) as
  { text: string; breaks: number[] }[];

function accepts(text: string, pieces: string[], width: number): boolean {
  const rows = pieces.map((piece, i) => (i === 0 ? '› ' : '  ') + piece);
  return matchesDraft(rows.map(text => ({ text, spans: [] })), text, { rows, viewportCols: width + 3 }, 0);
}

// For each row choose the furthest oracle boundary that fits. The oversized
// tokens in the fixture contain only single-cell ASCII and split at the edge.
function oracleRows(text: string, breaks: number[], width: number): string[] {
  const rows: string[] = [];
  for (let start = 0; start < text.length;) {
    const visible = (end: number) => text.slice(start, end).replace(/ +$/u, '');
    const fitting = breaks.filter(end => end > start && stringWidth(visible(end)) <= width);
    const end = fitting.at(-1) ?? start + width;
    rows.push(visible(end));
    start = end;
  }
  return rows;
}

it.each(cases)('matches the reference breaks and rows for "$text"', ({ text, breaks }) => {
  expect(draftWords(text)).toEqual(breaks.map((end, i) => text.slice(breaks[i - 1] ?? 0, end)));
  // Cover both viewport and usable body widths from 20 through 80.
  for (let width = 17; width <= 80; width++) {
    const rows = oracleRows(text, breaks, width);
    expect(accepts(text, rows, width), JSON.stringify({ width, rows })).toBe(true);
  }
});

it('withholds Enter when an unknown class could affect a wrapped layout', () => {
  // Thai text can wrap inside an apparent word. Blindly packing it as one
  // piece or splitting it at the right margin could accept a hard newline.
  const thai = 'ภาษาไทย';
  expect(accepts('12345678901 ' + thai, ['12345678901', thai], 17)).toBe(false);
  expect(accepts(thai.repeat(3), [thai.repeat(3).slice(0, 17), thai.repeat(3).slice(17)], 17)).toBe(false);
  expect(accepts(thai, [thai], 17)).toBe(true);
});
