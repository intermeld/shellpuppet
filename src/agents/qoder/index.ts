import { readiness as nudgeReadiness } from './nudge.js';
import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { submittingText } from '../input.js';

export const qoder: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  input: { submit: { key: '\r', auto: true, delayMs: 150, matches: submittingText } },
  // First paint at 22 to 23 s, accepting input at 24 s (agent-profiles.md).
  readiness: { readyText: ['Type your message'], settleMs: 2000 },
  nudge: { readiness: nudgeReadiness },
};
