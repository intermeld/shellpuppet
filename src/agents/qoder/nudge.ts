import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Grey placeholder on an idle Qoder composer. `? for shortcuts` is status above the frame. */
const PLACEHOLDER = 'Type your message or @path/to/file';

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    suggestion: (line) => {
      const body = bodyStyles(line);
      return body.length > 0 && body.every((style) => style.fg === '#95958f');
    },
  });
}
