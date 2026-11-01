/**
 * The start contract over HTTP. node-pty 1.2.0-beta.18 creates a Windows
 * terminal's program only once its output worker has connected, and reports
 * pid 0 until then; a start that never created a program ends the session
 * with a code instead. The contract is what it was under 1.1.0's synchronous
 * spawn: `POST /sessions` answers only once the program exists, so a start
 * response carries a real pid, and a start that produced no program is a
 * failure — the same status and shape 1.1.0's thrown spawn produced, with
 * Windows' code in the message — leaving no session behind.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { api, interactiveShell, processAlive, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const daemons: TestDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop();
});

function alive(pid: unknown): boolean {
  return typeof pid === 'number' && pid > 0 && processAlive(pid);
}

describe.skipIf(process.platform !== 'win32')('the start contract', () => {
  it('answers with a pid of a program that exists', async () => {
    const td = await startTestDaemon();
    daemons.push(td);
    const started = await api(td.port, td.token, '/sessions', {
      body: { ...interactiveShell(), cols: 80, rows: 24, openViewer: false },
    });

    expect(started.status).toBe(200);
    // Never 0: the answer waited for node-pty's deferred program creation.
    expect(alive(started.body['pid'])).toBe(true);
  }, 60_000);

  it('fails a start whose program Windows cannot create, leaving no session', async () => {
    const td = await startTestDaemon();
    daemons.push(td);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-start-contract-'));
    try {
      // A file the start's own checks pass, an `.exe` like any program, that
      // Windows cannot run: it holds text, not an executable image.
      const file = path.join(dir, 'sink.exe');
      writeFileSync(file, 'console.log("not an executable image");\n');

      const refused = await api(td.port, td.token, '/sessions', {
        body: { command: file, shell: false, openViewer: false },
      });

      // The status and shape 1.1.0's thrown spawn produced, with Windows'
      // code in the message (193, not a valid Win32 application, or 216, a
      // machine-type mismatch).
      expect(refused.status).toBe(500);
      expect(refused.body['error']).toMatch(/^Failed to start session: Error: Cannot create process, error code: \d+$/);
      expect(refused.body['id']).toBeUndefined();

      // The failed start is not a session: nothing of it is listed.
      const listed = await api(td.port, td.token, '/sessions', { method: 'GET' });
      const ids = (listed.body['sessions'] as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);
});
