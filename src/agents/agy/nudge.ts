import type { StyledLine } from '../../core/renderer.js';
import { bodyStyles, onlyBlankRowsAfter, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

const PLACEHOLDER = 'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)';

function placeholderInk(line: StyledLine): boolean {
  const body = bodyStyles(line);
  return body.length > 0 && body.every((style) => style.fg === 'p8');
}

export function readiness(view: NudgeView): NudgeReadiness {
  let composer = -1;
  for (let i = view.rows.length - 1; i >= 0; i--) {
    if (/^>/u.test(view.rows[i] ?? '')) { composer = i; break; }
  }
  if (composer < 1 || !/^\s*[─━]{10,}/u.test(view.rows[composer - 1] ?? '') ||
    !/^\s*[─━]{10,}/u.test(view.rows[composer + 1] ?? '')) return 'unknown';
  const footer = view.rows[composer + 2] ?? '';
  if (!(/^(?:\? for shortcuts\b|\s+auto · \S)/u.test(footer)) ||
    !onlyBlankRowsAfter(view.rows, composer + 2)) return 'unknown';
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    placeholderInk,
  });
}
