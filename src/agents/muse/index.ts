import { readingRules } from './readingRules.js';
import { MUSE_SUBMIT_DELAY_MS, museSubmittingText } from './input.js';
import { MusePromptSettler, prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';

export const muse: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts, readingRules,
  input: { submit: { key: '\r', delayMs: MUSE_SUBMIT_DELAY_MS, matches: museSubmittingText }, resizeBehindSubmit: true },
  createPromptSettler: () => new MusePromptSettler(),
  matchesProgram: (pattern, program) => pattern === 'muse-bin-*' && /^muse-bin-\d+(?:\.\d+)*(?:[-+][a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(program),
};
