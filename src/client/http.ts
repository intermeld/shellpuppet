/**
 * Shared thin client used by the MCP adapter and the CLI (design §2.4),
 * including daemon discovery and auto-start.
 *
 * Two rules shape everything here (design §2.2):
 *
 * 1. The daemon is spawned FULLY DETACHED: `detached: true`,
 *    `stdio: 'ignore'`, `unref()`. Inheriting stdio causes the inherited-stdio
 *    hang: a daemon holding its parent's handles leaves the calling shell
 *    waiting for EOF forever.
 * 2. After spawning, poll health. A healthy daemon is success REGARDLESS of
 *    what happened to the child we spawned: parallel clients race to start
 *    the daemon routinely, and the loser's child exits by design.
 *
 * This module is inside the no-console lint scope: it must never write to
 * stdout or stderr (the MCP adapter loads it in-process).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  daemonStatePath,
  readDaemonState,
  removeDaemonStateIf,
  shellpuppetHome,
} from '../daemon/paths.js';
import { daemonRunning } from '../daemon/liveness.js';
import { packageVersion } from '../daemon/meta.js';
import { NULL_LOGGER } from '../core/types.js';
import type { Logger } from '../core/types.js';

const AUTO_START_TIMEOUT_MS = 10_000;
const AUTO_START_POLL_MS = 150;
const HEALTH_TIMEOUT_MS = 1_500;
/**
 * Further health checks, with longer timeouts, for a daemon that is still
 * running but did not answer the first: about ten seconds in all before the
 * caller is told it is busy.
 */
const PATIENT_HEALTH_TIMEOUTS_MS = [3_000, 5_000];

export interface DaemonConnection {
  port: number;
  token: string;
  /** The daemon's process, so a failed request can tell busy from gone. */
  pid: number;
  version: string;
  /** Human-readable warnings (e.g. version mismatch), which adapters surface. */
  warnings: string[];
}

/**
 * The daemon named in the state file is running but did not answer its health
 * check in time. It holds its sessions still, so it is neither cleared nor
 * replaced; the caller is told instead.
 */
export class DaemonNotAnsweringError extends Error {
  constructor(
    readonly pid: number,
    readonly port: number,
    readonly statePath: string,
  ) {
    // The pid could, rarely, have been reused by another program since the
    // record was written, so the way out never says to end it unchecked.
    super(
      `The ShellPuppet daemon (pid ${String(pid)}, port ${String(port)}) is running but did ` +
        `not answer in time; it may be busy. Its sessions are still there: try again ` +
        `shortly. If it stays unresponsive, check that pid ${String(pid)} is a ShellPuppet ` +
        `daemon before ending it; if no ShellPuppet daemon is running, delete ${statePath}.`,
    );
    this.name = 'DaemonNotAnsweringError';
  }
}

export interface ClientOptions {
  home?: string;
  logger?: Logger;
  /** Override the daemon entry script: tests point this at fixtures. */
  daemonEntry?: string;
  /**
   * Audit actor identity (design §4.5), sent as `x-shellpuppet-actor`. The
   * CLI passes `cli`, the MCP adapter `mcp:<clientInfo.name>`. A function is
   * resolved per request (the MCP client name is only known post-handshake).
   */
  actor?: string | (() => string);
  /**
   * Whether a request whose daemon has gone may start another and send the
   * request there, as every ordinary call does (design §2.2). False makes
   * such a request throw `DaemonGoneError` instead: the daemon verbs pass it,
   * because asking about or stopping a daemon must never start one.
   */
  autoStart?: boolean;
}

/**
 * The daemon a request went to has gone, and the caller asked for no other to
 * be started in its place (`autoStart: false`).
 */
export class DaemonGoneError extends Error {
  constructor(
    readonly pid: number,
    readonly port: number,
    options?: ErrorOptions,
  ) {
    super(
      `The ShellPuppet daemon (pid ${String(pid)}, port ${String(port)}) has stopped.`,
      options,
    );
    this.name = 'DaemonGoneError';
  }
}

interface HealthResponse {
  ok: boolean;
  version: string;
  pid: number;
}

async function health(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as HealthResponse).ok === true &&
      typeof (body as HealthResponse).version === 'string'
    ) {
      return body as HealthResponse;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The folder the daemon runs in: the user's home directory, whichever client
 * starts it. A process holds its working directory open, so on Windows a
 * daemon started in the first client's folder would keep that folder from
 * being deleted or renamed for as long as it ran. Not the ShellPuppet home:
 * the daemon creates and hardens that itself (design §4.1), and a client that
 * created it first would leave it unhardened. Undefined, and so inherited,
 * only where the home directory is not there to run in.
 */
export function daemonWorkingDirectory(): string | undefined {
  const home = os.homedir();
  try {
    return fs.statSync(home).isDirectory() ? home : undefined;
  } catch {
    return undefined;
  }
}

function defaultDaemonEntry(): string {
  // From dist/client/http.js this resolves to dist/daemon/index.js.
  return fileURLToPath(new URL('../daemon/index.js', import.meta.url));
}

function versionWarnings(daemonVersion: string): string[] {
  const own = packageVersion();
  if (daemonVersion === own) return [];
  // Design §9: two clones at different versions sharing one daemon is a real
  // source of confusion, so warn loudly, with the one-command remedy.
  return [
    `Daemon version ${daemonVersion} does not match this client (${own}). ` +
      `Behaviour may differ: run "shellpuppet daemon restart" to start the daemon ` +
      `from this client's build.`,
  ];
}

/**
 * Discover a healthy daemon via `~/.shellpuppet/daemon.json`, or return null.
 *
 * A record whose daemon has gone (crash, reboot) is stale and is cleared. A
 * daemon that is still running but slow to answer is busy, not gone (design
 * §2.3): it gets longer to answer, and if it still does not, the caller gets a
 * `DaemonNotAnsweringError`. Its record stays, so no second daemon starts
 * beside it.
 */
export async function discoverDaemon(options: ClientOptions = {}): Promise<DaemonConnection | null> {
  const home = options.home ?? shellpuppetHome();
  const state = readDaemonState(home);
  if (state === null) return null;
  const clearedAsGone = async (): Promise<boolean> => {
    if (await daemonRunning(state)) return false;
    (options.logger ?? NULL_LOGGER).info('clearing stale daemon.json', { pid: state.pid });
    removeDaemonStateIf(home, state);
    return true;
  };
  let alive = await health(state.port);
  if (alive === null) {
    if (await clearedAsGone()) return null;
    for (const timeoutMs of PATIENT_HEALTH_TIMEOUTS_MS) {
      alive = await health(state.port, timeoutMs);
      if (alive !== null) break;
    }
    if (alive === null) {
      // It may have gone while it was given longer to answer.
      if (await clearedAsGone()) return null;
      throw new DaemonNotAnsweringError(state.pid, state.port, daemonStatePath(home));
    }
  }
  return {
    port: state.port,
    token: state.token,
    pid: state.pid,
    version: alive.version,
    warnings: versionWarnings(alive.version),
  };
}

/**
 * Return a healthy daemon connection, auto-starting the daemon if needed.
 * Every client invocation must return promptly, always. It fails in two ways
 * only: a running daemon that does not answer (`DaemonNotAnsweringError`), and
 * a started daemon that does not become healthy within the polling cap.
 */
export async function ensureDaemon(options: ClientOptions = {}): Promise<DaemonConnection> {
  const logger = options.logger ?? NULL_LOGGER;
  const home = options.home ?? shellpuppetHome();

  const existing = await discoverDaemon(options);
  if (existing !== null) return existing;

  const entry = options.daemonEntry ?? defaultDaemonEntry();
  logger.info('auto-starting daemon', { entry });
  const cwd = daemonWorkingDirectory();
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore', // MUST be 'ignore': inherited handles hang the caller (§2.2)
    windowsHide: true,
    env: { ...process.env, SHELLPUPPET_HOME: home },
    ...(cwd !== undefined ? { cwd } : {}),
  });
  // A process that cannot start reports it as an 'error' event, which with no
  // listener would end this client. The poll below reports the failure.
  child.on('error', (error) => {
    logger.warn('the daemon process did not start', { error: String(error) });
  });
  child.unref();

  // A healthy /health response is success regardless of what happened to the
  // child we spawned (§2.2). Only the poll timing out is failure.
  const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readDaemonState(home);
    if (state !== null) {
      const alive = await health(state.port);
      if (alive !== null) {
        return {
          port: state.port,
          token: state.token,
          pid: state.pid,
          version: alive.version,
          warnings: versionWarnings(alive.version),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, AUTO_START_POLL_MS));
  }
  throw new Error(
    `The ShellPuppet daemon did not become healthy within ` +
      `${String(AUTO_START_TIMEOUT_MS / 1_000)} s. Check ${home}/daemon.log.`,
  );
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * One authenticated JSON request. If the daemon has gone since discovery
 * (stale state), re-ensure once and retry, because one-shot clients meet this
 * whenever the daemon idle-stopped moments earlier; with `autoStart: false`,
 * throw `DaemonGoneError` instead.
 *
 * A request that fails while its daemon is still running is reported, never
 * retried against another daemon. The caller holds session ids from this
 * daemon, and another would answer "no such session" for sessions that are
 * still running here.
 */
export async function request(
  connection: DaemonConnection,
  method: string,
  path: string,
  body?: unknown,
  options: ClientOptions = {},
): Promise<ApiResponse> {
  const actor = typeof options.actor === 'function' ? options.actor() : options.actor;
  const attempt = async (conn: DaemonConnection): Promise<ApiResponse> => {
    const response = await fetch(`http://127.0.0.1:${String(conn.port)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${conn.token}`,
        ...(actor !== undefined ? { 'x-shellpuppet-actor': actor } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    return await attempt(connection);
  } catch (error) {
    if (await daemonRunning(connection)) {
      const pid = String(connection.pid);
      const statePath = daemonStatePath(options.home ?? shellpuppetHome());
      throw new Error(
        `The ShellPuppet daemon (pid ${pid}, port ${String(connection.port)}) did not complete ` +
          `the request: ${error instanceof Error ? error.message : String(error)}. Its process ` +
          `is still running, so this client stays with it rather than starting another; try ` +
          `again shortly. If this persists, check that pid ${pid} is a ShellPuppet daemon. If ` +
          `it is not, restart this client, first deleting ${statePath} if it still names pid ` +
          `${pid}.`,
        { cause: error },
      );
    }
    if (options.autoStart === false) {
      throw new DaemonGoneError(connection.pid, connection.port, { cause: error });
    }
    const fresh = await ensureDaemon(options);
    connection.port = fresh.port;
    connection.token = fresh.token;
    connection.pid = fresh.pid;
    connection.version = fresh.version;
    return attempt(fresh);
  }
}
