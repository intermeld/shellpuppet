import type { StyledLine } from '../../core/renderer.js';
import { barFrame, barIsBusy } from '../barNudge.js';
import { onlyBlankRowsAfter, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

const placeholders = ['Type your message... (type / for commands)', 'now say hello  (Tab to accept)'];

/** Read MiMo's single inset composer row. */
export function readiness(view: NudgeView): NudgeReadiness {
  const bar = barFrame(view);
  if (bar === null) return 'unknown';
  const { foot: frame, gutter: prefix, end: bodyLimit } = bar;
  const status = view.rows[frame - 1]!;
  if (!status.startsWith(`${prefix}  Build · MiMo-`)) return 'unknown';
  const footer = view.rows[frame + 1] ?? '';
  if (!/tab switch mode/u.test(footer)) return 'unknown';
  const hint = view.rows[frame + 2] ?? '';
  const last = /^\s+e\s+s\s+settings\s+s\s*$/u.test(hint) ? frame + 2 : frame + 1;
  if (!onlyBlankRowsAfter(view.rows, last)) return 'unknown';
  const input = view.rows[frame - 3];
  if (input === undefined || !input.startsWith(prefix) ||
    !view.rows[frame - 2]?.startsWith(prefix) || !view.rows[frame - 4]?.startsWith(prefix)) return 'unknown';
  const bodyStart = prefix.length + 2;
  const barBody = (row: string): string => row.slice(bodyStart, bodyLimit).trim();
  if (input !== prefix && !input.startsWith(`${prefix}  `)) return 'unknown';
  const body = input === prefix ? '' : input.slice(bodyStart, bodyLimit).trimEnd();
  const bodyEnd = bodyStart + body.length;
  const changed = [...view.rows];
  changed[frame - 3] = `> ${body}`;
  const styled = view.styled?.map((line, index): StyledLine => {
    if (index !== frame - 3) return line;
    const spans = line.spans.flatMap((span) => {
      const from = Math.max(span.from, bodyStart);
      const to = Math.min(span.to, bodyEnd);
      return to > from ? [{ ...span, from: from - bodyStart + 2, to: to - bodyStart + 2 }] : [];
    });
    return { ...line, text: `> ${body}`, spans };
  });
  const placeholder = placeholders.find((candidate) => candidate === body) ?? placeholders[0] ?? '';
  const busy = barIsBusy(view, reading);
  if (busy && view.whenBusy === undefined) return 'busy';
  const result = readingReadiness({ rows: changed, styled, expectedDraft: view.expectedDraft,
    exactEmpty: view.exactEmpty, whenBusy: view.whenBusy }, { ...reading, composer: { text: '^> ' } }, {
    placeholder,
    continuations: false,
    placeholderInk: (line) => {
      const ink = line.spans.filter((span) => span.to > 2 && span.from < line.text.length);
      return ink.length > 0 && ink.every((span) => span.fg === '#808080');
    },
  });
  if (result === 'ready' && [view.rows[frame - 4], view.rows[frame - 2]].some((row) =>
    row !== undefined && barBody(row) !== '')) return 'draft';
  return busy && result !== 'draft' ? 'busy' : result;
}
