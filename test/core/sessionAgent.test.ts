import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, MUSE_SUBMIT_DELAY_MS } from '../../src/core/session.js';
import { AGENT_MODULES, moduleFor, resolveAgent } from '../../src/agents/index.js';
import { signatureForSession, useAgentSignatures } from '../../src/core/reasoning.js';
import { ScreenRenderer } from '../../src/core/renderer.js';

const sessions: Session[] = [];

function make(command = 'muse', agent?: string): { session: Session; events: { data: string; at: number }[] } {
  const events: { data: string; at: number }[] = [];
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'stand-in', handleFlowControl: false,
    onData: () => ({ dispose(): void {} }), onExit: () => ({ dispose(): void {} }),
    resize: () => events.push({ data: 'resize', at: Date.now() }),
    write: (data: string) => events.push({ data, at: Date.now() }),
    clear(): void {}, kill(): void {}, pause(): void {}, resume(): void {},
  } satisfies IPty;
  const session = new Session('agent-input', { command, shell: true, ...(agent === undefined ? {} : { agent }) }, {
    platform: 'linux', spawn: () => pty, pidWaitMs: 0,
  });
  sessions.push(session);
  return { session, events };
}

afterEach(async () => {
  vi.restoreAllMocks();
  useAgentSignatures([]);
  await Promise.all(sessions.splice(0).map((session) => session.kill()));
});

describe('agent resolved from the start program', () => {
  it('registers every existing harness and the generic fallback', () => {
    expect(AGENT_MODULES.map((module) => module.name)).toEqual([
      'claude', 'codex', 'agy', 'grok', 'opencode', 'mimo', 'qoder', 'muse', 'generic',
    ]);
    expect(resolveAgent(undefined, 'C:\\tools\\MuSe-Bin-1.4.14.EXE')).toEqual({ agent: 'muse', agentSource: 'program' });
    expect(resolveAgent(undefined, 'muse-bin-unrelated')).toEqual({ agent: 'generic', agentSource: 'fallback' });
    expect(resolveAgent(undefined, 'qodercli')).toEqual({ agent: 'qoder', agentSource: 'program' });
    expect(make('muse', 'codex').session).toMatchObject({ agent: 'codex', agentSource: 'explicit' });
    expect(make('pwsh').session).toMatchObject({ agent: 'generic', agentSource: 'fallback' });
  });

  it('uses configured readings for resolution and keeps the resolved identity', () => {
    const reading = moduleFor('muse')!.reading;
    expect(useAgentSignatures([{ ...reading, programs: ['wrapped-muse'] }])).toEqual([]);
    const { session } = make('wrapped-muse');
    expect(session.agent).toBe('muse');
    expect(signatureForSession(session)?.programs).toEqual(['wrapped-muse']);
    expect(make('muse').session.agent).toBe('generic');
    useAgentSignatures([]);
    expect(session).toMatchObject({ agent: 'muse', agentSource: 'program' });
    expect(useAgentSignatures([{ ...reading, name: 'custom', programs: ['custom-cli'] }])).toEqual([]);
    expect(make('custom-cli').session.agent).toBe('custom');
  });

  it('keeps a configured generic reading distinct from an unmatched session', () => {
    const { session: unmatched } = make('unrelated-program');
    expect(useAgentSignatures([{
      name: 'generic', programs: ['plain-wrapper'],
      composer: { text: '^> ' }, answer: { start: { text: '^ANSWER:' } },
    }])).toEqual([]);
    expect(unmatched).toMatchObject({ agent: 'generic', agentSource: 'fallback' });
    expect(signatureForSession(unmatched)).toBeNull();
    expect(signatureForSession(make('unrelated-program').session)).toBeNull();
    const explicit = make('unrelated-program', 'generic').session;
    const matched = make('plain-wrapper').session;
    expect(explicit).toMatchObject({ agent: 'generic', agentSource: 'explicit' });
    expect(matched).toMatchObject({ agent: 'generic', agentSource: 'program' });
    expect(signatureForSession(explicit)?.name).toBe('generic');
    expect(signatureForSession(matched)?.name).toBe('generic');
  });

  it('reads styled rows only for a session whose module has a settler', () => {
    const ordinary = make('node').session;
    const known = make('codex').session;
    const settling = make('muse').session;
    const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
    ordinary.answerablePrompt('Continue? (y/n)');
    known.answerablePrompt('Continue? (y/n)');
    expect(styled).not.toHaveBeenCalled();
    settling.answerablePrompt('Continue? (y/n)');
    expect(styled).toHaveBeenCalledOnce();
  });

  it('stores Muse identity and reports it in the session list without an explicit agent', () => {
    const { session } = make();
    expect(session).toMatchObject({ agent: 'muse', agentSource: 'program' });
    expect(session.summary().agent).toBe('muse');
  });

  it('delays the submitting Enter without an explicit agent', async () => {
    const { session, events } = make();
    await session.write('hello\r');
    expect(events.map((event) => event.data)).toEqual(['hello', '\r']);
    expect(events[1]!.at - events[0]!.at).toBeGreaterThanOrEqual(MUSE_SUBMIT_DELAY_MS - 5);
  });

  it('orders resize and later input behind submission without an explicit agent', async () => {
    const { session, events } = make();
    const submit = session.write('hello\r');
    const resize = session.resize(90, 30);
    const later = session.write('next');
    await Promise.all([submit, resize, later]);
    expect(events.map((event) => event.data)).toEqual(['hello', '\r', 'resize', 'next']);
  });

  it('settles a Muse menu without an explicit agent', () => {
    const { session } = make();
    const screen = [
      'Would you like to run the following command?', '  Stage 1/1', '  Current argv: ["x"]',
      '⟩ 1. Allow this stage once (y)', '  2. Abort the entire command (esc)',
    ].join('\n');
    expect(session.answerablePrompt(screen, 0)).toBeNull();
    expect(session.answerablePrompt(screen, 1_500)?.signature).toContain('Stage 1/1');
  });
});
