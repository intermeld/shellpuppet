import { readiness as nudgeReadiness } from './nudge.js';
import { prompts } from './prompts.js';
import type { AgentModule } from '../types.js';
import { reading } from './reading.js';
import { submittingText } from '../input.js';
import { liveResumeId } from './liveResumeId.js';

export const claude: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  input: { submit: { key: '\r', delayMs: 150, matches: submittingText } },
  readiness: { readyText: ['? for shortcuts', 'shift+tab'] },
  nudge: { readiness: nudgeReadiness },
  resumeIdMarkers: ['CLAUDE_CODE_SESSION_ID'],
  liveResumeId,
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
