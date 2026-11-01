/** A repaint retains the held prompt; a different or departed dialog does not. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { api, connectWs, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'repaint-dialog.mjs');
let td: TestDaemon;
beforeAll(async () => { td = await startTestDaemon({ promptScanIntervalMs: 100, promptStallMs: 300 }); });
afterAll(async () => { await td.stop(); });

it('keeps age and one stall through a resize repaint and a short gap, then replaces and clears', async () => {
  const started = await api(td.port, td.token, '/sessions', {
    body: { command: process.execPath, args: [fixture], shell: false, cols: 100, rows: 30 },
  });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  const viewer = await connectWs(td.port, id, td.token);
  const waiting = async (): Promise<{ question: string; waitingMs: number; alerted: boolean } | undefined> => {
    const result = await api(td.port, td.token, '/sessions');
    return (result.body['sessions'] as { id: string; waitingOnPrompt?: { question: string; waitingMs: number; alerted: boolean } }[])
      .find((entry) => entry.id === id)?.waitingOnPrompt;
  };
  try {
    await eventually(async () => (await waiting())?.alerted === true, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const before = (await waiting())!.waitingMs;
    const resized = await api(td.port, td.token, `/sessions/${id}/resize`, { body: { cols: 105, rows: 31 } });
    expect(resized.status).toBe(200);
    expect((await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'r' } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await waiting())?.waitingMs).toBeGreaterThan(before);
    expect(viewer.controls().filter((frame) => frame['type'] === 'prompt-stall')).toHaveLength(1);
    expect(viewer.controls().filter((frame) => frame['type'] === 'prompt-clear')).toHaveLength(0);

    expect((await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'g' } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await waiting())?.alerted).toBe(true);
    expect(viewer.controls().filter((frame) => frame['type'] === 'prompt-clear')).toHaveLength(0);

    expect((await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'q' } })).status).toBe(200);
    await eventually(async () => (await waiting())?.question === 'A different question?', 10_000);
    expect((await waiting())?.waitingMs).toBeLessThan(before);
    expect(viewer.controls().filter((frame) => frame['type'] === 'prompt-clear')).toHaveLength(1);

    expect((await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'x' } })).status).toBe(200);
    await eventually(async () => (await waiting()) === undefined, 10_000);
  } finally {
    viewer.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }
}, 60_000);

it('clears a missing prompt one second after the first miss with the production scan interval', async () => {
  const slow = await startTestDaemon({ promptScanIntervalMs: 5_000, promptStallMs: 0 });
  const started = await api(slow.port, slow.token, '/sessions', {
    body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 200)'], shell: false },
  });
  const id = String(started.body['id']);
  const internals = slow.daemon as unknown as {
    manager: { get(id: string): { snapshot(): Promise<{ screen: string }> } | undefined };
    promptScanTimer: NodeJS.Timeout | null;
    promptGraceTimers: Map<string, NodeJS.Timeout>;
    scanForPromptStalls(): Promise<void>;
  };
  const session = internals.manager.get(id)!;
  const prompt = [
    ' Permission Required', ' Allow this command to run?',
    '  ❯ 1. Allow once', '    2. No',
  ].join('\n');
  let screen = prompt;
  session.snapshot = () => Promise.resolve({ screen });
  const waiting = async (): Promise<boolean> => {
    const result = await api(slow.port, slow.token, '/sessions');
    return Boolean((result.body['sessions'] as { id: string; waitingOnPrompt?: unknown }[])
      .find((entry) => entry.id === id)?.waitingOnPrompt);
  };
  try {
    await internals.scanForPromptStalls();
    await internals.scanForPromptStalls();
    expect(await waiting()).toBe(true);
    // Start a fresh production-length beat so it cannot happen to clear the
    // prompt during this assertion on a slow CI host.
    if (internals.promptScanTimer !== null) clearInterval(internals.promptScanTimer);
    internals.promptScanTimer = setInterval(() => { void internals.scanForPromptStalls(); }, 5_000);
    screen = '';
    await internals.scanForPromptStalls();
    expect(await waiting()).toBe(true);
    expect(internals.promptGraceTimers.has(id)).toBe(true);
    screen = prompt;
    await internals.scanForPromptStalls();
    expect(internals.promptGraceTimers.has(id)).toBe(false);
    screen = '';
    await internals.scanForPromptStalls();
    await eventually(async () => !(await waiting()), 2_500);
    expect(internals.promptGraceTimers.has(id)).toBe(false);
  } finally {
    await slow.stop();
  }
}, 30_000);
