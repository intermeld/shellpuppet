import { readiness as nudgeReadiness } from './nudge.js';
import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { submittingText } from '../input.js';

export const codex: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  input: { submit: { key: '\r', delayMs: 150, matches: submittingText } },
  readiness: { readyText: ['Ask Codex'] },
  nudge: { readiness: nudgeReadiness },
  env: {
    // Codex child-session variables: codex-rs/protocol/src/shell_environment.rs,
    // codex-rs/core/src/exec_env.rs and codex-rs/core/src/spawn.rs.
    sessionMarkers: [
      'CODEX_THREAD_ID',
      'CODEX_SESSION_ID',
      'CODEX_TOOL_CALL_ID',
      'CODEX_VERSION',
      'CODEX_PERMISSION_PROFILE',
      'CODEX_SANDBOX',
      'CODEX_SANDBOX_NETWORK_DISABLED',
    ],
  },
};
