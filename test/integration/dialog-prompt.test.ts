/**
 * A permission dialog drawn inside a TUI, recognised by its signature
 * (`dialogs.ts`), is a prompt like any other: `wait prompt:true` returns it,
 * the session list shows it waiting and the stall alert is audited. The
 * screens are OpenCode's own, captured live with private text replaced.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogPath, createAuditor } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const fixtures = path.join(repoRoot, 'test', 'fixtures');
const SINK = path.join(fixtures, 'dialog-sink.mjs');
const DIALOG = path.join(fixtures, 'dialogs', 'opencode-permission-dialog.txt');
const ANSWERED = path.join(fixtures, 'dialogs', 'opencode-permission-answered.txt');

let td: TestDaemon;

beforeAll(async () => {
  const home = makeTempHome('shellpuppet-dialog-');
  td = await startTestDaemon({
    home,
    audit: createAuditor(home, { captureContent: false }),
    promptScanIntervalMs: 100,
    promptStallMs: 300,
  });
});

afterAll(async () => {
  await td.stop();
});

async function startDialog(): Promise<string> {
  // Narrower than OpenCode drew it, so the sidebar and the request wrap onto
  // rows of their own and the buttons sit well below the title.
  const started = await api(td.port, td.token, '/sessions', {
    body: { command: process.execPath, args: [SINK, DIALOG, ANSWERED], shell: false, cols: 80, rows: 40 },
  });
  return String((started.body as { id: string }).id);
}

interface Listed {
  sessions: { id: string; waitingOnPrompt?: { question: string; options: string[] } }[];
}

describe('a dialog drawn inside a TUI', () => {
  it('satisfies wait prompt:true with its title and choices', async () => {
    const id = await startDialog();
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=15000`);
    const result = waited.body as { matched: boolean; prompt?: { question: string; options: string[] } };
    expect(result.matched).toBe(true);
    expect(result.prompt?.question).toBe('Permission required');
    expect(result.prompt?.options).toEqual(['Allow once', 'Always allow', 'Reject']);
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('shows the session waiting, audits the stall and clears once answered', async () => {
    const id = await startDialog();
    const waiting = async (): Promise<Listed['sessions'][number] | undefined> => {
      const listed = await api(td.port, td.token, '/sessions');
      return (listed.body as unknown as Listed).sessions.find((s) => s.id === id);
    };
    await eventually(async () => (await waiting())?.waitingOnPrompt !== undefined, 15_000);
    expect((await waiting())?.waitingOnPrompt?.question).toBe('Permission required');

    const stalls = (): number =>
      fs
        .readFileSync(auditLogPath(td.home), 'utf8')
        .split('\n')
        .filter((line) => line.includes('"prompt-stall"') && line.includes(`"${id}"`)).length;
    await eventually(() => stalls() === 1, 15_000);

    await api(td.port, td.token, `/sessions/${id}/key`, { body: { key: 'enter' } });
    await eventually(async () => (await waiting())?.waitingOnPrompt === undefined, 15_000);
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });
});
