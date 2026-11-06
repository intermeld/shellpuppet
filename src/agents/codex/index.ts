import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';

export const codex: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  readiness: { readyText: ['Ask Codex'] },
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
