import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Dim placeholder on an idle Codex composer. The status row under it is not text. */
const PLACEHOLDER = 'Ask Codex to do anything';

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: false,
    suggestion: (line) => {
      const body = bodyStyles(line);
      return body.length > 0 && body.every((style) => style.dim);
    },
  });
}
