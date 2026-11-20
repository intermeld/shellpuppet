import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { stalls } from './stalls.js';
import { composerBlock, readiness } from './nudge.js';
import { submittingText } from '../input.js';

export const opencode: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts, stalls,
  input: { submit: { key: '\r', delayMs: 150, matches: submittingText } },
  nudge: { readiness, composerBlock },
  readiness: { readyText: ['ctrl+p'] },
  env: {
    // OpenCode child-session variables: packages/opencode/src/index.ts and
    // packages/core/src/shell.ts.
    sessionMarkers: [
      'OPENCODE_TERMINAL',
      'OPENCODE',
      'OPENCODE_PID',
    ],
  },
};
