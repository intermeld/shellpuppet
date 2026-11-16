import type { StyledLine } from '../../core/renderer.js';
import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Dim placeholder on an idle Codex composer. The status row under it is not text. */
const PLACEHOLDER = 'Ask Codex to do anything';

/**
 * Footer under the composer on every captured Codex screen: the model and
 * context line, then `? for shortcuts`. No capture shows a frame around a
 * second composer row, so any other text under the composer is unknown.
 */
const MODEL_STATUS = /^ {2}GPT-\S+ high\s+·\s+Context \d+% left\s+·\s+weekly \d+% left\b/u;
const SHORTCUTS = /^\s*(?:← for agents\s+·\s+)?\? for shortcuts\s*$/u;

/**
 * A status-shaped row is the footer only when nothing but blank rows and the
 * shortcuts hint follows it. Draft text shaped like the status row has more
 * text, or the real footer, below it, so it stays part of the composer.
 */
function isFooter(line: StyledLine, below: readonly StyledLine[]): boolean {
  if (!SHORTCUTS.test(line.text) && !MODEL_STATUS.test(line.text)) return false;
  return below.every((row) => row.text.trim() === '' || SHORTCUTS.test(row.text));
}

function placeholderInk(line: StyledLine): boolean {
  const body = bodyStyles(line);
  return body.length > 0 && body.every((style) => style.dim);
}

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    placeholderInk,
    unprovenContinuations: true,
    status: isFooter,
  });
}
