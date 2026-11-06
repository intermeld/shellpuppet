import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';

export const grok: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
};
