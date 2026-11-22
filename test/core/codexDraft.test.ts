import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { codex } from '../../src/agents/codex/index.js';
import { matchesDraft } from '../../src/agents/codex/draft.js';
import { draftWords, lineBreaks } from '../../src/agents/codex/lineBreaks.js';
import { stringWidth } from '../../src/core/stringWidth.js';
import { nudgeVerdict, type NudgeObservation } from '../../src/core/nudge.js';

// UTF-16 end offsets from textwrap 0.16.2 with unicode-linebreak 0.1.5.
const cases = JSON.parse(readFileSync(join(__dirname, '../fixtures/nudge/codex-line-breaks.json'), 'utf8')) as
  { text: string; breaks: number[] }[];

// The model-footer variants are the first review's adjudicated replays.
// Other records retain the captured footer, cursor and full row positions.
// The two short-terminal after-screens include the chair's documented
// limitation where a pre-existing suffix beyond the caret is invisible.
const captures = JSON.parse(readFileSync(join(__dirname, '../fixtures/nudge/codex-review-screens.json'), 'utf8')) as
  (Omit<NudgeObservation, 'unchangedMs'> & { name: string; expectedDraft: string; ready: boolean })[];
it.each(captures)('reads the captured Codex composer in $name', ({ ready, ...view }) => {
  expect(nudgeVerdict(codex, { ...view, unchangedMs: 5000 }).ready).toBe(ready);
});

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
  const supported = [...text].every(ch => ch.codePointAt(0)! <= 0xff);
  const pieces = breaks.map((end, i) => text.slice(breaks[i - 1] ?? 0, end));
  expect(draftWords(text)).toEqual(supported ? pieces : undefined);
  // Cover both viewport and usable body widths from 20 through 80.
  for (let width = 17; width <= 80; width++) {
    const rows = oracleRows(text, breaks, width);
    expect(accepts(text, rows, width), JSON.stringify({ width, rows })).toBe(supported);
  }
});

it('withholds Enter for an unsupported character on one or more rows', () => {
  // Thai text can wrap inside an apparent word. Blindly packing it as one
  // piece or splitting it at the right margin could accept a hard newline.
  const thai = 'ภาษาไทย';
  expect(accepts('12345678901 ' + thai, ['12345678901', thai], 17)).toBe(false);
  expect(accepts(thai.repeat(3), [thai.repeat(3).slice(0, 17), thai.repeat(3).slice(17)], 17)).toBe(false);
  expect(accepts(thai, [thai], 17)).toBe(false);
});

it('matches every Unicode and Codex word boundary in the external oracle corpus', () => {
  // Each record holds the input and its UAX #14 end offsets. A third field
  // records textwrap's offsets when they differ. Null means outside the
  // supported repertoire (or a control character in a single-line draft).
  type Record = [string, number[] | null, (number[] | null)?];
  const fixture = readFileSync(join(__dirname, '../fixtures/nudge/codex-line-breaks.jsonl.gz'));
  expect(fixture.byteLength).toBeLessThan(1_000_000);
  const records = gunzipSync(fixture).toString('utf8').trimEnd().split('\n');
  expect(records).toHaveLength(130_015);
  let mismatches = 0;
  const examples: unknown[] = [];
  for (const record of records) {
    const [text, raw, words = raw] = JSON.parse(record) as Record;
    const actual = lineBreaks(text) ?? null;
    const pieces = draftWords(text);
    let end = 0;
    const offsets = pieces?.map(piece => end += piece.length) ?? null;
    if (!isDeepStrictEqual(actual, raw) || !isDeepStrictEqual(offsets, words)) {
      mismatches++;
      if (examples.length < 5) examples.push({ text, raw, actual, words, offsets });
    }
  }
  expect(mismatches, JSON.stringify(examples)).toBe(0);
});
