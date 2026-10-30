/**
 * Shared plumbing for integration tests: isolated homes, in-process daemons,
 * raw HTTP/WS clients and cross-platform command lines.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Daemon } from '../../src/daemon/server.js';
import type { DaemonOptions } from '../../src/daemon/server.js';
import { NULL_LOGGER } from '../../src/core/types.js';

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const distDaemonEntry = path.join(repoRoot, 'dist', 'daemon', 'index.js');

/** A disposable, isolated `~/.shellpuppet` substitute. */
export function makeTempHome(prefix = 'shellpuppet-test-'): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Silence the viewer launcher for every test home.
  //
  // Tests that drive the CLI spawn the REAL daemon entry point, and that entry
  // point supplies the product default of `isolated-app`, so without this the
  // suite opens a browser window per session it starts, on the desktop of
  // whoever is running it.
  //
  // Written as config rather than injected, because config.json is the real
  // mechanism a user has for turning this off, so the suite exercises the
  // documented escape hatch instead of a test-only back door.
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ viewer: { launchMode: 'none' } }, null, 2),
  );
  return home;
}

export function removeTempHome(home: string): void {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows can transiently hold logs open, and leaked temp dirs are tolerable.
  }
}

export interface TestDaemon {
  daemon: Daemon;
  home: string;
  port: number;
  token: string;
  stop: () => Promise<void>;
}

/** Start an in-process daemon on an isolated home. */
export async function startTestDaemon(
  overrides: Partial<DaemonOptions> = {},
): Promise<TestDaemon> {
  const home = overrides.home ?? makeTempHome();
  const daemon = new Daemon({
    home,
    logger: NULL_LOGGER,
    ...overrides,
  });
  const { port, token } = await daemon.start();
  return {
    daemon,
    home,
    port,
    token,
    stop: async () => {
      // Drain sessions in SMALL BATCHES before stopping the daemon. On
      // Windows the DELETE of a session whose program runs is a `taskkill`
      // run of its own: about six seconds with little else running, and up
      // to its 30 s cap on a loaded machine. A file that leaves dozens of
      // sessions would take minutes to drain one at a time, past the 60 s
      // afterAll hook budget. Batches of four stay inside it, and end fewer
      // programs at the same moment than the daemon's killAll, whose one
      // `taskkill` run ends them all together; node-pty 1.1.0 can crash
      // natively when programs end together (design §7). Test-harness
      // plumbing only: killAll stays covered by the manager unit tests and
      // the forced-shutdown lifecycle test.
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/sessions`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = (await response.json()) as { sessions?: { id: string }[] };
        const ids = (body.sessions ?? []).map((s) => s.id);
        for (let i = 0; i < ids.length; i += 4) {
          await Promise.all(
            ids.slice(i, i + 4).map((id) =>
              fetch(`http://127.0.0.1:${String(port)}/sessions/${id}`, {
                method: 'DELETE',
                headers: { authorization: `Bearer ${token}` },
              }),
            ),
          );
        }
      } catch {
        // Daemon already stopped or unreachable: killAll below covers it.
      }
      await daemon.stop();
      removeTempHome(home);
    },
  };
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

/** Authenticated JSON call against a test daemon. */
export async function api(
  port: number,
  token: string | null,
  apiPath: string,
  options: ApiOptions = {},
): Promise<ApiResult> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${apiPath}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Raw request with an arbitrary Host header: fetch refuses to forge one. */
export function rawRequestWithHost(
  port: number,
  host: string,
  requestPath = '/health',
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, headers: { host } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Do what a browser does with a viewer URL: load the page once, which redeems
 * the one-use grant, and keep the cookie the daemon set. The returned value is
 * a `Cookie:` header, which is the only thing that opens a viewer's socket
 * (design §4.1).
 */
export async function redeemViewerUrl(viewerUrl: string): Promise<string> {
  const response = await fetch(viewerUrl);
  await response.text();
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) {
    throw new Error(`viewer URL yielded no credential: ${String(response.status)}`);
  }
  return setCookie.split(';')[0] ?? '';
}

export interface WsClient {
  ws: WebSocket;
  /** Accumulated PTY output (binary frames). */
  received: () => string;
  /** JSON control messages received as text frames. */
  controls: () => Record<string, unknown>[];
  sawBinary: () => boolean;
  waitForData: (needle: string, timeoutMs?: number) => Promise<void>;
  waitForControl: (
    predicate: (c: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  close: () => void;
}

/**
 * Connect a WS client, splitting the wire protocol as the viewer does:
 * BINARY frames are PTY bytes, TEXT frames are JSON control messages.
 */
export function connectWs(
  port: number,
  sessionId: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/sessions/${sessionId}/stream?token=${token}`,
      { headers },
    );
    let buffer = '';
    let sawBinary = false;
    const controls: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (isBinary) {
        sawBinary = true;
        buffer += text;
        return;
      }
      try {
        controls.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        buffer += text; // unexpected non-JSON text frame: surface it in data
      }
    });
    const poll = <T>(
      probe: () => T | undefined,
      what: string,
      timeoutMs: number,
    ): Promise<T> =>
      new Promise<T>((resolvePoll, rejectPoll) => {
        const startedAt = Date.now();
        const check = (): void => {
          const value = probe();
          if (value !== undefined) {
            resolvePoll(value);
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            rejectPoll(new Error(`WS did not receive ${what} in time`));
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });
    ws.on('open', () => {
      resolve({
        ws,
        received: () => buffer,
        controls: () => controls,
        sawBinary: () => sawBinary,
        waitForData: async (needle, timeoutMs = 15_000) => {
          await poll(
            () => (buffer.includes(needle) ? true : undefined),
            JSON.stringify(needle),
            timeoutMs,
          );
        },
        waitForControl: (predicate, timeoutMs = 15_000) =>
          poll(() => controls.find(predicate), 'a matching control message', timeoutMs),
        close: () => ws.close(),
      });
    });
    ws.on('error', reject);
  });
}

/** Connect the way a browser does: no token in the URL, the viewer cookie instead. */
export function connectWsWithCookie(
  port: number,
  sessionId: string,
  cookie: string,
): Promise<WsClient> {
  return connectWs(port, sessionId, '', { cookie });
}

/** Expect a WS connection attempt to be refused during the handshake. */
export function expectWsRejected(
  port: number,
  sessionId: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/sessions/${sessionId}/stream?token=${token}`,
      { headers },
    );
    ws.on('open', () => {
      ws.close();
      reject(new Error('WS connection was accepted but should have been refused'));
    });
    ws.on('error', () => resolve());
  });
}

/** The HTTP status a WS upgrade attempt is refused with (101 if accepted). */
export function wsUpgradeStatus(
  port: number,
  sessionId: string,
  token: string | null,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const suffix = token !== null ? `?token=${token}` : '';
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/sessions/${sessionId}/stream${suffix}`,
    );
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    // With this listener registered, ws reports non-101 responses here
    // instead of as an opaque 'error'.
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.on('error', reject);
  });
}

/** The platform's interactive shell, spawned WITHOUT the wrapper. */
export function interactiveShell(): { command: string; shell: false } {
  return process.platform === 'win32'
    ? { command: process.env['ComSpec'] ?? 'cmd.exe', shell: false }
    : { command: '/bin/sh', shell: false };
}

/** Poll until `predicate` holds or the timeout lapses. */
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Condition not met within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
