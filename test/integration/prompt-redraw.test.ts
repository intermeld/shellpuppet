/** A repaint retains the held prompt; a different or departed dialog does not. */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { api, connectWs, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';
import { museWrappedAnsi } from '../fixtures/museWrapped.js';
import { detectPrompt } from '../../src/core/promptDetector.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'repaint-dialog.mjs');
const museFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'muse-hold.mjs');
let td: TestDaemon;
beforeAll(async () => { td = await startTestDaemon({ promptScanIntervalMs: 100, promptStallMs: 300 }); });
afterAll(async () => { await td.stop(); });

it('restarts a held prompt after input, while reports and redraws keep its clock', async () => {
  let now = 1_000;
  const isolated = await startTestDaemon({ promptScanIntervalMs: 300_000, promptStallMs: 5_000, now: () => now });
  const started = await api(isolated.port, isolated.token, '/sessions', {
    body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 200)'], shell: false },
  });
  const id = String(started.body['id']);
  const scanner = isolated.daemon as unknown as {
    manager: { get(id: string): {
      snapshot(): Promise<{ screen: string }>;
      answerablePrompt(screen: string): ReturnType<typeof detectPrompt>;
      promptInputVersion(): number;
      nudgeInputVersion(): number;
    } | undefined };
    promptStates: Map<string, { since: number; alerted: boolean }>;
    sessionFeed: { subscribe(listener: (frame: { type: string; changed?: string[];
      session?: { waitingOnPrompt?: { waitingMs: number } } }) => void): () => void };
    scanForPromptStalls(): Promise<void>;
  };
  const session = scanner.manager.get(id)!;
  const feed: { type: string; changed?: string[]; session?: { waitingOnPrompt?: { waitingMs: number } } }[] = [];
  const unsubscribe = scanner.sessionFeed.subscribe((frame) => feed.push(frame));
  const dialog = (command: string, extras: { hint?: boolean; side?: string; rows?: string[] } = {}): string => [
    `  ┃  △ Permission required${extras.hint ? '        Esc to close' : ''}`,
    `  ┃  $ ${command}${extras.side === undefined ? '' : `                 ${extras.side}`}`,
    ...(extras.rows ?? []).map((row) => `  ┃  ${row}`),
    '  ┃   Allow once   Reject',
  ].join('\n');
  let screen = dialog('echo a long command with identical alpha', { hint: true });
  session.snapshot = () => Promise.resolve({ screen });
  session.answerablePrompt = (frame) => detectPrompt(frame, 'opencode');
  const viewer = await connectWs(isolated.port, id, isolated.token);
  try {
    expect(detectPrompt(screen, 'opencode')).toMatchObject({
      question: 'Permission required', options: ['Allow once', 'Reject'],
    });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)?.since).toBe(1_000);

    // The review's title hint, command continuation, sidebar and animated
    // rows can all change while the held prompt has received no input.
    now = 3_000;
    screen = dialog('echo a long command with identical alpha', {
      hint: true, side: 'neighbouring panel', rows: ['◐ Waiting', 'Elapsed: 00:01'],
    });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)?.since).toBe(1_000);

    const reportVersion = session.nudgeInputVersion();
    viewer.ws.send('\x1b[I');
    await eventually(() => session.nudgeInputVersion() > reportVersion);
    expect(session.promptInputVersion()).toBe(0);
    now = 7_000;
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)).toMatchObject({ since: 1_000, alerted: true });
    await viewer.waitForControl((frame) => frame['type'] === 'prompt-stall');

    now = 7_500;
    screen = dialog('echo a long command with identical alpha', {
      hint: true, side: 'another panel', rows: ['◓ Waiting', 'Elapsed: 00:02'],
    });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)).toMatchObject({ since: 1_000, alerted: true });
    expect(viewer.controls().filter((frame) => frame['type'] === 'prompt-clear')).toHaveLength(0);

    // One missed scan with no input keeps the alert as well as its clock.
    now = 7_600;
    screen = '';
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)).toMatchObject({ since: 1_000, alerted: true });
    now = 7_800;
    screen = dialog('echo a long command with identical alpha', { hint: true });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)).toMatchObject({ since: 1_000, alerted: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(viewer.controls().filter((frame) => frame['type'] === 'prompt-clear')).toHaveLength(0);

    const updatesBefore = feed.filter((frame) => frame.type === 'session-updated' &&
      frame.changed?.includes('waitingOnPrompt')).length;
    expect((await api(isolated.port, isolated.token, `/sessions/${id}/input`, { body: { data: 'y' } })).status).toBe(200);
    now = 8_000;
    screen = dialog('echo a long command with identical beta', { hint: true });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)).toMatchObject({ since: 8_000, alerted: false });
    expect(feed.filter((frame) => frame.type === 'session-updated' &&
      frame.changed?.includes('waitingOnPrompt')).length).toBeGreaterThan(updatesBefore);
    expect(feed.at(-1)?.session?.waitingOnPrompt?.waitingMs).toBe(0);
    await viewer.waitForControl((frame) => frame['type'] === 'prompt-clear');

    const beforeViewerInput = session.promptInputVersion();
    viewer.ws.send('x');
    await eventually(() => session.promptInputVersion() > beforeViewerInput);
    now = 9_000;
    screen = dialog('echo', { rows: ['status: alpha'] });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)?.since).toBe(9_000);
    now = 9_500;
    screen = dialog('echo', { rows: ['status: beta'] });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)?.since).toBe(9_000);

    expect((await api(isolated.port, isolated.token, `/sessions/${id}/key`, { body: { key: 'enter' } })).status).toBe(200);
    now = 10_000;
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)?.since).toBe(10_000);

    now = 10_400;
    screen = '';
    await scanner.scanForPromptStalls();
    now = 10_700;
    screen = dialog('echo', { rows: ['status: beta'] });
    await scanner.scanForPromptStalls();
    expect(scanner.promptStates.get(id)?.since).toBe(10_000);
  } finally {
    unsubscribe();
    viewer.close();
    await isolated.stop();
  }
}, 90_000);

it.each([
  ['muse-8a-stage1of3', 6, 96, 30],
  ['muse-9a-stage1of3-88col', 21, 120, 34],
] as const)('flags a held %s menu with %i wrapped rows at %ix%i', async (capture, extra, cols, rows) => {
  const screenFile = path.join(td.home, `${capture}-${String(extra)}.ansi`);
  fs.writeFileSync(screenFile, await museWrappedAnsi(capture, extra));
  const started = await api(td.port, td.token, '/sessions', {
    body: { command: process.execPath, args: [museFixture, screenFile], shell: false, cols, rows, label: 'Muse menu stand-in' },
  });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  try {
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=10000`);
    expect(waited.body).toMatchObject({ matched: true, reason: 'prompt' });
    expect(waited.body['prompt']).toMatchObject({ question: 'Would you like to run the following command?' });
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions?waitingOnly=true');
      return (listed.body['sessions'] as { id: string }[]).some((session) => session.id === id);
    }, 10_000);
    const listed = await api(td.port, td.token, '/sessions');
    const session = (listed.body['sessions'] as { id: string; waitingOnPrompt?: { alerted: boolean; options: string[] } }[])
      .find((entry) => entry.id === id);
    expect(session?.waitingOnPrompt?.options).toHaveLength(3);
    await eventually(async () => {
      const result = await api(td.port, td.token, '/sessions');
      return (result.body['sessions'] as { id: string; waitingOnPrompt?: { alerted: boolean } }[])
        .find((entry) => entry.id === id)?.waitingOnPrompt?.alerted === true;
    }, 10_000);
  } finally {
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }
}, 30_000);

it('keeps age through a resize repaint, then restarts after input and clears', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await waiting())?.waitingMs).toBeGreaterThan(before);
    expect(viewer.controls().filter((frame) => frame['type'] === 'prompt-stall')).toHaveLength(1);
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
    body: { command: process.execPath, args: ['-e',
      "process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.on('data', () => process.exit(0)); setInterval(() => {}, 200)"], shell: false },
  });
  const id = String(started.body['id']);
  const internals = slow.daemon as unknown as {
    manager: { get(id: string): { snapshot(): Promise<{ screen: string }>; write(data: string): Promise<string>; exited: boolean } | undefined };
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
    try {
      await session.write('x');
      await eventually(() => session.exited, 5_000);
    } finally {
      await slow.stop();
    }
  }
}, 30_000);
