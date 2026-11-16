import type { StyledLine } from '../../core/renderer.js';
import { bodyStyles, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

/** Grey placeholder on an idle Qoder composer. `? for shortcuts` is status above the frame. */
const PLACEHOLDER = 'Type your message or @path/to/file';

function placeholderInk(line: StyledLine): boolean {
  const body = bodyStyles(line);
  return body.length > 0 && body.every((style) => style.fg === '#95958f');
}

export function readiness(view: NudgeView): NudgeReadiness {
  return readingReadiness(view, reading, {
    placeholder: PLACEHOLDER,
    continuations: true,
    placeholderInk,
  });
}
