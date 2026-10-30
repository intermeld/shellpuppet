/**
 * Two of the strings the program emits, pinned against the code that
 * produces them.
 *
 * - The catch-all 500 says daemon.log records the error. The daemon's file
 *   logger is wired here as `src/daemon/index.ts` wires it, a request is made
 *   to fail inside `handleRequest`, and daemon.log is read at the moment the
 *   response is ended: the error line must already be there.
 * - A value flag given no value is refused by the CLI parser before any
 *   daemon contact, with exit code 2.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { Daemon } from '../../src/daemon/server.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { daemonLogPath, daemonStatePath, readDaemonState } from '../../src/daemon/paths.js';
import { makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const BODY =
  'The daemon hit an unexpected error handling this request. Its daemon.log records the error.';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

const homes: string[] = [];
const daemons: Daemon[] = [];

afterAll(async () => {
  for (const daemon of daemons) await daemon.stop();
  for (const home of homes) removeTempHome(home);
});

async function runCli(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: home },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('the catch-all 500 and daemon.log', () => {
  it('writes the error to daemon.log before the 500 goes out, and the CLI shows the body', async () => {
    const home = makeTempHome('daemon-500-');
    homes.push(home);
    const logPath = daemonLogPath(home);
    const daemon = new Daemon({ home, logger: createFileLogger(logPath) });
    daemons.push(daemon);
    const { port, token } = await daemon.start();

    // Fail only GET /sessions, from inside handleRequest, so /health and
    // discovery behave as they do in production.
    const target = daemon as unknown as { handleRequest: Handler };
    const original = target.handleRequest.bind(daemon);
    let logAtEnd: string | null = null;
    target.handleRequest = async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== '/sessions') return original(req, res);
      const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
      (res as unknown as { end: (...args: unknown[]) => http.ServerResponse }).end = (...args) => {
        logAtEnd = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
        return end(...args);
      };
      throw new Error('probe failure');
    };

    const response = await fetch(`http://127.0.0.1:${String(port)}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe(BODY);

    // The log line was on disk when the response was ended.
    expect(logAtEnd).not.toBeNull();
    const lines = (logAtEnd ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { level: string; message: string; meta?: { error?: string } });
    const entry = lines.find((line) => line.message === 'unhandled request error');
    expect(entry).toBeDefined();
    expect(entry?.level).toBe('error');
    expect(entry?.meta?.error).toBe('Error: probe failure');

    // What a CLI user sees: the body, under the status, and exit code 1.
    const listed = await runCli(home, 'list');
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain(`error (500): ${BODY}`);
    // The CLI reached this daemon; nothing else took the state file over.
    expect(readDaemonState(home)?.pid).toBe(process.pid);
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('deferring');
  }, 60_000);
});

describe('a value flag given no value', () => {
  it('is refused by the parser with exit code 2, before any daemon contact', async () => {
    const home = makeTempHome('cli-flag-');
    homes.push(home);
    const result = await runCli(home, 'wait', 's1', '--timeout');
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).toBe('--timeout needs a value.');
    expect(result.stdout).toBe('');
    expect(fs.existsSync(daemonStatePath(home))).toBe(false);
    expect(fs.existsSync(daemonLogPath(home))).toBe(false);
  }, 60_000);
});
