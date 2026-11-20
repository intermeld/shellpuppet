import { expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';
import type { IPty } from 'node-pty';

it('publishes one broken-pipe stall only after the last connected adapter fails and clears on reconnect', async () => {
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'test', handleFlowControl: false,
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    resize() {}, write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('s1', { command: process.execPath }, { platform: 'linux', spawn: () => pty, pidWaitMs: 0 });
  const events: (string | undefined)[] = [];
  session.onStall(state => events.push(state?.reason));
  try {
    session.mcpConnection('never-registered', 'failed');
    session.mcpConnection('never-registered', 'connected');
    session.mcpConnection('old', 'connected');
    session.mcpConnection('current', 'connected');
    session.mcpConnection('current', 'failed');
    expect(events).toEqual([]);
    session.mcpConnection('another', 'connected');
    session.mcpConnection('another', 'closed');
    expect(events).toEqual([]);
    session.mcpConnection('old', 'failed');
    session.mcpConnection('current', 'failed');
    expect(session.summary().stalled?.reason).toBe('mcp-connection-lost');
    session.mcpConnection('another', 'connected');
    expect(session.getStalled()?.reason).toBe('mcp-connection-lost');
    session.mcpConnection('replacement', 'connected');
    expect(session.getStalled()).toBeUndefined();
    expect(events).toEqual(['mcp-connection-lost', undefined]);
  } finally { await session.kill(); }
});
