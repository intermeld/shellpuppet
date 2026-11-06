import * as path from 'node:path';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startDiagnostics } from './startDiagnostics.js';
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
  const diagnostics = startDiagnostics();
  beforeAll(async () => {
    td = await startTestDaemon({ logger: diagnostics.logger });
    diagnostics.attach(td);
  }, 30_000);
  afterEach((context) => {
    if (context.task.result?.state === 'fail') console.error(diagnostics.report());
  });
  afterAll(async () => {
    try { await td.stop(); }
    finally { diagnostics.close(); }
  }, 60_000);

  it('keeps API calls independent of idle sockets when a start blocks the event loop', async () => {
    // ConPTY can occupy the same thread as this test's fetch client. Reproduce
    // that scheduling window without depending on a slow native spawn.
    const server = http.createServer((request, response) => {
      const finish = (): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      };
      if (request.url === '/slow-start') {
        // The daemon awaits its program-pid poll before answering the start.
        setTimeout(() => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 7000);
          finish();
        }, 10);
      } else finish();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');
    try {
      await api(address.port, null, '/warm');
      await api(address.port, null, '/slow-start', { body: {} });
      expect(await api(address.port, null, '/wait')).toEqual({ status: 200, body: { ok: true } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

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
    // Every value is printed on one 300-column row here, so the long value (tested
    // on its own above) is left out to keep the row from wrapping.
    const shortValues = values.filter((value) => value.length < 100);
    const { stdout } = await execFileAsync(process.execPath, [cli, 'start', '--json', '--no-viewer',
      '--no-shell', '--cols', '300', process.execPath, echo, ...shortValues], {
      env: { ...process.env, SHELLPUPPET_HOME: td.home }, timeout: 30_000,
    });
    const id = String((JSON.parse(stdout) as { id: string }).id);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=ARGV%3D&timeout=20000`);
    expect(waited.body['matched']).toBe(true);
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    const row = String(snapshot.body['screen']).split('\n').find((line) => line.startsWith('ARGV='));
    expect(row).toBeDefined();
    expect(JSON.parse(row!.slice(5).trimEnd())).toEqual(shortValues);
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
