/**
 * Two of the strings the program emits, pinned against the code that
 * produces them.
 *
 * - The catch-all 500 says daemon.log records the error. The daemon's file
 *   logger is wired here as `src/daemon/index.ts` wires it, a request is made
 *   to fail inside `handleRequest`, and daemon.log is read at the moment the
 *   response is ended: the error line must already be there. The line holds
 *   the error's stack, the request's method and its path, and nothing from
 *   the query, the headers or the body, any of which can carry a credential.
 *   A target the URL parser refuses is logged the same way, and an
 *   absolute-form one by its path, without the scheme and authority.
 * - A value flag given no value is refused by the CLI parser before any
 *   daemon contact, with exit code 2.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as net from 'node:net';
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
/** The stack of the probe's error: its message, then the frames under it. */
const STACK_OF_PROBE = /^Error: probe failure\n\s+at /;

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
    expect(entry?.meta?.error).toMatch(STACK_OF_PROBE);

    // What a CLI user sees: the body, under the status, and exit code 1.
    const listed = await runCli(home, 'list');
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain(`error (500): ${BODY}`);
    // The CLI reached this daemon; nothing else took the state file over.
    expect(readDaemonState(home)?.pid).toBe(process.pid);
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('deferring');
  }, 60_000);
});

describe('the catch-all 500 log line', () => {
  it('names the method and the path, and leaves out the query, the headers and the body', async () => {
    const home = makeTempHome('daemon-500-path-');
    homes.push(home);
    const logPath = daemonLogPath(home);
    const daemon = new Daemon({ home, logger: createFileLogger(logPath) });
    daemons.push(daemon);
    const { port, token } = await daemon.start();

    // Fail /sessions from inside handleRequest, after reading the body when
    // there is one, so that the body was in hand when the error was logged.
    const target = daemon as unknown as { handleRequest: Handler };
    const original = target.handleRequest.bind(daemon);
    target.handleRequest = async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== '/sessions') return original(req, res);
      for await (const chunk of req) void chunk;
      throw new Error('probe failure');
    };

    const asked = await fetch(`http://127.0.0.1:${String(port)}/sessions?vt=query-secret&token=query-token`, {
      headers: { authorization: `Bearer ${token}`, 'x-probe': 'header-secret' },
    });
    expect(asked.status).toBe(500);
    const posted = await fetch(`http://127.0.0.1:${String(port)}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'body-secret' }),
    });
    expect(posted.status).toBe(500);

    const log = fs.readFileSync(logPath, 'utf8');
    const entries = log
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { message: string; meta?: Record<string, unknown> })
      .filter((line) => line.message === 'unhandled request error');
    expect(entries.map((line) => [line.meta?.['method'], line.meta?.['path']])).toEqual([
      ['GET', '/sessions'],
      ['POST', '/sessions'],
    ]);
    for (const line of entries) {
      expect(line.meta?.['error']).toMatch(STACK_OF_PROBE);
      expect(Object.keys(line.meta ?? {}).sort()).toEqual(['error', 'method', 'path']);
    }
    for (const secret of ['query-secret', 'query-token', 'header-secret', 'body-secret', token]) {
      expect(log).not.toContain(secret);
    }
  }, 60_000);
});

/** Send one raw request with `target` as its request target; resolves with the status line. */
function rawRequest(port: number, target: string, headers = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n${headers}Connection: close\r\n\r\n`);
    });
    let text = '';
    socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    socket.on('end', () => resolve(text.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

describe('the catch-all 500 log line for unusual request targets', () => {
  it('logs a target the URL parser refuses, and an absolute-form one, by the path alone', async () => {
    const home = makeTempHome('daemon-500-targets-');
    homes.push(home);
    const logPath = daemonLogPath(home);
    const daemon = new Daemon({ home, logger: createFileLogger(logPath) });
    daemons.push(daemon);
    const { port, token } = await daemon.start();

    // Targets `new URL` refuses: handleRequest throws before any route runs.
    const refused = await rawRequest(port, 'http://[/view?s=s1&vt=GRANT-SECRET-1');
    const relative = await rawRequest(port, '//[/sessions?token=TOKEN-SECRET-2', `Authorization: Bearer ${token}\r\n`);
    // An absolute-form target that parses, made to fail inside the handler:
    // its scheme and authority, user and password included, are not the path.
    const target = daemon as unknown as { handleRequest: Handler };
    const original = target.handleRequest.bind(daemon);
    target.handleRequest = async (req, res) => {
      if (!(req.url ?? '').includes('probe-absolute')) return original(req, res);
      throw new Error('probe failure');
    };
    const absolute = await rawRequest(
      port,
      `http://user:PASS-SECRET-3@127.0.0.1:${String(port)}/probe-absolute?vt=GRANT-SECRET-4`,
    );

    expect([refused, relative, absolute]).toEqual(Array(3).fill('HTTP/1.1 500 Internal Server Error'));
    const log = fs.readFileSync(logPath, 'utf8');
    const paths = log
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { message: string; meta?: Record<string, unknown> })
      .filter((line) => line.message === 'unhandled request error')
      .map((line) => line.meta?.['path']);
    expect(paths).toEqual(['/view', '//[/sessions', '/probe-absolute']);
    for (const secret of ['GRANT-SECRET-1', 'TOKEN-SECRET-2', 'PASS-SECRET-3', 'GRANT-SECRET-4', 'user:', token]) {
      expect(log).not.toContain(secret);
    }
    // The daemon still answers.
    expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(200);
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
