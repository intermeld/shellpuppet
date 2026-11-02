import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const echo = path.join(repoRoot, 'test', 'integration', 'fixtures', 'argv-echo.mjs');
const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
const execFileAsync = promisify(execFile);
const values = [
  'with space', 'x=with space', 'say "hello"', '"quoted space"', 'trailing\\', 'with space\\',
  '%PATH%', '^', '&', '|', '<', '>', "single'quote", '', 'café 漢字',
  // The long value must still fit on one 300-column screen row with its JSON.
  'with\ttab', 'back\\\\"quote', 'x'.repeat(200) + ' end',
];

describe.skipIf(process.platform !== 'win32')('Windows start arguments', () => {
  let td: TestDaemon;
  beforeAll(async () => { td = await startTestDaemon(); }, 30_000);
  afterAll(async () => { await td.stop(); }, 60_000);

  it.each(values)('passes %j through a direct HTTP start', async (value) => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [echo, value], shell: false, openViewer: false, cols: 300 },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=ARGV%3D&timeout=20000`);
    expect(waited.body['matched']).toBe(true);
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    const row = String(snapshot.body['screen']).split('\n').find((line) => line.startsWith('ARGV='));
    expect(row).toBeDefined();
    expect(JSON.parse(row!.slice(5).trimEnd())).toEqual([value]);
  }, 30_000);

  it.each([false, true])('passes literal CLI arguments with shell=%s', async (shell) => {
    const value = shell ? 'x=with space' : '"quoted space"';
    const { stdout } = await execFileAsync(process.execPath, [cli, 'start', '--json', '--no-viewer',
      ...(shell ? [] : ['--no-shell']), process.execPath, echo, value], {
      env: { ...process.env, SHELLPUPPET_HOME: td.home }, timeout: 30_000,
    });
    const id = String((JSON.parse(stdout) as { id: string }).id);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=ARGV%3D&timeout=20000`);
    expect(waited.body['matched']).toBe(true);
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    const row = String(snapshot.body['screen']).split('\n').find((line) => line.startsWith('ARGV='));
    expect(row).toBeDefined();
    expect(JSON.parse(row!.slice(5).trimEnd())).toEqual(shell ? ['x=with', 'space'] : [value]);
  }, 60_000);

  it('passes the complete argument set through CLI --no-shell', async () => {
    const { stdout } = await execFileAsync(process.execPath, [cli, 'start', '--json', '--no-viewer',
      '--no-shell', '--cols', '300', process.execPath, echo, ...values], {
      env: { ...process.env, SHELLPUPPET_HOME: td.home }, timeout: 30_000,
    });
    const id = String((JSON.parse(stdout) as { id: string }).id);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=ARGV%3D&timeout=20000`);
    expect(waited.body['matched']).toBe(true);
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    const row = String(snapshot.body['screen']).split('\n').find((line) => line.startsWith('ARGV='));
    expect(row).toBeDefined();
    expect(JSON.parse(row!.slice(5).trimEnd())).toEqual(values);
  }, 60_000);

  it.each<[string, string[]]>([
    ['x=with space', ['x=with', 'space']],
    ['x="with space"', ['x=with space']],
  ])('documents shell parsing of %j', async (value, expected) => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [echo, value], shell: true, openViewer: false, cols: 300 },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=ARGV%3D&timeout=20000`);
    expect(waited.body['matched']).toBe(true);
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    const row = String(snapshot.body['screen']).split('\n').find((line) => line.startsWith('ARGV='));
    expect(row).toBeDefined();
    expect(JSON.parse(row!.slice(5).trimEnd())).toEqual(expected);
  }, 30_000);
});
