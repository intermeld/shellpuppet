import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { prompts } from '../qoder/prompts.js';

export const agy: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  readiness: { readyText: ['? for shortcuts'] },
};
