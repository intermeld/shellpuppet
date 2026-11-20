import type { StyledLine } from '../../core/renderer.js';
import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Muse Code draws its rules dim in this grey; typed draft text is drawn in TYPED_INK. */
const RULE_INK = '#676c74';
const TYPED_INK = '#ccd3db';

/** Grey hint recorded on an idle Muse Code 1.4.14 composer. */
const PLACEHOLDER = 'Start a message with ! to run a shell command yourself';

function placeholderInk(line: StyledLine): boolean {
  const body = bodyStyles(line);
  return body.length > 0 && body.every((style) => style.fg === '#676c74');
}

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    placeholderInk,
    // Muse Code 1.4.23 rotates grey tips in the empty composer (for example a
    // /resume tip); typed text is always drawn in TYPED_INK, never in this grey.
    anyHintInPlaceholderInk: true,
    // Enter during a running turn hands the line to that turn.
    queueWhileBusy: true,
    // Under the lower rule Muse Code paints its background-task list while tasks run
    // (a "main · ↓ to select" header, then one row per task ending in its state)
    // and always ends with its model line. Anything else there blocks a queued nudge.
    queueFooter: (rows) => {
      const last = rows[rows.length - 1];
      if (last === undefined || !/^ {2}\S[^·]* · [^·]+ · [^·]+ · Launch overrides$/u.test(last.text.trimEnd())) return false;
      const tasks = rows.slice(0, -1);
      if (tasks.length === 0) return true;
      return tasks[0]!.text.trim() === 'main · ↓ to select' && tasks.length >= 2 &&
        tasks.slice(1).every((row) => /^└ [◇◆◈] \S.* {2}(?:running|queued|done|failed|cancelled)$/u.test(row.text.trimEnd()));
    },
    // The Voice input rule above the composer and the plain rule under it.
    ruleRows: [/^── Voice input \(Alt\+V to start\) ─+$/u, /^─{10,}$/u],
    ruleInk: (line) => line.spans.some((span) => span.from === 0 && span.dim && span.fg === RULE_INK) &&
      !line.spans.some((span) => span.fg === TYPED_INK),
  });
}
