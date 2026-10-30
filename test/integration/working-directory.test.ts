/**
 * Where the daemon runs, and where a session starts (design §2.2, §3.1).
 *
 * The daemon is started by whichever client finds none, so it runs in the
 * user's home directory rather than in that client's folder, which it would
 * otherwise hold open for as long as it ran. A session started without `cwd`
 * starts in the folder of the client that asked for it: the CLI and the MCP
 * server send their own working directory. A direct caller of the HTTP API
 * that sends none gets the user's home directory.
 *
 * Each case starts the daemon from one folder and asks from another, so a
 * session that started in the daemon's folder shows.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureDaemon } from '../../src/client/http.js';
import { readDaemonState } from '../../src/daemon/paths.js';
import {
  api,
  distDaemonEntry,
  makeTempHome,
  removeTempHome,
  repoRoot,
  startTestDaemon,
} from './helpers.js';
import type { TestDaemon } from './helpers.js';

const execFileAsync = promisify(execFile);
const RECORD_CWD = path.join(repoRoot, 'test', 'integration', 'fixtures', 'record-cwd-daemon.mjs');
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const mcpEntry = path.join(repoRoot, 'dist', 'mcp', 'index.js');

/** Prints the folder it runs in, then stays alive to be read. */
const PRINT_CWD = "console.log('CWD=' + process.cwd()); setInterval(() => {}, 1000)";

/** A folder, compared as the file system sees it. */
function place(folder: string): string {
  const real = fs.realpathSync.native(folder);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** The folder a session's program printed, once it has. */
async function printedCwd(port: number, token: string, id: string): Promise<string> {
  const waited = await api(port, token, `/sessions/${id}/wait?text=CWD%3D&timeout=20000`);
  expect(waited.body['matched']).toBe(true);
  const snapshot = await api(port, token, `/sessions/${id}/snapshot`);
  const line = String(snapshot.body['screen'])
    .split('\n')
    .find((row) => row.startsWith('CWD='));
  expect(line).toBeDefined();
  return line!.slice('CWD='.length).trimEnd();
}

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) {
    try {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A session's process tree can hold its folder for a moment after the
      // daemon has been told to end it; a leftover temp folder is harmless.
    }
  }
});

/** A folder of the test's own, standing in for a project a client runs in. */
function project(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-project-'));
  folders.push(folder);
  return folder;
}

describe('the auto-started daemon', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) {
      const state = readDaemonState(home);
      if (state !== null) {
        try {
          process.kill(state.pid);
        } catch {
          // Already gone.
        }
      }
      removeTempHome(home);
    }
  });

  it("runs in the user's home directory, not in the folder of the client that started it", async () => {
    const home = makeTempHome('shellpuppet-cwd-');
    homes.push(home);
    // This process's own working directory is the repository, which the
    // daemon would otherwise inherit.
    expect(place(process.cwd())).not.toBe(place(os.homedir()));
    await ensureDaemon({ home, daemonEntry: RECORD_CWD });
    const recorded = fs.readFileSync(path.join(home, 'spawned-cwd'), 'utf8');
    expect(place(recorded)).toBe(place(os.homedir()));
  }, 30_000);
});

describe('a session started without cwd over the HTTP API', () => {
  let td: TestDaemon;
  beforeAll(async () => {
    td = await startTestDaemon();
  });
  afterAll(async () => {
    await td.stop();
  });

  it("starts in the user's home directory, and takes a relative cwd from there", async () => {
    for (const cwd of [undefined, '.']) {
      const started = await api(td.port, td.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', PRINT_CWD],
          shell: false,
          cols: 200,
          ...(cwd !== undefined ? { cwd } : {}),
        },
      });
      expect(started.status).toBe(200);
      const printed = await printedCwd(td.port, td.token, String(started.body['id']));
      expect(place(printed), String(cwd)).toBe(place(os.homedir()));
    }
  });
});

describe('a session started by a client without cwd', () => {
  const home = makeTempHome('shellpuppet-cwd-clients-');
  const env = (): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) values[key] = value;
    }
    values['SHELLPUPPET_HOME'] = home;
    return values;
  };
  let port = 0;
  let token = '';

  beforeAll(async () => {
    // Started from this process, so the daemon is not in the clients' folders.
    const connection = await ensureDaemon({ home, daemonEntry: distDaemonEntry });
    port = connection.port;
    token = connection.token;
  }, 60_000);
  afterAll(async () => {
    try {
      await api(port, token, '/daemon/shutdown', { body: { force: true } });
    } catch {
      // Already gone.
    }
    removeTempHome(home);
  }, 60_000);

  it("starts in the CLI's working directory, and takes a relative --cwd from there", async () => {
    const folder = project();
    fs.mkdirSync(path.join(folder, 'sub'));
    for (const [flags, expected] of [
      [[], folder],
      [['--cwd', 'sub'], path.join(folder, 'sub')],
    ] as const) {
      const { stdout } = await execFileAsync(
        process.execPath,
        [cliEntry, 'start', '--json', '--no-shell', '--no-viewer', '--cols', '200', ...flags,
          process.execPath, '-e', PRINT_CWD],
        { cwd: folder, env: env(), timeout: 60_000 },
      );
      const id = String((JSON.parse(stdout) as { id: string }).id);
      expect(place(await printedCwd(port, token, id))).toBe(place(expected));
    }
  }, 120_000);

  it("starts in the MCP server's working directory", async () => {
    const folder = project();
    const client = new Client({ name: 'shellpuppet-cwd-tests', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [mcpEntry],
        env: env(),
        cwd: folder,
        stderr: 'pipe',
      }),
    );
    try {
      const result = (await client.callTool({
        name: 'terminal_start',
        arguments: { command: process.execPath, args: ['-e', PRINT_CWD], shell: false, cols: 200 },
      })) as { content?: { text?: string }[]; isError?: boolean };
      const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
      expect(result.isError, text).not.toBe(true);
      const id = /Session (\S+) started/.exec(text)?.[1];
      expect(id, text).toBeDefined();
      expect(place(await printedCwd(port, token, id!))).toBe(place(folder));
    } finally {
      await client.close();
    }
  }, 120_000);
});
