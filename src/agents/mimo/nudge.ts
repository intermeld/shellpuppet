import { barReadiness } from '../barNudge.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

export function readiness(view: NudgeView): NudgeReadiness {
  return barReadiness(view, reading, ['Type your message... (type / for commands)', 'now say hello  (Tab to accept)'], 'mimo');
}
