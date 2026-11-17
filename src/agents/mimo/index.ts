import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { stalls } from './stalls.js';
import { readingRules } from './readingRules.js';
import { readiness } from './nudge.js';

export const mimo: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts, stalls, readingRules,
  nudge: { readiness },
  readiness: { readyText: ['ctrl+p'] },
};
