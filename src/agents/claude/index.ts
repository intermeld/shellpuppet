import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';

export const claude: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  env: {
    // Claude Code child-session variables: https://code.claude.com/docs/en/env-vars.
    sessionMarkers: [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_SESSION_ATTENDED',
      'CLAUDE_CODE_SSE_PORT', // IDE session
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_BRIDGE_SESSION_ID',
      'CLAUDE_CODE_REMOTE_SESSION_ID',
      'CLAUDE_CODE_REMOTE',
      'CLAUDE_JOB_DIR', // Background session
      'CLAUDE_PID',
    ],
  },
};
