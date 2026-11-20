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
    // Under the lower rule a queued nudge needs Muse Code's model line alone: model id,
    // effort, working folder and its launch label. While Muse lists background tasks
    // (free text) there, the nudge waits until the turn ends.
    queueFooter: (rows) => rows.length === 1 &&
      /^ {2}[a-z0-9][a-z0-9.-]* · (?:low|medium|high|xhigh|max) · (?:(?:[A-Za-z]:[\\/]|\/|~)[^·?]*|[^\s·?]+) · Launch overrides$/u.test(rows[0]!.text.trimEnd()),
    // The Voice input rule above the composer and the plain rule under it.
    ruleRows: [/^── Voice input \(Alt\+V to start\) ─+$/u, /^─{10,}$/u],
    ruleInk: (line) => line.spans.some((span) => span.from === 0 && span.dim && span.fg === RULE_INK) &&
      !line.spans.some((span) => span.fg === TYPED_INK),
  });
}
