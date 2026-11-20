import { expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import { Session } from '../../src/core/session.js';
import { agentResumeIds, moduleFor } from '../../src/agents/index.js';

it.each([
  ['claude', 'CLAUDE_CODE_SESSION_ID'],
  ['codex', 'CODEX_THREAD_ID'],
  ['codex', 'CODEX_SESSION_ID'],
  ['grok', 'GROK_SESSION_ID'],
  ['muse', 'MUSE_SESSION_ID'],
])('%s keeps only a conversation observed in its own child environment (%s)', async (agent, marker) => {
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    resize() {}, write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('s1', { command: process.execPath, agent, env: {
    ...(agent === 'codex' ? { CODEX_THREAD_ID: 'old-thread', CODEX_SESSION_ID: 'old-session' } : {}),
    [marker]: 'parent-id',
  },
    launchProfile: { profile: 'worker', folder: '.', folderChoice: {}, resumeId: 'supplied' } }, {
    platform: 'linux', spawn: () => pty, pidWaitMs: 0,
    identity: { token: 'test', instanceId: 'test', cliPath: 'test' },
  });
  try {
    const read = (env: NodeJS.ProcessEnv) => agentResumeIds(moduleFor(agent), env);
    session.observeResumeId(...read({ [marker]: 'parent-id' }));
    expect(session.resumeId).toBe('supplied');
    if (agent === 'codex') {
      const other = marker === 'CODEX_THREAD_ID' ? 'CODEX_SESSION_ID' : 'CODEX_THREAD_ID';
      session.observeResumeId(...read({ [other]: other === 'CODEX_SESSION_ID' ? 'old-session' : 'old-thread' }));
      expect(session.resumeId).toBe('supplied');
    }
    session.observeResumeId(...read({ [marker]: 'bad id' }));
    expect(session.resumeId).toBe('supplied');
    if (agent === 'codex') {
      session.observeResumeId(...read({ CODEX_THREAD_ID: 'primary-new', CODEX_SESSION_ID: 'fallback-new' }));
      expect(session.resumeId).toBe('primary-new');
      session.observeResumeId(...read({ CODEX_THREAD_ID: 'invalid id', CODEX_SESSION_ID: 'fallback-new' }));
      expect(session.resumeId).toBe('fallback-new');
    }
    session.observeResumeId(...read({ [marker]: 'child-id' }));
    expect(session.resumeId).toBe(agent === 'muse' ? 'supplied' : 'child-id');
  } finally { await session.kill(); }
});
