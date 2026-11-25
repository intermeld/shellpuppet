import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { readingRules } from './readingRules.js';
import { readiness } from './nudge.js';
import { submittingText } from '../input.js';

export const grok: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts, readingRules,
  input: { submit: { key: '\r', auto: true, delayMs: 150, matches: submittingText } },
  nudge: { readiness },
  readiness: { readyText: ['│ >'] },
  resumeIdMarkers: ['GROK_SESSION_ID'],
  env: {
    // Grok child-session variables: crates/codegen/xai-grok-tools/src/util/env.rs.
    sessionMarkers: [
      'GROK_AGENT',
      'GROK_SESSION_ID', // Hooks
    ],
  },
};
