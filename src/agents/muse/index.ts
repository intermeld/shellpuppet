import { readingRules } from './readingRules.js';
import { MUSE_SUBMIT_DELAY_MS, museSubmittingText } from './input.js';
import { MusePromptSettler, prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';

export const muse: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts, readingRules,
  readiness: {
    readyScreen: screen => {
      const lines = screen.split('\n');
      const hint = lines.findIndex(line => line.includes('Voice input (Alt+V to start)'));
      return hint >= 0 && lines.slice(hint + 1).some(line => /^\s*❯(?:\s|$)/u.test(line));
    },
  },
  input: { submit: { key: '\r', delayMs: MUSE_SUBMIT_DELAY_MS, matches: museSubmittingText }, resizeBehindSubmit: true },
  createPromptSettler: () => new MusePromptSettler(),
  matchesProgram: (pattern, program) => pattern === 'muse-bin-*' && /^muse-bin-\d+(?:\.\d+)*(?:[-+][a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(program),
};
