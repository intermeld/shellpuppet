import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { prompts } from '../qoder/prompts.js';
import { readiness } from './nudge.js';

export const agy: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  nudge: { readiness },
  readiness: { readyText: ['? for shortcuts'] },
};
