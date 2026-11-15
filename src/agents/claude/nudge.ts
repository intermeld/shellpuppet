import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Grey suggestion recorded on an idle Claude Code composer. */
const PLACEHOLDER = 'Try "write a test for <filepath>"';

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    suggestion: (line) => {
      const body = bodyStyles(line);
      return body.length > 0 && body.every((style) => style.dim);
    },
  });
}
