import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Grey hint on an idle Muse Code composer. */
const PLACEHOLDER = 'Start a message with ! to run a shell command yourself';

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    suggestion: (line) => {
      const body = bodyStyles(line);
      return body.length > 0 && body.every((style) => style.dim || style.fg === '#676c74');
    },
  });
}
