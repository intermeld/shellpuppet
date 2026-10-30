/**
 * Without the shell on Windows, letter case does not change the program-only
 * rule: a program named in capitals, and a bare name that PATHEXT (upper case
 * by default) extends, still starts; a batch file in mixed case is still
 * refused. A relative command is resolved from the session's working
 * directory, and that file is the one that runs.
 *
 * The programs started here are `cmd.exe` and this process's own Node, each
 * by a path Windows already uses for it. No alternate data stream is opened
 * and no system binary is copied.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

describe('a command started without the shell', () => {
  let td: TestDaemon;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-program-rule-'));
  beforeAll(async () => {
    td = await startTestDaemon();
  });
  afterAll(async () => {
    await td.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function startsAndPrints(
    command: string,
    marker: string,
    cwd?: string,
    args?: string[],
  ): Promise<void> {
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command,
        args: args ?? ['/d', '/c', 'echo', marker],
        shell: false,
        ...(cwd !== undefined ? { cwd } : {}),
      },
    });
    expect(started.status, `${command}: ${JSON.stringify(started.body)}`).toBe(200);
    const id = String(started.body['id']);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=${marker}&timeout=20000`);
    expect(waited.body['matched'], command).toBe(true);
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }

  it.runIf(process.platform === 'win32')('starts cmd.exe named in capitals', async () => {
    const upper = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'CMD.EXE').toUpperCase();
    await startsAndPrints(upper, 'program-rule-upper-exe');
  });

  it.runIf(process.platform === 'win32')('starts a bare cmd, which PATHEXT extends to cmd.EXE', async () => {
    await startsAndPrints('cmd', 'program-rule-bare-cmd');
  });

  it.runIf(process.platform === 'win32')('refuses a batch file whose extension is in mixed case', async () => {
    const file = path.join(dir, 'Mixed.Cmd');
    fs.writeFileSync(file, '@echo should-not-run\r\n');
    const refused = await api(td.port, td.token, '/sessions', {
      body: { command: file, shell: false },
    });
    expect(refused.status).toBe(400);
    expect(String(refused.body['error'])).toContain('Not a program Windows can start directly');
  });

  it('runs a relative command from the session working directory', async () => {
    const command = `.${path.sep}${path.basename(process.execPath)}`;
    await startsAndPrints(command, 'program-rule-relative', path.dirname(process.execPath), [
      '-e',
      'console.log("program-rule-relative")',
    ]);
  });
});
