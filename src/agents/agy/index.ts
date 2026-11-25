import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { prompts } from '../qoder/prompts.js';
import { readiness } from './nudge.js';
import { submittingText } from '../input.js';

export const agy: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  input: { submit: { key: '\r', auto: true, delayMs: 150, matches: submittingText } },
  nudge: { readiness },
  readiness: { readyText: ['? for shortcuts'] },
};
