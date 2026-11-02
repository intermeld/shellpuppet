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
});
