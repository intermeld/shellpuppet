import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const fixture = path.join(repoRoot, 'test', 'fixtures');
const sink = path.join(fixture, 'dialog-sink.mjs');
const dialog = path.join(fixture, 'dialogs', 'opencode-permission-dialog.txt');
const answered = path.join(fixture, 'dialogs', 'opencode-permission-answered.txt');
let td: TestDaemon;

async function start(waiting: boolean, label: string, delay = 0): Promise<string> {
  const body = waiting
    ? { command: process.execPath, args: [sink, dialog, answered, String(delay)], shell: false, cols: 80, rows: 40, label }
    : { command: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], shell: false, label };
  const result = await api(td.port, td.token, '/sessions', { body });
  return String(result.body['id']);
}

async function waitForPrompt(id: string): Promise<void> {
  await eventually(async () => {
    const result = await api(td.port, td.token, '/sessions?waitingOnly=1');
    return (result.body['sessions'] as { id: string }[]).some((s) => s.id === id);
  }, 30_000);
}

beforeAll(async () => {
  td = await startTestDaemon({ home: makeTempHome('shellpuppet-supervision-'), promptScanIntervalMs: 100 });
});
afterAll(async () => { await td.stop(); }, 180_000);

describe('prompt supervision across sessions', () => {
  it('returns when the second of several sessions is waiting, without a screen', async () => {
    const idle = await start(false, 'idle delegate');
    const second = await start(true, 'second delegate', 1500);
    const result = await api(td.port, td.token, `/sessions/wait?prompt=true&session=${idle}&session=${second}&timeout=30000`);
    expect(result.body['matched']).toBe(true);
    const sessions = result.body['sessions'] as Record<string, unknown>[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: second, label: 'second delegate', question: 'Permission required' });
    expect(sessions[0]?.['options']).toEqual(['Allow once', 'Always allow', 'Reject']);
    expect(sessions[0]).toHaveProperty('waitingMs');
    expect(result.body).not.toHaveProperty('screen');
    expect(sessions[0]).not.toHaveProperty('screen');
  });

  it('returns an already waiting prompt at once, including an all-session poll', async () => {
    const id = await start(true, 'ready delegate');
    await waitForPrompt(id);
    const before = Date.now();
    const waited = await api(td.port, td.token, '/sessions/wait?prompt=true&timeout=30000');
    expect(waited.body['matched']).toBe(true);
    expect(Date.now() - before).toBeLessThan(2_000);
    const polled = await api(td.port, td.token, '/sessions/wait?prompt=true&now=true');
    expect((polled.body['sessions'] as { id: string }[]).some((s) => s.id === id)).toBe(true);
    expect(polled.body).not.toHaveProperty('screen');
  });

  it('times out empty and ignores ended sessions', async () => {
    const idle = await start(false, 'idle timeout');
    const timed = await api(td.port, td.token, `/sessions/wait?prompt=true&session=${idle}&timeout=200`);
    expect(timed.body).toMatchObject({ matched: false, reason: 'timeout', sessions: [] });
    const ended = await start(true, 'ended delegate');
    await waitForPrompt(ended);
    await api(td.port, td.token, `/sessions/${ended}`, { method: 'DELETE' });
    const polled = await api(td.port, td.token, '/sessions/wait?prompt=true&now=true');
    expect((polled.body['sessions'] as { id: string }[]).some((s) => s.id === ended)).toBe(false);
  });

  it('lists waiting sessions in compact form and hides question content when requested', async () => {
    const pending = await start(true, 'listed delegate');
    await waitForPrompt(pending);
    const listed = await api(td.port, td.token, '/sessions?waitingOnly=true');
    const sessions = listed.body['sessions'] as Record<string, unknown>[];
    expect(sessions.some((s) => s['id'] === pending)).toBe(true);
    expect(sessions.every((s) => s['question'] !== undefined)).toBe(true);
    expect(sessions[0]).not.toHaveProperty('screen');
    expect(sessions[0]).not.toHaveProperty('cols');
    const hidden = await api(td.port, td.token, '/sessions?waitingOnly=true&hideReasoning=1');
    expect((hidden.body['sessions'] as Record<string, unknown>[])[0]).not.toHaveProperty('question');
    expect((hidden.body['sessions'] as Record<string, unknown>[])[0]).not.toHaveProperty('options');
  });

  it('keeps the single-session wait response unchanged', async () => {
    const id = await start(true, 'single delegate');
    const result = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=30000`);
    expect(result.body['matched']).toBe(true);
    expect(result.body).toHaveProperty('screen');
    expect(result.body).toHaveProperty('prompt');
  });

  it('releases a timed-out wait and an abandoned wait', async () => {
    const id = await start(false, 'wait lifecycle');
    const timed = await api(td.port, td.token, `/sessions/wait?prompt=true&session=${id}&timeout=300`);
    expect(timed.body).toMatchObject({ matched: false, reason: 'timeout', sessions: [] });
    await eventually(() => td.daemon.waitsPolling === 0, 5_000);

    const caller = new AbortController();
    const abandoned = fetch(`http://127.0.0.1:${String(td.port)}/sessions/wait?prompt=true&session=${id}&timeout=120000`, {
      headers: { authorization: `Bearer ${td.token}` }, signal: caller.signal,
    }).catch(() => undefined);
    await eventually(() => td.daemon.waitsPolling === 1, 10_000);
    caller.abort();
    await abandoned;
    await eventually(() => td.daemon.waitsPolling === 0, 5_000);
  });

  it('clears prompt state after a natural exit and omits the session from compact views', async () => {
    const exited = await startTestDaemon({
      home: makeTempHome('shellpuppet-ended-prompt-'),
      promptScanIntervalMs: 300_000,
      exitedGraceMs: 60_000,
    });
    try {
      const exitSignal = path.join(exited.home, 'exit-signal');
      const started = await api(exited.port, exited.token, '/sessions', {
        body: { command: process.execPath, args: [sink, dialog, answered, '0', `file:${exitSignal}`], shell: false, cols: 80, rows: 40 },
      });
      const id = String(started.body['id']);
      const scanner = exited.daemon as unknown as {
        scanForPromptStalls: () => Promise<void>;
        promptStates: Map<string, unknown>;
      };
      await eventually(async () => {
        await scanner.scanForPromptStalls();
        const listed = await api(exited.port, exited.token, '/sessions');
        return (listed.body['sessions'] as { id: string; waitingOnPrompt?: object }[])
          .find((session) => session.id === id)?.waitingOnPrompt !== undefined;
      }, 15_000);
      const held = scanner.promptStates.get(id);
      expect(held).toBeDefined();
      fs.writeFileSync(exitSignal, 'exit');
      await eventually(async () => {
        const listed = await api(exited.port, exited.token, '/sessions');
        return (listed.body['sessions'] as { id: string; exited: boolean }[])
          .find((session) => session.id === id)?.exited === true;
      }, 20_000);
      expect(scanner.promptStates.has(id)).toBe(false);
      const compact = await api(exited.port, exited.token, '/sessions?waitingOnly=true');
      const polled = await api(exited.port, exited.token, '/sessions/wait?prompt=true&now=true');
      expect((compact.body['sessions'] as { id: string }[]).some((session) => session.id === id)).toBe(false);
      expect((polled.body['sessions'] as { id: string }[]).some((session) => session.id === id)).toBe(false);
    } finally {
      await exited.stop();
    }
  }, 120_000);

  it('ignores an exited session even if stale prompt state remains', async () => {
    const exited = await startTestDaemon({
      home: makeTempHome('shellpuppet-stale-prompt-'),
      promptScanIntervalMs: 300_000,
      exitedGraceMs: 60_000,
    });
    try {
      const exitSignal = path.join(exited.home, 'exit-signal');
      const started = await api(exited.port, exited.token, '/sessions', {
        body: { command: process.execPath, args: [sink, dialog, answered, '0', `file:${exitSignal}`], shell: false, cols: 80, rows: 40 },
      });
      const id = String(started.body['id']);
      const scanner = exited.daemon as unknown as {
        scanForPromptStalls: () => Promise<void>;
        promptStates: Map<string, unknown>;
      };
      await eventually(async () => {
        await scanner.scanForPromptStalls();
        return scanner.promptStates.has(id);
      }, 15_000);
      const held = scanner.promptStates.get(id);
      fs.writeFileSync(exitSignal, 'exit');
      await eventually(async () => {
        const listed = await api(exited.port, exited.token, '/sessions');
        return (listed.body['sessions'] as { id: string; exited: boolean }[])
          .find((session) => session.id === id)?.exited === true;
      }, 20_000);
      scanner.promptStates.set(id, held);
      const compact = await api(exited.port, exited.token, '/sessions?waitingOnly=true');
      const polled = await api(exited.port, exited.token, '/sessions/wait?prompt=true&now=true');
      expect((compact.body['sessions'] as { id: string }[]).some((session) => session.id === id)).toBe(false);
      expect((polled.body['sessions'] as { id: string }[]).some((session) => session.id === id)).toBe(false);
    } finally {
      await exited.stop();
    }
  }, 120_000);

  it('releases a wait when its daemon shuts down', async () => {
    const dying = await startTestDaemon({ home: makeTempHome('shellpuppet-shutdown-wait-') });
    try {
      const pending = fetch(`http://127.0.0.1:${String(dying.port)}/sessions/wait?prompt=true&timeout=120000`, {
        headers: { authorization: `Bearer ${dying.token}` },
      }).catch(() => undefined);
      await eventually(() => dying.daemon.waitsPolling === 1, 10_000);
      await dying.daemon.stop();
      await pending;
      await eventually(() => dying.daemon.waitsPolling === 0, 5_000);
    } finally {
      await dying.stop();
    }
  }, 120_000);
});
