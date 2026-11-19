import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { submittingText } from '../input.js';

/** Shared prompt shapes and an inert reading for unmatched programs. */
export const generic: AgentModule = {
  name: 'generic', programs: [], prompts,
  input: { submit: { key: '\r', delayMs: 150, matches: submittingText } },
  reading: { name: 'generic', programs: [], composer: { text: '(?!)' }, answer: { start: { text: '(?!)' } } },
};
