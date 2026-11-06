import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';

/** Shared prompt shapes and an inert reading for unmatched programs. */
export const generic: AgentModule = {
  name: 'generic', programs: [], prompts,
  reading: { name: 'generic', programs: [], composer: { text: '(?!)' }, answer: { start: { text: '(?!)' } } },
};
