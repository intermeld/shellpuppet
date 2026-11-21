import type { StyledLine } from '../../core/renderer.js';
import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { matchesDraft } from './draft.js';
import { reading } from './reading.js';

/** Dim placeholder on an idle Codex composer. The status row under it is not text. */
const PLACEHOLDER = 'Ask Codex to do anything';

/**
 * Codex draws its model and context below the composer, sometimes followed
 * by a shortcuts hint. The 80-column captures show only the model line.
 */
const MODEL_STATUS = /^ {2}GPT-\S+ x?high\s+·\s+Context \d+% left\s+·\s+weekly \d+% left\b/u;
const SHORTCUTS = /^\s*(?:← for agents\s+·\s+)?\? for shortcuts\s*$/u;

/**
 * A status-shaped row in a draft has the real footer below it. The footer
 * itself can be followed only by blank rows and the shortcuts hint.
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
    matchesDraft,
    status: isFooter,
  });
}
