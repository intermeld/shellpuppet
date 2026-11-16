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
const SHORTCUTS = /^\s*\? for shortcuts\s*$/u;

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
    status: (line) => SHORTCUTS.test(line.text) || MODEL_STATUS.test(line.text),
  });
}
