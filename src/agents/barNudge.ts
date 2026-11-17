import type { AgentSignature } from '../core/reasoning.js';
import type { StyledLine } from '../core/renderer.js';
import { onlyBlankRowsAfter, readingReadiness } from './nudgeReading.js';
import type { NudgeReadiness, NudgeView } from './types.js';

/** Read the inset row of the last complete bar composer. */
export function barReadiness(view: NudgeView, reading: AgentSignature, placeholders: readonly string[], agent: 'opencode' | 'mimo'): NudgeReadiness {
  if (view.styled !== undefined && (view.styled.length !== view.rows.length ||
    view.styled.some((line, index) => line.text !== view.rows[index]))) return 'unknown';
  let frame = -1;
  for (let i = view.rows.length - 1; i >= 0; i--) {
    if (/^\s*╹▀{8,}/u.test(view.rows[i] ?? '')) { frame = i; break; }
  }
  if (frame < 4) return 'unknown';
  const status = view.rows[frame - 1]!;
  const ownStatus = agent === 'opencode' ? /^\s*┃ {2}Build · .*\bOpenCode\b/u
    : /^\s*┃ {2}Build · MiMo-/u;
  if (!ownStatus.test(status)) return 'unknown';
  const footer = view.rows[frame + 1] ?? '';
  if (agent === 'opencode') {
    if (!/\bctrl\+p commands\b/u.test(footer) || !onlyBlankRowsAfter(view.rows, frame + 1)) return 'unknown';
  } else {
    if (!/tab switch mode/u.test(footer)) return 'unknown';
    const hint = view.rows[frame + 2] ?? '';
    const last = /^\s+e\s+s\s+settings\s+s\s*$/u.test(hint) ? frame + 2 : frame + 1;
    if (!onlyBlankRowsAfter(view.rows, last)) return 'unknown';
  }
  const bar = /^(\s*)┃/u.exec(status);
  if (bar === null) return 'unknown';
  const prefix = `${bar[1]}┃`;
  const input = view.rows[frame - 3];
  if (input === undefined || !input.startsWith(prefix) ||
    !view.rows[frame - 2]?.startsWith(prefix) || !view.rows[frame - 4]?.startsWith(prefix)) return 'unknown';
  const bodyStart = prefix.length + 2;
  const bodyLimit = /^\s*╹▀{8,}/u.exec(view.rows[frame]!)![0].length;
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
  const busy = (reading.busy ?? []).some((test) => test.text !== undefined &&
    view.rows.some((row) => new RegExp(test.text!, 'u').test(row)));
  if (busy) return 'busy';
  const result = readingReadiness({ rows: changed, styled }, { ...reading, composer: { text: '^> ' } }, {
    placeholder,
    continuations: false,
    placeholderInk: (line) => {
      const ink = line.spans.filter((span) => span.to > 2 && span.from < line.text.length);
      return ink.length > 0 && ink.every((span) => span.fg === '#808080');
    },
  });
  if (result === 'ready' && [view.rows[frame - 4], view.rows[frame - 2]].some((row) =>
    row !== undefined && barBody(row) !== '')) return 'draft';
  return result;
}
