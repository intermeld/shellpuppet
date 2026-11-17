import { barReadiness } from '../barNudge.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

export function readiness(view: NudgeView): NudgeReadiness {
  return barReadiness(view, reading, ['Ask anything… "What is the tech stack of this project?"'], 'opencode');
}
