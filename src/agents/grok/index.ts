import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';

export const grok: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  env: {
    // Grok child-session variables: crates/codegen/xai-grok-tools/src/util/env.rs.
    sessionMarkers: [
      'GROK_AGENT',
      'GROK_SESSION_ID', // Hooks
    ],
  },
};
