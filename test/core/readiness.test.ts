import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moduleFor, resolveAgent } from '../../src/agents/index.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { readinessFor, readinessMatches, trackReadiness, waitUntilReady } from '../../src/core/readiness.js';
import { detectPrompt, StalePromptGuard } from '../../src/core/promptDetector.js';
import { DEFAULT_WAIT_TIMEOUT_MS, startReadyLine } from '../../src/core/types.js';
import { Session } from '../../src/core/session.js';
import type { WaitTarget } from '../../src/core/waiter.js';

function target(): WaitTarget & { screen: string; ready: boolean; exited: boolean; painted: boolean; changed: number } {
  return {
    screen: '', ready: false, exited: false, painted: false, changed: Date.now(),
    getScreen() { return this.screen; }, lastChangeAt() { return this.changed; },
    isExited() { return this.exited; }, hasPainted() { return this.painted; },
    lastInput: () => null, observePrompt: () => undefined, isStalePrompt: () => false,
    answerablePrompt: screen => detectPrompt(screen),
  };
}

afterEach(() => vi.useRealTimers());

describe('recorded module readiness', () => {
  it.each([
    ['claude', 'claude-answered', 'shift+tab'],
    ['claude', 'claude-transcript-view', '? for shortcuts'],
    ['codex', 'codex-answered', 'Ask Codex'],
    ['agy', 'agy-answered', '? for shortcuts'],
    ['grok', 'grok-answered', '│ >'],
    ['opencode', 'opencode-answered', 'ctrl+p'],
    ['mimo', 'mimo-answered', 'ctrl+p'],
    ['qoder', 'qoder-answered-first-turn', 'Type your message'],
    ['muse', 'live96-3-done-composer-hint', 'Voice input (Alt+V to start)'],
  ])('%s recognises %s and needs its recorded signal', async (name, capture, signal) => {
    const base = path.join(__dirname, '..', 'fixtures', 'reasoning', capture);
    const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')) as { cols: number; rows: number };
    const renderer = new ScreenRenderer(meta);
    try {
      await renderer.write(fs.readFileSync(`${base}.ansi`, 'utf8'));
      const screen = renderer.snapshot().screen;
      const readiness = moduleFor(name)!.readiness!;
      expect(readinessMatches(readiness, screen, target(), 0)).toBe(true);
      expect(readinessMatches(readiness, screen.replaceAll(signal, ''), target(), 0)).toBe(false);
      if (name === 'muse') {
        expect(readinessMatches(readiness, `${screen.split('Voice input')[0]}Voice input (Alt+V to start)`, target(), 0)).toBe(false);
      }
    } finally { await renderer.dispose(); }
  });

  it('selects defaults only on opt-in and refuses unknown programs before spawning', () => {
    const module = moduleFor(resolveAgent(undefined, 'qodercli').agent)!;
    expect(readinessFor({ command: 'qodercli' }, module)).toBeUndefined();
    expect(readinessFor({ command: 'qodercli', waitReady: true }, module)).toBe(module.readiness);
    expect(readinessFor({ command: 'qodercli', waitReady: true, readyText: 'CUSTOM' }, module)).toEqual({ readyText: ['CUSTOM'] });
    expect(readinessFor({ command: 'qodercli', waitReady: true, readyQuiet: 150 }, module)).toEqual({ readyQuietMs: 150 });
    expect(moduleFor('generic')!.readiness).toBeUndefined();
    const spawn = vi.fn();
    for (const command of ['plain-shell', 'unknown-program']) {
      expect(() => new Session('refused', { command, waitReady: true }, { spawn })).toThrow(/readyText or readyQuiet/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('readiness timing', () => {
  it('keeps tracking after a call timeout and stops at five minutes', async () => {
    vi.useFakeTimers();
    const t = target();
    const tracked = trackReadiness(t, { readyText: ['READY'] }, true).then(ready => { t.ready = ready; return ready; });
    const short = waitUntilReady(t, 160);
    await vi.advanceTimersByTimeAsync(160);
    expect((await short).reason).toBe('timeout');
    t.screen = 'READY';
    await vi.advanceTimersByTimeAsync(80);
    expect(await tracked).toBe(true);
    const never = trackReadiness(target(), { readyText: ['READY'] }, true);
    let finished = false;
    void never.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await never).toBe(false);
    const pty = {
      pid: 0, cols: 80, rows: 24, process: 'stand-in', handleFlowControl: false,
      onData: () => ({ dispose(): void {} }), onExit: () => ({ dispose(): void {} }),
      resize(): void {}, write(): void {}, clear(): void {}, kill(): void {}, pause(): void {}, resume(): void {},
    } satisfies IPty;
    const session = new Session('never-ready', { command: 'stand-in', shell: true, waitReady: true, readyText: 'READY' },
      { platform: 'linux', spawn: () => pty, pidWaitMs: 0 });
    try {
      expect(session.summary()).toMatchObject({ ready: false, readyReason: 'pending' });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(session.summary()).toMatchObject({ ready: false, readyReason: 'never-held' });
    } finally { await session.kill(); }
  });

  it('uses a thirty second start default and caps a longer call at five minutes', async () => {
    vi.useFakeTimers();
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(60_000);
    for (const [timeout, expected] of [[undefined, 30_000], [900_000, 300_000]] as const) {
      const pending = waitUntilReady(target(), timeout);
      let finished = false;
      void pending.then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ reason: 'timeout', waitedMs: expected });
    }
  });

  it('requires paint for quiet and a full new settling interval after a missing signal', async () => {
    vi.useFakeTimers();
    const t = target();
    const quiet = { readyQuietMs: 100 };
    expect(readinessMatches(quiet, '', t, Date.now() + 200)).toBe(false);
    t.painted = true;
    expect(readinessMatches(quiet, 'paint', t, Date.now() + 99)).toBe(false);
    expect(readinessMatches(quiet, 'paint', t, Date.now() + 100)).toBe(true);
    t.screen = 'Type your message';
    let ready = false;
    const tracked = trackReadiness(t, moduleFor('qoder')!.readiness!, true).then(value => { ready = value; });
    await vi.advanceTimersByTimeAsync(1600);
    expect(ready).toBe(false);
    t.screen = '';
    await vi.advanceTimersByTimeAsync(80);
    t.screen = 'Type your message';
    await vi.advanceTimersByTimeAsync(1600);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(480);
    await tracked;
    expect(ready).toBe(true);
  });

  it('returns a question before readiness, excludes it from tracking and reports exit', async () => {
    vi.useFakeTimers();
    const t = target();
    t.screen = 'READY\nContinue? (y/n)';
    let ready = false;
    const tracked = trackReadiness(t, { readyText: ['READY'] }, true).then(value => { ready = value; });
    await vi.advanceTimersByTimeAsync(160);
    expect(ready).toBe(false);
    t.ready = true;
    expect(await waitUntilReady(t)).toMatchObject({ reason: 'prompt', prompt: { question: 'Continue? (y/n)' } });
    t.exited = true;
    expect((await waitUntilReady(t)).reason).toBe('exited');
    await vi.advanceTimersByTimeAsync(80);
    await tracked;
    expect(ready).toBe(false);
  });

  it('cancels a disconnected call without retaining a poll', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = waitUntilReady(target(), undefined, abort.signal);
    abort.abort();
    expect((await pending).reason).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recognises an answered question again after polling its disappearance', async () => {
    vi.useFakeTimers();
    const t = target();
    const guard = new StalePromptGuard();
    t.screen = 'Continue? (y/n)';
    guard.noteInput(t.screen);
    t.observePrompt = signature => guard.observe(signature);
    t.isStalePrompt = signature => guard.isStale(signature);
    const pending = waitUntilReady(t, 800);
    await vi.advanceTimersByTimeAsync(160);
    t.screen = '';
    await vi.advanceTimersByTimeAsync(160);
    t.screen = 'Continue? (y/n)';
    await vi.advanceTimersByTimeAsync(480);
    expect(await pending).toMatchObject({ reason: 'prompt', prompt: { question: 'Continue? (y/n)' } });
  });

  it('does not report readiness while an answered question still shows', async () => {
    vi.useFakeTimers();
    const t = target();
    t.ready = true;
    t.screen = 'Continue? (y/n)';
    t.isStalePrompt = () => true;
    const pending = waitUntilReady(t, 160);
    await vi.advanceTimersByTimeAsync(160);
    expect((await pending).reason).toBe('timeout');
  });

  it('describes a timeout according to whether readiness is still tracked', () => {
    const result = { reason: 'timeout', waitedMs: 300_000 } as const;
    expect(startReadyLine(result, null, 'pending')).toContain('readiness is still tracked');
    const ended = startReadyLine(result, null, 'never-held');
    expect(ended).toContain('Started, not ready yet');
    expect(ended).toContain('Readiness tracking has ended');
    expect(ended).not.toContain('still tracked');
  });

  it('restarts guarded tracking after a late question within the original deadline', async () => {
    vi.useFakeTimers();
    const pty = {
      pid: 0, cols: 80, rows: 24, process: 'stand-in', handleFlowControl: false,
      onData: () => ({ dispose(): void {} }), onExit: () => ({ dispose(): void {} }),
      resize(): void {}, write(): void {}, clear(): void {}, kill(): void {}, pause(): void {}, resume(): void {},
    } satisfies IPty;
    const session = new Session('late-question', { command: 'stand-in', shell: true, waitReady: true, readyText: 'READY' },
      { platform: 'linux', spawn: () => pty, pidWaitMs: 0 });
    let screen = 'READY';
    const read = vi.spyOn(session, 'getScreen').mockImplementation(() => screen);
    try {
      await vi.advanceTimersByTimeAsync(80);
      expect(session.readyReason).toBe('condition-met');
      await vi.advanceTimersByTimeAsync(299_120);
      screen = 'READY\nContinue? (y/n)';
      expect((await session.waitUntilReady(0)).reason).toBe('prompt');
      expect(session.summary()).toMatchObject({ ready: false, readyReason: 'pending' });
      await vi.advanceTimersByTimeAsync(800);
      expect(session.summary()).toMatchObject({ ready: false, readyReason: 'never-held' });
    } finally {
      read.mockRestore();
      await session.kill();
    }
  });
});
