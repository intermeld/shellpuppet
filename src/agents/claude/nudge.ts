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
    // The rule above the composer may carry the session's title in the same grey.
    ruleRows: [/^─{10,}$/u, /^─{10,} \S(?:.*\S)? ─{1,}$/u],
    ruleInk: (line) => line.spans.length > 0 && line.spans.every((span) => span.fg === RULE_INK && !span.dim),
  });
}
