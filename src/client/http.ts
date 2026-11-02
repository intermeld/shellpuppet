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
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDaemonConfig } from '../daemon/config.js';
import { resolveLaunchCommand } from '../daemon/launchProfiles.js';
import {
  daemonStatePath,
  ensureHome,
  readDaemonState,
  removeDaemonStateIf,
  shellpuppetHome,
} from '../daemon/paths.js';
import { daemonRunning } from '../daemon/liveness.js';
import { packageVersion } from '../daemon/meta.js';
import { NULL_LOGGER } from '../core/types.js';
import { taskkillTrees } from '../core/session.js';
import type { Logger } from '../core/types.js';

const AUTO_START_TIMEOUT_MS = 10_000;
/** A person may need time to unlock a configured secrets wrapper. */
export const WRAPPED_START_TIMEOUT_MS = 120_000;
const AUTO_START_POLL_MS = 150;
const HEALTH_TIMEOUT_MS = 1_500;
/**
 * Further health checks, with longer timeouts, for a daemon that is still
 * running but did not answer the first: about ten seconds in all before the
 * caller is told it is busy.
 */
const PATIENT_HEALTH_TIMEOUTS_MS = [3_000, 5_000];
const EARLY_WRAPPER_EXIT_GRACE_MS = 10_000;
const START_LOCK_SOCKET = 'daemon-start.sock';
/** sockaddr_un.sun_path includes the terminating NUL byte. */
const POSIX_SOCKET_PATH_BYTES = { darwin: 104, other: 108 } as const;
const UNCOORDINATED_START = Symbol('uncoordinated daemon start');
type StartLockClaim = net.Server | null | typeof UNCOORDINATED_START;
let warnedInvalidDirect = false;
const reportedStartConfigProblems = new Set<string>();

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
  /** Bypass a configured start wrapper for this start only. */
  direct?: boolean;
  /** Test seam for failure cleanup. Normal wrapped starts use the named bound. */
  wrappedStartTimeoutMs?: number;
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
 * the daemon or its starting client creates and hardens that separately
 * (design §4.1). Undefined, and so inherited, only where the home directory
 * is not there to run in.
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

/** Resolve a configured wrapper without a shell or joined argument string. */
export function planDaemonStart(
  wrapper: readonly string[],
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  const program = wrapper[0] ?? '';
  const name = path.basename(program);
  const resolved = resolveLaunchCommand(program, cwd, env);
  if ('error' in resolved) {
    throw new Error(`daemon.startWith program ${name} could not be started: program not found.`);
  }
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(resolved.file)) {
    throw new Error(`daemon.startWith program ${name} cannot start directly on Windows; point it at the program itself (.exe or .com).`);
  }
  return { command: resolved.file, args: [...wrapper.slice(1), process.execPath, entry] };
}

/** End only the process tree rooted at the child this client spawned. */
async function endSpawnedWrapper(child: ChildProcess, logger: Logger): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) return;
  // Until Node observes the exit it holds the Windows process handle, so the
  // pid cannot be reused. On POSIX it has not reaped the child, so neither
  // its pid nor the process group id can be reused.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const failure = await taskkillTrees([pid]);
    if (failure !== null) {
      // If the tree walk timed out, end the still-live root through its held
      // child handle. The warning says descendants may need attention.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      logger.warn('daemon.startWith process tree cleanup did not complete', { pid, timedOut: failure.timedOut });
    }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      // The process group has already gone.
    }
  }
}

function startLockEndpoint(home: string): string {
  if (process.platform !== 'win32') {
    const inHome = path.join(home, START_LOCK_SOCKET);
    const limit = process.platform === 'darwin' ? POSIX_SOCKET_PATH_BYTES.darwin : POSIX_SOCKET_PATH_BYTES.other;
    if (Buffer.byteLength(inHome) + 1 <= limit) return inHome;
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('user id unavailable');
    const folder = path.join(os.tmpdir(), `shellpuppet-${String(uid)}`);
    try { fs.mkdirSync(folder, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new Error('unsafe short folder');
    }
    const hash = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
    const endpoint = path.join(folder, `start-${hash}.sock`);
    if (Buffer.byteLength(endpoint) + 1 > limit) throw new Error('short socket path exceeds platform limit');
    return endpoint;
  }
  const hash = createHash('sha256').update(path.resolve(home)).update('\0')
    .update(os.userInfo().username).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\shellpuppet-start-${hash}`;
}

function listenStartLock(server: net.Server, endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    };
    server.once('error', onError);
    server.listen(endpoint, () => { server.off('error', onError); resolve(true); });
  });
}

function socketRefused(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
  });
}

function startLockFailureReason(error: unknown): string {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  if (message === 'unsafe short folder' || message === 'user id unavailable' ||
      message === 'short socket path exceeds platform limit') return message;
  return 'endpoint preparation failed';
}

/** The listening endpoint is the lock: the OS releases it when this client dies. */
async function claimStartLock(home: string, logger: Logger): Promise<StartLockClaim> {
  let endpoint: string;
  try { endpoint = startLockEndpoint(home); }
  catch (error) {
    logger.warn(`daemon start coordination unavailable (${startLockFailureReason(error)}); starting without it`);
    return UNCOORDINATED_START;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = net.createServer((socket) => socket.destroy());
    try { if (await listenStartLock(server, endpoint)) return server; }
    catch (error) {
      logger.warn(`daemon start coordination unavailable (${startLockFailureReason(error)}); starting without it`);
      return UNCOORDINATED_START;
    }
    if (process.platform === 'win32' || !(await socketRefused(endpoint))) return null;
    // A POSIX socket pathname may survive a crash. Never follow or remove a
    // symlink or a regular file at this path.
    try {
      const stat = fs.lstatSync(endpoint);
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) {
        logger.warn('daemon start coordination unavailable (unsafe stale socket); starting without it');
        return UNCOORDINATED_START;
      }
      fs.unlinkSync(endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`daemon start coordination unavailable (${startLockFailureReason(error)}); starting without it`);
        return UNCOORDINATED_START;
      }
    }
  }
  logger.warn('daemon start coordination unavailable (stale socket remained); starting without it');
  return UNCOORDINATED_START;
}

function releaseStartLock(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function startWaitBound(home: string): number {
  return readDaemonConfig(home).config.daemon?.startWith === undefined ? AUTO_START_TIMEOUT_MS : WRAPPED_START_TIMEOUT_MS;
}

/** Let daemon stop and restart wait for a pending start without starting one. */
export async function waitForPendingDaemon(options: ClientOptions = {}): Promise<DaemonConnection | null> {
  const home = options.home ?? shellpuppetHome();
  if (!fs.existsSync(home)) return discoverDaemon(options);
  const deadline = Date.now() + startWaitBound(home);
  while (Date.now() < deadline) {
    const lock = await claimStartLock(home, options.logger ?? NULL_LOGGER);
    if (lock !== null) {
      try { return await discoverDaemon(options); }
      finally { if (lock !== UNCOORDINATED_START) await releaseStartLock(lock); }
    }
    await new Promise((resolve) => setTimeout(resolve, AUTO_START_POLL_MS));
  }
  throw new Error('A pending daemon start did not settle within its health bound.');
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
  const directValue = process.env['SHELLPUPPET_DAEMON_DIRECT'];
  if (directValue !== undefined && directValue !== '1' && !warnedInvalidDirect) {
    logger.warn('ignoring invalid SHELLPUPPET_DAEMON_DIRECT; only 1 is recognised');
    warnedInvalidDirect = true;
  }

  const homeResult = await ensureHome(home);
  if (homeResult.warning !== undefined) logger.warn(homeResult.warning);
  const waitDeadline = Date.now() + startWaitBound(home);
  let lock: StartLockClaim = null;
  while (Date.now() < waitDeadline) {
    const existing = await discoverDaemon(options);
    if (existing !== null) return existing;
    lock = await claimStartLock(home, logger);
    if (lock !== null) break;
    await new Promise((resolve) => setTimeout(resolve, AUTO_START_POLL_MS));
  }
  if (lock === null) throw new Error('A pending daemon start did not settle within its health bound.');
  try {
    const wonWhileClaiming = await discoverDaemon(options);
    if (wonWhileClaiming !== null) return wonWhileClaiming;

  const entry = options.daemonEntry ?? defaultDaemonEntry();
  const cwd = daemonWorkingDirectory();
  const env: NodeJS.ProcessEnv = { ...process.env, SHELLPUPPET_HOME: home };
  const parsed = readDaemonConfig(home);
  for (const problem of parsed.problems) {
    if ((problem.startsWith('daemon.') || problem.startsWith('daemon must') || problem.startsWith('daemon has')) &&
        !reportedStartConfigProblems.has(problem)) {
      logger.warn(problem);
      reportedStartConfigProblems.add(problem);
    }
  }
  const configured = parsed.config.daemon;
  const condition = configured?.startWithOnlyIfEnvContains;
  const wrapped = options.direct !== true && directValue !== '1' &&
    configured?.startWith !== undefined &&
    (condition === undefined || Object.values(env).some((value) => value?.includes(condition)));
  const wrapper = wrapped ? configured.startWith : undefined;
  const program = wrapper?.[0];
  const programName = program === undefined ? undefined : path.basename(program);
  let command = process.execPath;
  let args = [entry];
  if (program !== undefined) {
    try {
      ({ command, args } = planDaemonStart(wrapper ?? [], entry, cwd ?? process.cwd(), env));
    } catch (error) {
      const raced = await discoverDaemon(options);
      if (raced !== null) return raced;
      throw error;
    }
  }
  env['SHELLPUPPET_DAEMON_STARTED_WRAPPED'] = wrapped ? '1' : '0';
  logger.info('auto-starting daemon', { wrapped });
  let startError = false;
  let childExitAt: number | null = null;
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: 'ignore', // MUST be 'ignore': inherited handles hang the caller (§2.2)
      windowsHide: true,
      shell: false,
      env,
      ...(cwd !== undefined ? { cwd } : {}),
    });
  } catch {
    if (programName !== undefined) {
      throw new Error(`daemon.startWith program ${programName} could not be started.`);
    }
    throw new Error('The ShellPuppet daemon process could not be started.');
  }
  // A process that cannot start reports it as an 'error' event, which with no
  // listener would end this client. The poll below reports the failure.
  child.on('error', (error) => {
    startError = true;
    childExitAt = Date.now();
    logger.warn(programName === undefined ? 'the daemon process did not start' :
      `daemon.startWith program ${programName} did not start`, { code: (error as NodeJS.ErrnoException).code });
  });
  child.on('exit', () => { childExitAt = Date.now(); });
  child.unref();

  // A healthy /health response is success regardless of what happened to the
  // child we spawned (§2.2). Only the poll timing out is failure.
  const timeoutMs = wrapped ? (options.wrappedStartTimeoutMs ?? WRAPPED_START_TIMEOUT_MS) : AUTO_START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
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
    if (wrapped && childExitAt !== null && Date.now() - childExitAt >= EARLY_WRAPPER_EXIT_GRACE_MS) break;
    await new Promise((resolve) => setTimeout(resolve, AUTO_START_POLL_MS));
  }
  if (programName !== undefined) {
    await endSpawnedWrapper(child, logger);
    throw new Error(`daemon.startWith program ${programName} ${startError ? 'could not be started' :
      childExitAt !== null && Date.now() < deadline ? 'exited before the daemon became healthy' :
      `did not produce a healthy daemon within ${String(timeoutMs / 1_000)} s`}. Check daemon.log.`);
  }
  throw new Error(`The ShellPuppet daemon did not become healthy within ${String(timeoutMs / 1_000)} s. Check ${home}/daemon.log.`);
  } finally {
    if (lock !== UNCOORDINATED_START) await releaseStartLock(lock);
  }
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
