import type { StyledLine } from '../../core/renderer.js';
import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Claude Code draws the rules above and below its composer in this grey. */
const RULE_INK = '#888888';

/** Dim placeholder recorded on an idle Claude Code composer. */
const PLACEHOLDER = 'Try "write a test for <filepath>"';

function placeholderInk(line: StyledLine): boolean {
  const body = bodyStyles(line);
  return body.length > 0 && body.every((style) => style.dim);
}

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    placeholderInk,
    // Claude Code also offers a suggested next prompt in the same dim ink; typed text is never dim.
    anyHintInPlaceholderInk: true,
    // Enter during a running turn queues the line; the turn reads it at its next step.
    queueWhileBusy: true,
    // Under the lower rule Claude Code paints only its status rows: the model line
    // ending in its context bar and percentage, and the mode line (⏵⏵ or ⏸, or the
    // shortcuts hint). Any other row there, a panel or a choice, blocks a queued nudge.
    queueFooterRow: (line) => /^ {2}\S.* [█░]{4,} \d+%$/u.test(line.text.trimEnd()) ||
      /^ {2}(?:⏵⏵ |⏸ |\? for shortcuts)/u.test(line.text),
    // The rule above the composer may carry the session's title in the same grey.
    ruleRows: [/^─{10,}$/u, /^─{10,} \S(?:.*\S)? ─{1,}$/u],
    ruleInk: (line) => line.spans.length > 0 && line.spans.every((span) => span.fg === RULE_INK && !span.dim),
  });
}
