/**
 * One PTY session: process + renderer + lifecycle (design §2.4).
 *
 * The session owns the real PTY (ConPTY on Windows), keeps the headless
 * renderer current, serialises that renderer for viewers, tracks readiness
 * and kills the whole process tree on demand (design §3.1), not just the PTY
 * child.
 *
 * Shell wrapping happens HERE, after the caller has already made its policy
 * decision against the pre-wrap command (design §4.3). Callers pass
 * `goose session`; this module turns it into `cmd.exe /c goose session` on
 * Windows because direct ConPTY spawns of single-file binaries hang (§7).
 *
 * No stdout/stderr: logging via the injected Logger only (lint-enforced).
 */

import { moduleFor } from '../agents/index.js';
import type { AgentModule, AgentSource } from '../agents/types.js';
import { validateStall, possibleStall, resolveSessionAgent, signatureForSession, stallTranscriptContent, StallScreenCache, StallTracker } from './reasoning.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import type { QueuedConsoleHost, SpawnWindow } from './windowsConsoleHost.js';
import { ensureSpawnHelperExecutable, explainSpawnFailure, loadNodePty } from './nativePty.js';
import { ScreenRenderer } from './renderer.js';
import type { SerializeOptions, StyledLine } from './renderer.js';
import { commandLine } from './policy.js';
import { detectPrompt, createPromptReader, StalePromptGuard } from './promptDetector.js';
import { waitFor } from './waiter.js';
import { readinessFor, trackReadiness, waitUntilReady } from './readiness.js';
import type { Readiness } from './readiness.js';
import type { WaiterInternals } from './waiter.js';
import type { WaitTarget } from './waiter.js';
import {
  canReadExitCode,
  listenForTerminalErrors,
  observeConptyStartError,
  recordedExitCode,
  releaseFailedStarts,
} from './windowsPtyStart.js';
import { queueConsoleHostEnd, registerConsoleHostWindow } from './windowsConsoleHost.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
  MAX_WAIT_TIMEOUT_MS,
  NULL_LOGGER,
  RESERVED_FEATURE_CREDENTIALS,
} from './types.js';
import type {
  Logger,
  ScreenSnapshot,
  SessionEnvMode,
  SessionOptions,
  SessionSummary,
  StartReadyResult,
  StallState,
  WaitCondition,
  WaitOptions,
  WaitResult,
} from './types.js';

/**
 * Hard cap on `taskkill`. Without it a wedged kill never calls back, so
 * `kill()` never resolves, `killAll()` never resolves and daemon shutdown
 * never completes. The daemon then becomes an immortal, undiscoverable
 * process the user can only end via Task Manager.
 *
 * **Why 30 s.** On a real Qoder CLI tree (78 descendants, because it spawns
 * an MCP-server fleet) `taskkill /T /F` took **5,433 ms**. A cap tighter than
 * a normal kill cuts the walk short and leaves the tree to the `pty.kill()`
 * fallback below, the path that cannot reach console-detached descendants.
 * The cap exists to bound the wedged case, not to be tighter than the normal
 * case.
 */
export const TREE_KILL_TIMEOUT_MS = 30_000;

/** Quote one literal argument for the Windows C runtime's argv parser. */
export function windowsArgument(arg: string): string {
  let result = '"';
  let backslashes = 0;
  for (const character of arg) {
    if (character === '\\') {
      backslashes++;
    } else if (character === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += '\\'.repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return result + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * How long a kill waits for node-pty's deferred program creation (Windows):
 * the pid is 0 from the spawn until the output worker has connected and the
 * program exists. node-pty gives the connection up after five seconds of its
 * own and reports an exit instead, so this bound is never what ends the wait:
 * either the pid arrives, or the session does.
 */
const PROGRAM_PID_WAIT_MS = 8_000;

/** What a `taskkill` run reported when it did not simply succeed. */
export interface TreeKillFailure {
  /** Our timeout fired and `taskkill` was terminated mid-walk. */
  timedOut: boolean;
  exitCode: number | string | null;
  elapsedMs: number;
}

/**
 * Tree-kill processes with one `taskkill /T /F` run (Windows). Resolves with
 * null on success and with what went wrong otherwise; never rejects.
 */
export type TreeKiller = (pids: readonly number[]) => Promise<TreeKillFailure | null>;

/**
 * One `taskkill` run for any number of trees. Every run enumerates every
 * process on the machine before it kills anything, and that is most of its
 * cost. Measured on a Windows machine running about 2,700 processes: 9 to
 * 13 s for one lone process; thirty concurrent runs, one per session, each
 * overran the 30 s cap; one run given all thirty pids took 10 s. So daemon
 * shutdown kills every tree in one run (`SessionManager.killAll`).
 */
export const taskkillTrees = (pids: readonly number[], timeoutMs = TREE_KILL_TIMEOUT_MS): Promise<TreeKillFailure | null> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      'taskkill',
      ['/T', '/F', ...pids.flatMap((pid) => ['/PID', String(pid)])],
      // A line of output per process killed, descendants included.
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error) => {
        resolve(
          error
            ? {
                // Node also kills a child whose output overruns maxBuffer. Only
                // our timeout counts here, so that case is excluded explicitly:
                // Node 22 leaves `killed` off it, but that is its detail, not a
                // promise.
                timedOut: error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                exitCode: error.code ?? null,
                elapsedMs: Date.now() - startedAt,
              }
            : null,
        );
      },
    );
  });

/**
 * Very large input is written to the PTY in chunks of this size, with
 * WRITE_CHUNK_DELAY_MS between them (see Session.write), but ONLY when the app
 * has not enabled bracketed paste (see PASTE_START below).
 *
 * The threshold is deliberately well above a normal prompt. Chunking exists for
 * the OS limit underneath: a terminal's input buffer is finite (4 KB in
 * canonical mode on Linux), so one multi-kilobyte write to a line-buffered
 * program genuinely can be truncated. Below the threshold nothing changes, so
 * ordinary typing and single keys are untouched.
 */
const WRITE_CHUNK_CHARS = 1024;
const WRITE_CHUNK_DELAY_MS = 8;
export { MUSE_SUBMIT_DELAY_MS } from '../agents/index.js';

/**
 * Bracketed paste (DEC private mode 2004). A TUI that enables it is telling us
 * it wants multi-character input delivered as ONE paste event rather than as a
 * stream of keystrokes, and every real terminal obliges.
 *
 * This matters because chunking and TUIs are actively incompatible. Sent in
 * chunks, a 1,079-character prompt reached Qoder's input box with only its
 * TAIL, while a raw-mode PTY sink received all 1,315 bytes of a
 * marker-bracketed probe across two chunks, front marker and tail marker both
 * present. So the bytes always arrive, and it is the receiving widget that
 * discards everything before the last burst. Chunking a TUI's input is
 * how the loss happens.
 *
 * So: track what the app asks for (it emits `ESC[?2004h` / `ESC[?2004l` on its
 * output stream) and match it. Bracketed paste on → wrap and write once, no
 * chunking, no delay. Off → the OS-limit chunking above still applies, because
 * a line-buffered program has no paste concept and a 4 KB write really can be
 * cut.
 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
/** DECTCEM: tracked because xterm's serialisation omits it. See viewerState(). */
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
/** A full terminal reset (RIS) and a soft one (DECSTR): both show the cursor. */
const TERMINAL_RESET = '\x1bc';
const SOFT_RESET = '\x1b[!p';

/**
 * Whether the cursor is hidden after this chunk of program output, given
 * whether it was before. The LAST transition in the chunk wins (a TUI
 * re-asserts its modes on every redraw). A reset counts as showing, because
 * both kinds show the cursor (see TERMINAL_RESET).
 */
export function cursorHiddenAfter(scan: string, current: boolean): boolean {
  const hide = scan.lastIndexOf(CURSOR_HIDE);
  const show = Math.max(
    scan.lastIndexOf(CURSOR_SHOW),
    scan.lastIndexOf(TERMINAL_RESET),
    scan.lastIndexOf(SOFT_RESET),
  );
  if (hide === -1 && show === -1) return current;
  return hide > show;
}

/**
 * Whether bracketed paste (DEC 2004) is on after this chunk of program
 * output, given whether it was before. The twin of `cursorHiddenAfter`, and
 * for the same reason: the emulator the daemon mirrors turns the mode OFF on
 * a reset, so this scan does too. In @xterm/headless both RIS (`ESC c`) and
 * DECSTR (`ESC [ ! p`) reach `CoreService.reset()`, which puts the DEC
 * private modes back to their defaults, where bracketed paste is false.
 *
 * After a reset the program does not expect paste markers, and would read
 * `ESC[200~` and `ESC[201~` around a long write as literal input. The last
 * transition in the chunk wins, as above: a TUI re-asserts its modes on
 * every redraw.
 */
export function bracketedPasteAfter(scan: string, current: boolean): boolean {
  const on = scan.lastIndexOf(PASTE_MODE_ON);
  const off = Math.max(
    scan.lastIndexOf(PASTE_MODE_OFF),
    scan.lastIndexOf(TERMINAL_RESET),
    scan.lastIndexOf(SOFT_RESET),
  );
  if (on === -1 && off === -1) return current;
  return on > off;
}
/** One short of the longest mode sequence: enough to rejoin any split of one. */
const MODE_SCAN_TAIL_CHARS = PASTE_MODE_ON.length - 1;

/**
 * A command that cannot be started as given: a bare name not on PATH, a path
 * that is not an executable file, or on Windows a script started without the
 * shell. A caller error, mapped to 400.
 */
export class CommandNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandNotFoundError';
  }
}

/**
 * The Windows build number of an `os.release()` string (`10.0.19045` → 19045),
 * or 0 when the string names none.
 */
export function windowsBuildNumber(release: string): number {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(release);
  return parts === null ? 0 : Number(parts[3]);
}

/**
 * The first Windows build with ConPTY, as node-pty's own README states:
 * Windows 10 version 1809, build 18309. node-pty 1.2.0 removed its winpty
 * fallback, so a session cannot start on a build below this.
 */
export const CONPTY_MINIMUM_BUILD = 18309;

/**
 * A start on a Windows build with no ConPTY, which node-pty 1.2.0 cannot run
 * a terminal on (it removed the winpty fallback). A caller error, mapped to
 * 400: nothing about the daemon is wrong, and the message names the floor.
 */
export class WindowsWithoutConPTYError extends Error {
  constructor(build: number) {
    super(
      `This Windows build (${String(build)}) has no ConPTY, which node-pty 1.2.0 needs for every terminal: ` +
        `Windows 10 version 1809 (build ${String(CONPTY_MINIMUM_BUILD)}) or later is required to start a session.`,
    );
    this.name = 'WindowsWithoutConPTYError';
  }
}

/**
 * Input for a session whose input pipe has failed (Windows): refused, because
 * written it would be lost. The daemon answers it with a 409.
 */
export class SessionInputFailedError extends Error {
  constructor(id: string, cause: Error) {
    super(
      `Session ${id}'s input pipe has failed (${String(cause)}), so input cannot reach its program. ` +
        'Kill the session and start it again.',
      { cause },
    );
    this.name = 'SessionInputFailedError';
  }
}

/**
 * A resize of a session whose program node-pty has seen end: refused, as there
 * is no terminal left to resize. It can be asked for in the moment between that
 * end and the session's exit, which follows once node-pty has flushed the last
 * output. The daemon answers it with the 409 a session that has exited gets.
 */
export class SessionProgramEndedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly exitCode: number | null,
  ) {
    super(exitCode === null
      ? `Cannot resize session ${sessionId}: it has ended or is being killed.`
      : `Cannot resize session ${sessionId}: its program has exited (code ${String(exitCode)}).`);
    this.name = 'SessionProgramEndedError';
  }
}

/**
 * Resolve a command to a concrete executable path before spawning directly
 * (`shell: false`). Necessary on **every** platform, for different reasons:
 *
 * - **Windows:** node-pty does not search PATH at all, and fails with a bare
 *   `File not found:` naming nothing.
 * - **POSIX:** this is worse, because `pty.spawn` of a nonexistent command
 *   *succeeds*. execvp fails inside the forked child, the parent never learns
 *   and the caller gets a healthy-looking session that is silently dead. An
 *   agent would then wait out its full timeout for output that can never
 *   arrive.
 *
 * Resolving up front turns both into an immediate, actionable error.
 *
 * On Windows the file found must be a program Windows starts as one: an
 * `.exe` or a `.com`. A batch file (`.bat`, `.cmd`) is refused, because
 * Windows would hand it to cmd.exe with the arguments quoted for a program's
 * parser, which cmd reads by different rules. A `.ps1` or an extensionless
 * script is refused too. A path whose file name contains `:` names an
 * alternate data stream and is refused before anything is opened. A command
 * that contains a path separator and is not absolute is resolved from the
 * session's working directory, and that absolute path is what is checked and
 * what is started.
 */

/**
 * Whether a Windows path's file name names an alternate data stream.
 * The last path component holds the stream (`run.cmd:payload.exe`). A drive
 * prefix (`C:`) is never in that component, so `C:\dir\app.exe` and the
 * drive-relative `C:app.exe` are false. Strings only: nothing is opened.
 */
export function windowsCandidateNamesStream(candidate: string): boolean {
  return path.win32.basename(candidate).includes(':');
}

function resolveExecutable(command: string, platform: NodeJS.Platform, cwd: string): string {
  const isWindows = platform === 'win32';

  const usable = (candidate: string): boolean => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  // On Windows a bare name usually needs a PATHEXT suffix; try suffixed forms
  // first unless the caller already supplied one.
  const extensions = isWindows
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')
    : [];
  const candidatesFor = (base: string): string[] => {
    if (!isWindows) return [base];
    const alreadyExtended = extensions.some((e) =>
      base.toLowerCase().endsWith(e.toLowerCase()),
    );
    return alreadyExtended
      ? [base, ...extensions.map((e) => base + e)]
      : [...extensions.map((e) => base + e), base];
  };

  const explicitPath = /[\\/]/.test(command) || (isWindows && /^[a-z]:/i.test(command));
  // A relative command that names a path is taken from the session's cwd, so
  // the file checked is the file started. A drive-relative command (`D:app.exe`,
  // `D:dir\app.exe`) keeps its drive and is not rewritten. A bare name is found
  // on PATH.
  const rooted =
    /[\\/]/.test(command) && !path.isAbsolute(command) && !(isWindows && /^[a-z]:/i.test(command))
      ? path.resolve(cwd, command)
      : command;
  const searchBases = explicitPath
    ? [rooted]
    : (process.env['PATH'] ?? '')
        .split(path.delimiter)
        .filter((d) => d !== '')
        .map((dir) => path.join(dir, command));

  const described = (candidate: string): string =>
    candidate === command ? command : `${command} (${candidate})`;

  for (const base of searchBases) {
    for (const candidate of candidatesFor(base)) {
      // Before the file is opened: a stream's stat would succeed and report
      // a file, and a name ending in `.exe` would then pass the suffix check.
      if (isWindows && windowsCandidateNamesStream(candidate)) {
        throw new CommandNotFoundError(
          `Not a program Windows can start directly: ${described(candidate)}. ` +
            `With shell:false (--no-shell) a path whose file name contains ':' names an ` +
            `alternate data stream, and that is refused. The command must be an .exe or .com file.`,
        );
      }
      if (!usable(candidate)) continue;
      if (isWindows && !/\.(exe|com)$/i.test(candidate)) {
        throw new CommandNotFoundError(
          `Not a program Windows can start directly: ${described(candidate)}. With shell:false (--no-shell) ` +
            `the command must be an .exe or .com file. Drop shell:false to run it through the ` +
            `shell, or give its interpreter as the command and the file as an argument.`,
        );
      }
      return candidate;
    }
  }

  const shown = rooted === command ? command : `${command} (${rooted})`;
  throw new CommandNotFoundError(
    explicitPath
      ? `Not an executable file: ${shown}.`
      : `Command not found on PATH: ${command}. Give an absolute path, or drop ` +
        `shell:false (--no-shell) and let the shell wrapper resolve it.`,
  );
}

export interface SessionDeps {
  /** A retry retains the identity resolved by its first start attempt. */
  resolvedAgent?: { agent: string; agentSource: AgentSource };
  logger?: Logger;
  /** Platform override, for tests only. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Windows release override (`os.release()`), for tests only. Defaults to
   * the real one, whose build number decides the ConPTY floor.
   */
  osRelease?: string;
  /**
   * How long a kill waits for the deferred program's pid, for tests only.
   * Defaults to `PROGRAM_PID_WAIT_MS`.
   */
  pidWaitMs?: number;
  /** Environment hygiene mode (design §4.6). Defaults to `DEFAULT_SESSION_ENV`. */
  sessionEnv?: SessionEnvMode;
  /** Windows tree killer override, for tests only. Defaults to `taskkillTrees`. */
  treeKiller?: TreeKiller;
  /**
   * Console-host queue, for tests only. Defaults to the real queue.
   * A session calls it only when `platform` is Windows.
   */
  queueConsoleHostEnd?: (item: QueuedConsoleHost) => void;
  /** Window registration override, for tests only. */
  registerConsoleHostWindow?: (id: string, window: SpawnWindow, platform: NodeJS.Platform) => void;
  /** Internal second attempt: the retry log already names this session. */
  retryAttempt?: boolean;
  /** PTY spawn, for tests only. Defaults to node-pty. No process is started. */
  spawn?: (
    file: string,
    args: string[] | string,
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string | undefined>;
    },
  ) => IPty;
}

/**
 * A session gets the clean baseline unless the configuration says otherwise
 * (ADR-008): the daemon's environment is whatever the client that auto-started
 * it had, so passing it on would hand that client's secrets to every session.
 */
export const DEFAULT_SESSION_ENV: SessionEnvMode = 'clean';

/**
 * The minimal functional variable set for `sessionEnv: "clean"`: enough for
 * shells and ordinary programs to work, without the daemon's secrets. Windows
 * needs rather more scaffolding than POSIX to be usable at all: the standard
 * variables below carry no secrets, and toolchains such as MSBuild, the .NET
 * SDK, PowerShell modules and Git for Windows look for them. POSIX keeps the
 * locale, without which terminal programs lose UTF-8.
 */
const CLEAN_ENV_KEYS: Record<'win32' | 'posix', string[]> = {
  win32: [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'COMSPEC',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'USERNAME',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMDATA',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'OS',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'CommonProgramW6432',
    'ALLUSERSPROFILE',
    'PUBLIC',
    'COMPUTERNAME',
    'USERDOMAIN',
    'USERDOMAIN_ROAMINGPROFILE',
    'LOGONSERVER',
    'PSModulePath',
    'NoDefaultCurrentDirectoryInExePath',
  ],
  posix: ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'],
};

// Words that mark a variable name as holding a credential. A name is split into
// words at underscores, at lower-to-upper case changes and before the last
// capital of a run of capitals, so `PAYMENT_API_KEY`, `GithubToken`, `GHToken`,
// `S3Key` and `SSH_AUTH_SOCK` match while `MAX_TOKENS`, `PWD` and
// `GIT_AUTHOR_NAME` do not. A word ending in one of CREDENTIAL_SUFFIXES matches
// too, for names written as one word (`GITHUBTOKEN`, `PGPASSWORD`). The list is
// advisory: a name need say nothing of what it holds (`DATABASE_URL`), which is
// why sessions start clean rather than relying on it.
const CREDENTIAL_WORDS = new Set([
  'KEY',
  'KEYS',
  'APIKEY',
  'TOKEN',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWORDS',
  'PASSWD',
  'PASS',
  'PW',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'CREDS',
  'COOKIE',
  'AUTH',
  'AUTHORIZATION',
  'BEARER',
  'JWT',
  'PAT',
  'SAS',
  'DSN',
  'WEBHOOK',
]);
const CREDENTIAL_SUFFIXES = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'APIKEY',
  'ACCESSKEY',
  'SECRETKEY',
  'PRIVATEKEY',
];

function looksLikeCredential(name: string): boolean {
  return name
    // A lookahead, not `([A-Z]+)([A-Z][a-z])`: that backtracks quadratically on
    // a long run of capitals, and a name can be as long as the environment.
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/_+/)
    .some((word) => CREDENTIAL_WORDS.has(word) || CREDENTIAL_SUFFIXES.some((suffix) => word.endsWith(suffix)));
}

/**
 * The names (never the values) of variables in `source` whose names look like
 * credentials, sorted: part of what `passthrough` would hand every session.
 */
export function credentialShapedNames(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(source)
    .filter((name) => source[name] !== undefined && source[name] !== '')
    .filter(looksLikeCredential)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Build the PTY environment for a session. Variable-name matching is
 * case-insensitive on every platform: Windows environment names are, and a
 * list in the configuration means the same wherever the daemon runs.
 *
 * An explicit allowlist is the CLEAN baseline plus the listed names: a bare
 * list would strip system scaffolding that processes need to start at all
 * (verified: node.exe aborts in CSPRNG initialisation without `SystemRoot` on
 * Windows), and "functional minimum plus exactly what you name" is the intent
 * of the mode: naming secrets in, not naming plumbing.
 *
 * `passed` is the session's own variables from the client that started it
 * (`SessionOptions.env`), set on top of whatever the mode gave. On Windows a
 * passed name replaces the inherited variable of the same name in any case,
 * rather than sitting beside it as a second copy.
 *
 * A name reserved for a connected feature's credential (ADR-007) is never
 * carried, whichever mode is in force: `passthrough` copies the daemon's
 * environment and a list mode can name anything, so the filter has to sit
 * here rather than in one caller. A session's own `passed` value is not the
 * daemon's copy and is left alone.
 */
export function buildSessionEnv(
  mode: SessionEnvMode,
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv = process.env,
  passed: Record<string, string> = {},
  reserved: ReadonlySet<string> = RESERVED_FEATURE_CREDENTIALS,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows reads variable names without case, so a reserved name is matched
  // that way there and exactly elsewhere, as every other name is.
  const isReserved = (name: string): boolean =>
    platform === 'win32'
      ? [...reserved].some((entry) => entry.toUpperCase() === name.toUpperCase())
      : reserved.has(name);
  if (mode === 'passthrough') {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && !isReserved(key)) env[key] = value;
    }
  } else {
    const baseline = CLEAN_ENV_KEYS[platform === 'win32' ? 'win32' : 'posix'];
    const wanted = new Set(
      (mode === 'clean' ? baseline : [...baseline, ...mode]).map((k) => k.toUpperCase()),
    );
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && wanted.has(key.toUpperCase()) && !isReserved(key)) {
        env[key] = value;
      }
    }
  }
  const setOnly = (name: string, value: string): void => {
    if (platform === 'win32') {
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      }
    }
    env[name] = value;
  };
  for (const [name, value] of Object.entries(passed)) setOnly(name, value);
  // Always injected (§7): Windows sets no TERM, and TUIs then assume a dumb
  // terminal and disable colour. On Windows any other casing goes first, or
  // the child would see that copy's value instead of these.
  setOnly('TERM', 'xterm-256color');
  setOnly('COLORTERM', 'truecolor');
  return env;
}

export class Session implements WaitTarget {
  readonly id: string;
  readonly label: string;
  /** What this session is for, for the human watching it. */
  readonly purpose: string;
  /** The audit actor that started it: set by the daemon, not by the body. */
  readonly startedBy: string;
  /** The pre-wrap command as given by the caller. */
  readonly command: string;
  readonly args: string[];
  /** The agent it was started as, which chooses how its screen is read. */
  readonly agent: string;
  readonly agentSource: AgentSource;
  private readonly agentModule: AgentModule | undefined;
  private readonly promptReader: ReturnType<typeof createPromptReader>;
  readonly createdAt: Date;

  private readonly pty: IPty;
  private readonly renderer: ScreenRenderer;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly endConsoleHost: (item: QueuedConsoleHost) => void;
  private readonly registerConsoleHost: (id: string, window: SpawnWindow, platform: NodeJS.Platform) => void;
  private readonly spawnPty: SessionDeps['spawn'];
  private readonly treeKiller: TreeKiller;
  /** How long a kill waits for the deferred program's pid (a test seam). */
  private readonly pidWaitMs: number;
  /** Set once a wait for the program's pid has run out (`programPid`). */
  private programWaitExpired = false;
  /** Whether the program has bracketed paste (DEC 2004) enabled. See PASTE_START. */
  private bracketedPaste = false;
  /**
   * Whether the most recent `write` took the bracketed-paste branch.
   * Diagnostic only. A program that enabled bracketed paste can still report
   * no markers, and from outside the two causes cannot be told apart: we
   * wrapped and the transport stripped the markers off the input (ConPTY
   * can), or the write raced ahead of the flag. This says which.
   */
  lastWriteWrapped: boolean | null = null;
  /** Trailing output kept so a mode sequence split across PTY reads is still seen. */
  private modeScanTail = '';
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private readonly readyListeners = new Set<() => void>();
  private readonly stallListeners = new Set<(state: StallState | undefined) => void>();
  private readonly stallTracker = new StallTracker();
  private stallState: StallState | undefined;
  private stallTimer: NodeJS.Timeout | null = null;
  private stallScheduled: Promise<void> | null = null;
  private stallNextCheck = 0;
  private stallContent: string | undefined;
  private stallValidatedContent: string | undefined;
  private stallTranscript: string | undefined;
  private stallValidatedTranscript: string | undefined;
  private stallValidationPending = false;
  // One second covers the measured delayed ConPTY growth redraws under load.
  // Only a new geometry change can renew it; output and duplicate requests cannot.
  private stallResizeUntil = 0;
  // The PTY size last accounted for, so a size we requested is not counted
  // again when the PTY reports it with the program's first later output.
  private stallPtyCols = 0;
  private stallPtyRows = 0;
  private readonly stallScreen = new StallScreenCache();
  private readonly stallInk: ReturnType<ScreenRenderer['watchForeground']> | undefined;

  /** Whether the program has hidden the cursor (DECTCEM off), carried to viewers. */
  private cursorHidden = false;
  /** Serialises write() so chunked writes cannot interleave. See write(). */
  private writeChain: Promise<void> = Promise.resolve();
  private submissionsQueued = 0;
  /** Why the input pipe failed (Windows), once it has: input is refused from then on. */
  private inputFailure: Error | null = null;
  private lastChange = Date.now();
  /** Sticky: the rendered screen has shown something at least once. */
  private painted = false;
  /**
   * The last input written, for the waiter's echo guard. Memory only, never
   * logged: §4.5 keeps keystroke content out of the audit trail, and this
   * is one string overwritten by the next write.
   */
  private lastInputData: string | null = null;
  /** Which prompt the last input answered, and whether it has since gone. */
  private readonly stalePrompts = new StalePromptGuard();
  private exitedFlag = false;
  private exitedAtValue: number | null = null;
  private exitCodeValue: number | null = null;
  private conptyStartError: Error | null = null;
  /** The tree kill under way for a program whose session ended with no exit code. */
  private endingProgram: Promise<void> | null = null;
  private readyFlag: boolean;
  private readyReasonValue: SessionSummary['readyReason'] = 'not-tracked';
  private readonly startupReadiness: Readiness | undefined;
  private geometryHeldFlag: boolean;
  private killPromise: Promise<void> | null = null;
  private consoleHostSettlement: Promise<boolean> | null = null;
  /**
   * Times taken immediately before and after the spawn, on Windows. ConPTY
   * creates the console host during that call. Null on any other platform.
   */
  private consoleHostWindow: SpawnWindow | null = null;
  /** The end has been queued once. A kill and an exit must not queue it twice. */
  private consoleHostQueued = false;

  constructor(id: string, options: SessionOptions, deps: SessionDeps = {}) {
    this.id = id;
    this.command = options.command;
    this.args = options.args ?? [];
    this.label = options.label ?? options.command;
    this.purpose = options.purpose ?? '';
    this.startedBy = options.startedBy ?? 'unknown';
    const resolved = deps.resolvedAgent ?? resolveSessionAgent(options.agent, options.command);
    this.agent = resolved.agent;
    this.agentSource = resolved.agentSource;
    this.agentModule = moduleFor(this.agent);
    // Refuse an unsupported wait before allocating a renderer or a terminal.
    const readiness = readinessFor(options, this.agentModule);
    this.startupReadiness = options.waitReady === true ? readiness : undefined;
    this.promptReader = createPromptReader(this.agent);
    this.createdAt = new Date();
    this.logger = deps.logger ?? NULL_LOGGER;
    this.platform = deps.platform ?? process.platform;
    this.treeKiller = deps.treeKiller ?? taskkillTrees;
    this.endConsoleHost = deps.queueConsoleHostEnd ?? queueConsoleHostEnd;
    this.registerConsoleHost = deps.registerConsoleHostWindow ?? registerConsoleHostWindow;
    this.spawnPty = deps.spawn;
    this.pidWaitMs = deps.pidWaitMs ?? PROGRAM_PID_WAIT_MS;

    // node-pty 1.2.0 is ConPTY-only on Windows: the winpty fallback is gone,
    // so a build below the ConPTY floor cannot start anything. Refused here,
    // with the floor named, rather than deep inside ConPTY as a bare
    // "Cannot launch conpty".
    // The real release is read only on a real Windows host: a test that
    // simulates Windows elsewhere (`platform`) would otherwise read a POSIX
    // kernel version as build 0. A test of the floor passes `osRelease`.
    const release = deps.osRelease ?? (process.platform === 'win32' ? os.release() : undefined);
    if (this.platform === 'win32' && release !== undefined) {
      const build = windowsBuildNumber(release);
      if (build < CONPTY_MINIMUM_BUILD) throw new WindowsWithoutConPTYError(build);
    }

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    this.renderer = new ScreenRenderer({ cols, rows, scrollback: DEFAULT_SCROLLBACK, agent: this.agent });
    this.stallInk = this.agentModule?.stalls === undefined ? undefined :
      this.renderer.watchForeground(this.agentModule.stalls.flatMap(shape => shape.marker.fg));
    if (this.agentModule?.stalls !== undefined) this.renderer.onResize(() => this.noteStallResize(true));

    // cols/rows say where to START, and nothing more: a size that also froze
    // the grid would leave a viewer with a grid it could not change, and a
    // window of a different shape could only letterbox. Holding is asked
    // for explicitly, because the common case is a human watching in a browser
    // that should simply fill, and the rare case is a run that would be
    // invalidated by a reflow.
    this.geometryHeldFlag = options.hold === true;

    const { file, fileArgs } = this.wrapCommand(options);
    if (!deps.retryAttempt) this.logger.info('session spawn', {
      id,
      command: this.command,
      args: this.args,
      wrapped: file !== this.command,
      // Names only: the values are secrets more often than not.
      ...(options.env !== undefined ? { envNames: Object.keys(options.env) } : {}),
    });

    // node-pty is loaded on the first start, not with the daemon, so an install
    // that left it unable to open a terminal fails here with what to do
    // (`nativePty.ts`). A test spawn stands in and loads nothing.
    const spawn = this.spawnPty === undefined ? loadNodePty().spawn : undefined;
    // A Windows start that fails part-way must not leave node-pty's
    // half-built terminal behind (`windowsPtyStart.ts`).
    if (spawn !== undefined && process.platform === 'win32') releaseFailedStarts();
    if (spawn !== undefined) ensureSpawnHelperExecutable();
    // On Windows, ConPTY creates the console host inside this synchronous
    // call, before it returns. The two times are the window a later list
    // uses to recognise that host. Nothing is listed here, and the start
    // does not wait. The platform is the session's, so a test can stand in
    // for Windows without a Windows process.
    const trackConsoleHost = this.platform === 'win32';
    const consoleHostT0 = trackConsoleHost ? Date.now() : 0;
    const spawnOptions = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      // The daemon always passes the mode it resolved and reports; this
      // default serves code that uses SessionManager or Session directly.
      env: buildSessionEnv(
        deps.sessionEnv ?? DEFAULT_SESSION_ENV,
        this.platform,
        process.env,
        options.env,
      ),
    };
    try {
      if (this.spawnPty !== undefined) {
        this.pty = this.spawnPty(file, fileArgs, spawnOptions);
      } else if (spawn !== undefined) {
        this.pty = spawn(file, fileArgs, spawnOptions);
      } else {
        throw new Error('session spawn is not available');
      }
    } catch (error) {
      // On Windows node-pty loads its native module here, as the terminal is
      // built, so a missing binary surfaces now rather than at the load above.
      throw explainSpawnFailure(error);
    }
    if (trackConsoleHost) {
      this.consoleHostWindow = { t0: consoleHostT0, t1: Date.now() };
      this.registerConsoleHost(this.id, this.consoleHostWindow, this.platform);
    }
    if (this.platform === 'win32') {
      observeConptyStartError(this.pty, (error) => { this.conptyStartError = error; });
    }
    // An error on a Windows terminal's pipes must not take the daemon down
    // (`windowsPtyStart.ts`). Logged once a stream: for the known cause, the
    // console host has gone and the session's exit follows. Input after the
    // input pipe has failed would be lost, so `write` refuses it.
    if (process.platform === 'win32') {
      const reported = new Set<string>();
      listenForTerminalErrors(this.pty, (error, stream) => {
        if (stream === 'input') this.inputFailure ??= error;
        if (reported.has(stream)) return;
        reported.add(stream);
        this.logger.warn(`session ${stream} failed`, { id, error: String(error) });
      });
    }

    this.stallPtyCols = this.pty.cols;
    this.stallPtyRows = this.pty.rows;
    this.pty.onData((data) => {
      if (this.exitedFlag || this.isKilled) return;
      // node-pty can apply a requested resize later, after its first output.
      // Observe the dimensions it reports as well as our explicit requests.
      if (this.pty.cols !== this.stallPtyCols || this.pty.rows !== this.stallPtyRows) {
        this.stallPtyCols = this.pty.cols; this.stallPtyRows = this.pty.rows;
        this.noteStallResize(true);
      }
      // Track bracketed-paste mode from the app's own output (see PASTE_START).
      //
      // Scanned with a carry-over tail because PTY read boundaries are
      // arbitrary: an 8-byte `ESC[?2004h` can straddle two onData callbacks,
      // and a missed transition leaves us writing down the WRONG path for the
      // rest of the session. Keeping the last few characters and
      // prefixing them costs nothing and closes the split.
      //
      // lastIndexOf, not includes: one burst can turn the mode on and off
      // again (TUIs re-assert their modes on redraw), and only the LAST
      // transition reflects the state the app ended up in.
      const scan = this.modeScanTail + data;
      this.bracketedPaste = bracketedPasteAfter(scan, this.bracketedPaste);
      this.cursorHidden = cursorHiddenAfter(scan, this.cursorHidden);
      this.modeScanTail = scan.slice(-MODE_SCAN_TAIL_CHARS);
      const rendered = this.renderer.write(data);
      if (this.agentModule?.stalls !== undefined) {
        void rendered.then(() => {
          if (this.stallTracker.tracking || this.stallInk?.possible) this.deferStall();
        }).catch(() => {
          this.publishStall(undefined);
          this.logger.warn('stall reading failed', { id: this.id });
        });
      }
      // First paint is decided by the RENDERER, not by bytes arriving: ConPTY
      // emits mode-set sequences ~140 ms after spawn that draw nothing, and a
      // quiet/readyQuiet that counted them as output would report a CLI ready
      // before its first byte. Checked per chunk only until it
      // holds, so the snapshot cost stops at the first visible character.
      if (!this.painted) {
        void rendered.then(() => {
          if (!this.exitedFlag && !this.isKilled && !this.painted && this.renderer.snapshot().screen !== '') this.painted = true;
        });
      }
      this.lastChange = Date.now();
      for (const listener of this.dataListeners) listener(data);
    });

    this.pty.onExit(({ exitCode: reported }) => {
      // node-pty closes a Windows terminal whose output socket failed and
      // reports an exit with no code, while the program runs on: the session
      // can no longer be read or typed into, so it has ended, and its program
      // is ended at once rather than left running where nobody can see or
      // reach it (`endProgram`).
      const exitCode = typeof reported === 'number' ? reported : null;
      this.exitedFlag = true;
      this.clearStallTimer();
      this.publishStall(undefined);
      this.exitedAtValue = Date.now();
      this.exitCodeValue = exitCode;
      this.lastChange = Date.now();
      this.logger.info('session exit', { id, exitCode });
      if (!this.programEnded) this.endingProgram = this.endProgram();
      for (const listener of this.exitListeners) listener(exitCode);
      // The console host is a child of the daemon, so the program ending
      // leaves it running. A later list ends the one host created in this
      // spawn's window. Nothing here waits for that list.
      this.queueConsoleHost();
    });

    // Readiness (§3.1): first paint ≠ ready. With no condition given the
    // session counts as ready at spawn; otherwise readiness flips when the
    // condition holds. A session whose condition never holds stays not-ready,
    // which is the truth and is visible in list/snapshot output.
    if (readiness !== undefined) {
      this.readyFlag = false;
      this.readyReasonValue = 'pending';
      // Preserve the existing explicit-condition path without the switch.
      if (options.waitReady === true) this.trackStartupReadiness();
      else {
        void waitFor(this, options.readyText !== undefined ? { text: options.readyText } : { quiet: options.readyQuiet },
          { timeout: MAX_WAIT_TIMEOUT_MS }).then(result => this.recordReadiness(result.matched, result.reason));
      }
    } else {
      // No condition was asked for, so nothing is being checked. `ready` is
      // true, meaning only that the process started, and `readyReason` says
      // plainly that it is not evidence. Some agent CLIs emit nothing for tens
      // of seconds and silently discard input typed during that window, so a bare
      // `true` here is the most dangerous value in the API.
      this.readyFlag = true;
      this.readyReasonValue = 'not-tracked';
    }
  }

  /**
   * Windows default: wrap in `cmd.exe` (§7: direct ConPTY spawns of
   * single-file binaries hang). POSIX default: direct spawn; `shell: true`
   * wraps in `/bin/sh -c`.
   *
   * The Windows form is `cmd.exe /d /s /c "<line>"` passed as a VERBATIM
   * string (node-pty applies no quoting to string args). `/s` pins cmd's
   * strip-first-and-last-quote behaviour so the outer quotes vanish cleanly
   * and every quote inside `<line>` survives. Without it, a command path
   * containing spaces (e.g. `C:\Program Files\nodejs\node.exe`) is split at
   * the first space. This is the same invocation libuv uses for shell spawns.
   */
  private wrapCommand(options: SessionOptions): { file: string; fileArgs: string[] | string } {
    const wantShell = options.shell ?? this.platform === 'win32';
    if (!wantShell) {
      return {
        // The same absolute path is checked and started. See `shell` on SessionOptions.
        file: resolveExecutable(
          options.command,
          this.platform,
          path.resolve(options.cwd ?? process.cwd()),
        ),
        // node-pty's array serialiser skips outer quoting for an argument
        // which itself begins and ends with quotes. A quoted value containing
        // a space then splits in the child. Its string form is passed through
        // verbatim, so serialise literal argv ourselves on Windows.
        fileArgs: this.platform === 'win32'
          ? (options.args ?? []).map(windowsArgument).join(' ')
          : options.args ?? [],
      };
    }
    // Quote the command token if it has whitespace and the caller has not
    // already quoted it; args are shell text and pass through untouched.
    const commandToken =
      /\s/.test(options.command) && !options.command.startsWith('"')
        ? `"${options.command}"`
        : options.command;
    const line = commandLine(commandToken, options.args ?? []);
    if (this.platform === 'win32') {
      const comspec = process.env['ComSpec'] ?? 'cmd.exe';
      return { file: comspec, fileArgs: `/d /s /c "${line}"` };
    }
    return { file: '/bin/sh', fileArgs: ['-c', line] };
  }

  get pid(): number {
    return this.pty.pid;
  }
  get cols(): number {
    return this.renderer.cols;
  }
  get rows(): number {
    return this.renderer.rows;
  }
  get ready(): boolean {
    return this.readyFlag;
  }
  /** Why `ready` holds its value. See {@link SessionSummary.readyReason}. */
  get readyReason(): SessionSummary['readyReason'] {
    return this.readyReasonValue;
  }
  /**
   * True only when the grid is HELD: `hold` at start, or a resize that asked
   * for it. A held grid keeps its size while viewports connect and reshape
   * themselves around it; an unheld grid belongs to the controlling viewport,
   * which fits it to the human's window (design §5).
   */
  get geometryHeld(): boolean {
    return this.geometryHeldFlag;
  }
  get exited(): boolean {
    return this.exitedFlag;
  }
  /** Epoch ms of process exit: the manager's reap grace counts from here. */
  get exitedAt(): number | null {
    return this.exitedAtValue;
  }
  /**
   * The program's exit code once the session has ended. Null while it runs,
   * and for a session that ended with no code because its output failed: the
   * code node-pty records for its program afterwards is not reported
   * (`howSessionEnded`).
   */
  get exitCode(): number | null {
    return this.exitCodeValue;
  }
  /**
   * Whether the session's program is known to have ended: node-pty has
   * recorded its exit code, or its exit came with a code. Until then its
   * tree is walked. The recorded code is enough on its own, before this
   * session's exit event: node-pty closes the process handle first, so the
   * pid is already free. Where node-pty records none (`canReadExitCode`),
   * an exit with no code counts as the end: a pid nothing vouches for is
   * never walked.
   */
  get programEnded(): boolean {
    // node-pty records the code only after it has closed the process handle,
    // which frees the pid, and about a second before this session's exit.
    // The pid is already not the program's, so it is not walked.
    if (recordedExitCode(this.pty) !== undefined) return true;
    return this.exitedFlag && (this.exitCodeValue !== null || !canReadExitCode(this.pty));
  }
  /** Whether the input pipe has failed (Windows): input is refused from then on. */
  get inputFailed(): boolean {
    return this.inputFailure !== null;
  }
  get watchers(): number {
    return this.dataListeners.size;
  }

  // ------------------------------------------------------------- WaitTarget
  getScreen(): string {
    return this.renderer.snapshot().screen;
  }
  lastChangeAt(): number {
    return this.lastChange;
  }
  isExited(): boolean {
    return this.exitedFlag;
  }
  hasPainted(): boolean {
    return this.painted;
  }
  lastInput(): string | null {
    return this.lastInputData;
  }
  observePrompt(signature: string | null): void {
    this.stalePrompts.observe(signature);
  }
  isStalePrompt(signature: string): boolean {
    return this.stalePrompts.isStale(signature);
  }

  // ------------------------------------------------------------------ input

  /**
   * Write to the PTY the way the program on the other end asked to be written
   * to: as a bracketed paste when it enabled that mode, otherwise chunked.
   *
   * Anything under WRITE_CHUNK_CHARS goes straight through either way, so keys
   * and human typing are unaffected. Above it the two paths diverge, and the
   * divergence is the point. See PASTE_START for the evidence that chunking a
   * TUI's input is what loses the front of a long prompt.
   *
   * **Writes are serialised.** The chunked path yields between pieces, and this
   * tool's whole premise is that a human and an agent share one session. So
   * without a queue a keystroke (or a multi-character paste, which is what xterm
   * hands us for a clipboard drop) could land *between* an earlier write's
   * chunks and interleave two inputs into gibberish. Making that ordering the
   * caller's problem would be a trap; the queue keeps writes in call order,
   * as a synchronous write would.
   *
   * Resolves with the screen as it was rendered just before this input went
   * in, taken in the queue, so an earlier write still going in cannot be
   * mistaken for this one's effect (`terminal_type`'s verify compares with it).
   *
   * Rejects with `SessionInputFailedError` once the input pipe has failed,
   * including for the rest of a chunked write it fails part-way through.
   */
  write(data: string, options: { terminalReport?: boolean } = {}): Promise<string> {
    const delayedSubmit = this.delayedSubmission(data);
    if (delayedSubmit) this.submissionsQueued++;
    const queued = this.writeChain.then(() => this.writeInput(data, options.terminalReport === true));
    // The chain must survive a failed write, or one rejection would wedge every
    // subsequent write on this session.
    this.writeChain = queued.then(
      () => { if (delayedSubmit) this.submissionsQueued--; },
      () => { if (delayedSubmit) this.submissionsQueued--; },
    );
    return queued;
  }

  private delayedSubmission(data: string): boolean {
    const submit = this.agentModule?.input?.submit;
    return submit?.delayMs !== undefined && submit.matches?.(data) === true;
  }

  private async writeInput(data: string, terminalReport: boolean): Promise<string> {
    this.refuseIfInputFailed();
    // Recorded BEFORE the bytes go in, when the screen still shows what this
    // input is answering: the waiter's stale-prompt guard needs that prompt,
    // and its echo guard needs the input itself.
    this.lastInputData = data;
    if (!terminalReport && data.length > 0) {
      // Discovery may still be queued. Capture the screen this input answers
      // before suppressing it, so a delayed check cannot announce that old turn.
      if (this.agentModule?.stalls !== undefined && !this.stallTracker.tracking) {
        await this.renderer.flush();
        if (this.stallInk?.possible) this.refreshStall();
      }
      this.stallTracker.noteInput();
      this.clearStallTimer();
      this.publishStall(undefined);
    }
    const { screen } = this.renderer.snapshot();
    this.stalePrompts.noteInput(screen, this.agent);

    if (this.delayedSubmission(data)) {
      const body = data.slice(0, -1);
      await this.writeData(body);
      await new Promise((resolve) => setTimeout(resolve, this.agentModule!.input!.submit!.delayMs));
      this.refuseIfInputFailed();
      this.refuseIfEnded();
      this.pty.write(this.agentModule!.input!.submit!.key);
      return screen;
    }

    await this.writeData(data);
    return screen;
  }

  private async writeData(data: string): Promise<void> {
    if (data.length <= WRITE_CHUNK_CHARS) {
      this.pty.write(data);
      return;
    }

    // Bracketed paste: ONE write, no chunking, exactly as a terminal delivers a
    // clipboard drop. The submitting newline (if the caller appended one) is
    // deliberately left OUTSIDE the markers. Inside, a TUI treats it as
    // literal text in the pasted block and the prompt is composed but never
    // sent, which looks identical to input being ignored.
    if (this.bracketedPaste) {
      const newlineAt = data.search(/[\r\n]+$/);
      const body = newlineAt === -1 ? data : data.slice(0, newlineAt);
      const trailer = newlineAt === -1 ? '' : data.slice(newlineAt);
      this.lastWriteWrapped = true;
      this.pty.write(`${PASTE_START}${body}${PASTE_END}${trailer}`);
      return;
    }
    this.lastWriteWrapped = false;

    let offset = 0;
    while (offset < data.length) {
      // The pipe can fail while a chunk is in flight.
      this.refuseIfInputFailed();
      let end = Math.min(offset + WRITE_CHUNK_CHARS, data.length);

      // Never split a surrogate pair: half of an astral character is not a
      // character, and the two halves arriving in separate writes decode to
      // replacement characters rather than the emoji the caller sent.
      if (end < data.length) {
        const code = data.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }

      this.pty.write(data.slice(offset, end));
      offset = end;
      if (offset < data.length) {
        await new Promise((resolve) => setTimeout(resolve, WRITE_CHUNK_DELAY_MS));
      }
    }
  }

  /** Input written after the input pipe has failed would be lost: refuse it. */
  private refuseIfInputFailed(): void {
    if (this.inputFailure !== null) throw new SessionInputFailedError(this.id, this.inputFailure);
  }

  private refuseIfEnded(): void {
    if (this.exitedFlag || this.isKilled) throw new Error(`Session ${this.id} exited while input was being written.`);
  }

  /**
   * Resize the PTY.
   *
   * Every caller arrives here, a viewport whose window changed shape and an
   * agent asking for a specific grid alike, because the resize itself is the
   * same act either way. What differs is only whether the caller also means to stop
   * anyone else changing it, and that is said explicitly with `hold` rather
   * than inferred from who is calling. Omitting `hold` leaves the current
   * setting alone, so a viewport following a window cannot quietly release a
   * hold that a scripted run is relying on.
   *
   * Throws `SessionProgramEndedError` once node-pty has seen the program end,
   * where it records that (`recordedExitCode`): there is no terminal left to
   * resize, and node-pty itself throws for that on a Windows terminal that has
   * drawn.
   * On Windows a resize asked for before the terminal's first output is held
   * by node-pty and run later; one that finds the program ended by then is
   * dropped (`windowsPtyStart.ts`).
   */
  resize(cols: number, rows: number, options: { hold?: boolean } = {}): void | Promise<void> {
    if (this.agentModule?.input?.resizeBehindSubmit === true && this.submissionsQueued > 0) {
      const queued = this.writeChain.then(() => this.resizeNow(cols, rows, options));
      this.writeChain = queued.then(() => undefined, () => undefined);
      return queued;
    }
    this.resizeNow(cols, rows, options);
  }

  private resizeNow(cols: number, rows: number, options: { hold?: boolean }): void {
    if (this.exitedFlag || this.isKilled) throw new SessionProgramEndedError(this.id, this.exitCodeValue);
    const ended = recordedExitCode(this.pty);
    if (ended !== undefined) throw new SessionProgramEndedError(this.id, ended);
    const oldCols = this.renderer.cols;
    const oldRows = this.renderer.rows;
    this.pty.resize(cols, rows);
    this.stallPtyCols = this.pty.cols; this.stallPtyRows = this.pty.rows;
    this.noteStallResize(cols !== this.renderer.cols || rows !== this.renderer.rows);
    this.renderer.resize(cols, rows);
    this.logger.debug('session resized', { id: this.id, oldCols, oldRows, cols, rows });
    // Unsettled candidates rebase on local reflow. Established notices keep
    // their validated baselines until the bounded native redraw finishes.
    if (this.agentModule?.stalls !== undefined && this.stallState === undefined) {
      this.stallContent = this.stallScreen.content(this.renderer.plainViewport(), this.agentModule.stalls);
      this.stallTranscript = this.readStallTranscript();
      this.scheduleStall();
    }
    if (options.hold !== undefined) this.geometryHeldFlag = options.hold;
  }

  answerablePrompt(screen: string, now = Date.now()): ReturnType<typeof detectPrompt> {
    const styled = this.agentModule?.createPromptSettler === undefined ? undefined : this.renderer.styledLines().lines;
    return this.promptReader(screen, now, styled);
  }

  // ----------------------------------------------------------------- output
  /** Live raw-stream subscription (viewer mirroring). Returns unsubscribe. */
  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Notify the daemon when the readiness condition settles. */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  onStall(listener: (state: StallState | undefined) => void): () => void {
    this.stallListeners.add(listener);
    return () => this.stallListeners.delete(listener);
  }

  getStalled(): StallState | undefined { return this.stallState; }

  private noteStallResize(changed: boolean): void {
    if (this.stallState === undefined || (this.stallResizeUntil !== 0 && !changed)) return;
    this.stallResizeUntil = Date.now() + 1000;
    this.clearStallTimer();
    this.queueStallCheck(() => this.refreshStall(), 1000);
  }

  /** Let PTY delivery finish before comparing a rendered batch. */
  private deferStall(): void {
    if (this.stallScheduled !== null) return;
    this.stallScheduled = new Promise(resolve => {
      setImmediate(() => {
        this.stallScheduled = null;
        try { this.scheduleStall(); }
        catch { this.publishStall(undefined); this.logger.warn('stall reading failed', { id: this.id }); }
        finally { resolve(); }
      });
    });
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /** Let ready I/O run before a due validation, retaining cancellation. */
  private queueStallCheck(check: () => void, delay: number): void {
    const timer = setTimeout(() => {
      setImmediate(() => {
        // Input, exit or a restored frame may have cancelled this deadline
        // after it became due but before the queued validation can run.
        if (this.stallTimer === timer) check();
      });
    }, delay);
    this.stallTimer = timer;
    timer.unref();
  }

  private publishStall(state: StallState | undefined): void {
    if (state === undefined) this.stallResizeUntil = 0;
    if (this.stallState === state) return;
    this.stallState = state;
    for (const listener of this.stallListeners) listener(state);
  }

  private readStallTranscript(): string {
    const signature = signatureForSession(this) ?? undefined;
    return stallTranscriptContent(this.renderer.framedViewport(this.agentModule!.stalls!.flatMap(shape => shape.frameColumns)),
      this.agentModule!.stalls!, signature);
  }

  /** Both output tasks and due timers must compare before rebasing. */
  private compareStallTranscript(): void {
    const transcript = this.readStallTranscript();
    if (transcript !== '' && transcript !== this.stallTranscript && transcript !== this.stallValidatedTranscript) {
      this.stallTracker.invalidate();
      this.publishStall(undefined);
      this.stallValidationPending = false;
      this.clearStallTimer();
    }
    this.stallTranscript = transcript;
  }

  private scheduleStall(): void {
    if (this.exitedFlag || this.isKilled) return;
    // Framing anchors, marker ink, footer and transcript ownership can all
    // disappear during a resize. Retain the validated comparison baselines
    // until the fixed deadline, including if an early complete frame returns.
    if (this.stallState !== undefined && this.stallResizeUntil !== 0) return;
    if (!this.stallTracker.tracking) {
      // Coalesce discovery screening too. An ordinary repaint must neither
      // rebuild viewport rows per chunk nor enter validation without ink.
      if (this.stallTimer === null) {
        this.queueStallCheck(() => {
          this.clearStallTimer();
          this.stallNextCheck = Date.now() + 250;
          if (this.hasStallInk(this.renderer.plainViewport())) this.refreshStall();
          // Absence also releases input suppression for a later occurrence.
          else {
            this.stallTracker.observe(null);
            this.stallInk?.checkAbsent();
          }
        }, Math.max(0, this.stallNextCheck - Date.now()));
      }
      return;
    }
    // Physical row changes can be composer presentation. Retain the candidate
    // and clock until coalesced validation compares its canonical identity.
    // Only new transcript text (including busy markers and prompts) clears at
    // once; known cosmetic repaints need no full validation.
    if (this.stallTracker.tracking) {
      const plain = this.renderer.plainViewport();
      const content = this.stallScreen.content(plain, this.agentModule!.stalls!);
      if (content === this.stallContent || content === this.stallValidatedContent) {
        // A native terminal can redraw its pre-resize text after xterm has
        // reflowed padded rows and clipped the viewport. Both are layout.
        this.stallContent = content;
        if (content === this.stallValidatedContent && this.stallState !== undefined) {
          // The invalidating frame has been restored. A pending presentation
          // check is obsolete; a settling candidate still needs its timer.
          this.stallValidationPending = false;
          this.clearStallTimer();
          this.stallTranscript = this.stallValidatedTranscript;
        }
        return;
      }
      this.stallContent = content;
      // Once the resize allowance expires, a later clipped repaint can still
      // have the same refusal block. Check that block before a text comparison
      // can mistake newly visible panel rows for a new turn.
      if (this.stallState !== undefined && this.hasStallInk(plain)) {
        const signature = signatureForSession(this);
        if (signature !== null && possibleStall(plain, signature)) {
          const { lines, firstVisible } = this.renderer.styledLines({ above: 128, extendWrapped: false });
          const candidate = validateStall(lines, signature, false, firstVisible);
          if (candidate !== null && 'inconclusive' in candidate && this.stallTracker.matchesBlock(candidate) &&
            detectPrompt(plain.join('\n'), this.agent) === null) {
            this.stallTranscript = this.readStallTranscript();
            return;
          }
        }
      }
      this.compareStallTranscript();
    }
    if (this.stallTimer !== null) return;
    this.queueStallCheck(() => this.refreshStall(), Math.max(0, this.stallNextCheck - Date.now()));
  }

  private hasStallInk(plain: readonly string[]): boolean {
    return this.agentModule!.stalls!.some(shape => this.renderer.hasForeground(
      plain.flatMap((line, row) => line.trimEnd() === shape.marker.text ? [row] : []), shape.marker.fg));
  }

  private refreshStall(): void {
    this.clearStallTimer();
    if (this.exitedFlag || this.isKilled) return;
    const resized = this.stallState !== undefined && this.stallResizeUntil !== 0;
    if (this.stallState !== undefined && this.stallResizeUntil !== 0) {
      const remaining = this.stallResizeUntil - Date.now();
      if (remaining > 0) {
        this.queueStallCheck(() => this.refreshStall(), remaining);
        return;
      }
    }
    this.stallNextCheck = Date.now() + 250;
    const signature = signatureForSession(this);
    if (signature === null) { this.publishStall(undefined); return; }
    const plain = this.renderer.plainViewport();
    const content = this.stallScreen.content(plain, this.agentModule!.stalls!);
    if (!resized && this.stallState !== undefined && content === this.stallValidatedContent) {
      // A due validation can beat the deferred output task to a restored
      // frame. Cancel here too, before materialising its styled context.
      this.stallContent = content;
      this.stallTranscript = this.stallValidatedTranscript;
      this.stallValidationPending = false;
      return;
    }
    const ink = this.hasStallInk(plain) && possibleStall(plain, signature);
    let candidate = null;
    if (ink) {
      const { lines, firstVisible } = this.renderer.styledLines({ above: 128, extendWrapped: false });
      candidate = validateStall(lines, signature, false, firstVisible);
      if (candidate !== null && detectPrompt(plain.join('\n'), this.agent) !== null) candidate = null;
    }
    // A narrow redraw can clip the user turn and expose only a tail of the
    // earlier transcript. The same styled block then owns that visible tail.
    // A new paragraph cannot pass this comparison, and missing ink or a
    // changed block still goes through bounded invalidation below.
    const sameClippedBlock = candidate !== null && 'inconclusive' in candidate &&
      this.stallTracker.matchesBlock(candidate);
    const currentTranscript = this.stallTracker.matchesBlock(candidate) && resized
      ? this.readStallTranscript() : undefined;
    const normaliseTranscript = (value: string) => value.replace(/\s+/gu, ' ').trim();
    const visibleTail = currentTranscript !== undefined && currentTranscript !== '' &&
      this.stallValidatedTranscript !== undefined && normaliseTranscript(this.stallValidatedTranscript)
        .endsWith(normaliseTranscript(currentTranscript));
    if (this.stallTracker.tracking && content !== this.stallContent && content !== this.stallValidatedContent &&
      !sameClippedBlock && !visibleTail) this.compareStallTranscript();
    this.stallContent = content;
    if (candidate !== null) {
      this.stallTranscript = this.readStallTranscript();
      // Keep the complete-context baselines across an inconclusive read: a
      // native redraw on growth can restore that viewport after clipped reflow.
      if (!('inconclusive' in candidate) && (this.stallState === undefined || this.stallTracker.matchesBlock(candidate)) &&
        !(resized && visibleTail)) {
        this.stallValidatedContent = this.stallContent;
        this.stallValidatedTranscript = this.stallTranscript;
      }
    }
    // A partial redraw may temporarily lose the block or composer. Confirm
    // invalidation at the next bounded check; output cannot postpone it.
    if (this.stallState !== undefined && !this.stallTracker.matchesBlock(candidate) && !this.stallValidationPending) {
      this.stallValidationPending = true;
      this.queueStallCheck(() => this.refreshStall(), 250);
      return;
    }
    this.stallValidationPending = false;
    this.stallResizeUntil = 0;
    this.publishStall(this.stallTracker.observe(candidate));
    if (!this.stallTracker.tracking) this.stallInk?.checkAbsent();
    const remaining = this.stallTracker.remaining();
    if (remaining !== null) {
      this.queueStallCheck(() => this.refreshStall(), remaining);
    }
  }

  /**
   * The rendered terminal as bytes that rebuild it in a fresh terminal of the
   * same size (design §5): what a viewer receives on connect and after every
   * grid change, in place of any slice of the raw stream. A slice starts
   * mid-frame, and a program that only repaints what changed never puts the
   * rest of its frame back. Every agent CLI repaints that way once its chrome
   * is up, and on Windows every program does as ConPTY relays it. Resolves
   * once every byte received before the call has been parsed, and includes
   * nothing received after it.
   */
  async viewerState(options: SerializeOptions = {}): Promise<string> {
    // Read before the await: the bytes behind this flag are the bytes in the
    // snapshot, not whatever arrives while it is being taken.
    const hidden = this.cursorHidden;
    const state = await this.renderer.serialize(options);
    return hidden ? state + CURSOR_HIDE : state;
  }

  /** The filter's styled rows and the viewer replay from one rendered frame. */
  async captureViewerScreen(above: number, scrollback: number): Promise<{
    view: { lines: StyledLine[]; firstVisible: number };
    state: string;
    cols: number;
    rows: number;
  }> {
    const hidden = this.cursorHidden;
    const captured = await this.renderer.capture({ above, scrollback });
    return { ...captured, state: captured.state + (hidden ? CURSOR_HIDE : '') };
  }

  async snapshot(): Promise<ScreenSnapshot> {
    await this.renderer.flush();
    await this.stallScheduled;
    const rendered = this.renderer.snapshot();
    // Every look at the screen is evidence for the stale-prompt guard. A
    // snapshot that finds no prompt, or a different one, is what lets a later
    // prompt with identical text count as new rather than as the one just
    // answered, and that includes the ones the daemon's stall scan and verify
    // take.
    this.stalePrompts.observe(detectPrompt(rendered.screen, this.agent)?.signature ?? null);
    return {
      id: this.id,
      label: this.label,
      cols: rendered.cols,
      rows: rendered.rows,
      cursor: rendered.cursor,
      exited: this.exitedFlag,
      exitCode: this.exitCode,
      screen: rendered.screen,
    };
  }

  /** Last N lines including scrollback (design §3). */
  async lastLines(count: number): Promise<string[]> {
    await this.renderer.flush();
    return this.renderer.lastLines(count);
  }

  /** Current viewport lines (for `terminal_find`). */
  async viewportLines(): Promise<string[]> {
    await this.renderer.flush();
    await this.stallScheduled;
    return this.renderer.snapshot().lines;
  }

  /**
   * The viewport with `above` lines of scrollback over it, as drawn
   * (`reasoning.ts`). `firstVisible` is where the viewport begins.
   */
  async styledScreen(above = 0): Promise<{ lines: StyledLine[]; firstVisible: number }> {
    await this.renderer.flush();
    return this.renderer.styledLines({ above });
  }

  /** Current rendered rows for a waiter evaluation, which already reads synchronously. */
  styledScreenNow(above = 0): { lines: StyledLine[]; firstVisible: number } {
    return this.renderer.styledLines({ above });
  }

  /**
   * The last `count` lines, scrollback included, as drawn, with up to
   * `context` more lines over them; `firstVisible` is where the `count` begin.
   */
  async styledTail(count: number, context = 0): Promise<{ lines: StyledLine[]; firstVisible: number }> {
    await this.renderer.flush();
    const { lines } = this.renderer.styledLines({ last: count + context });
    return { lines, firstVisible: Math.max(0, lines.length - count) };
  }

  waitFor(condition: WaitCondition, options?: WaitOptions & WaiterInternals): Promise<WaitResult> {
    return waitFor(this, condition, options);
  }

  waitUntilReady(timeout?: number, signal?: AbortSignal): Promise<StartReadyResult> {
    return waitUntilReady(this, timeout, signal);
  }

  /** A question at start completion invalidates an earlier opted-in match. */
  deferReadiness(): void {
    if (this.startupReadiness === undefined || this.readyReasonValue !== 'condition-met') return;
    this.readyFlag = false;
    this.readyReasonValue = 'pending';
    for (const listener of this.readyListeners) listener();
    this.trackStartupReadiness();
  }

  private trackStartupReadiness(): void {
    if (this.startupReadiness === undefined) return;
    // Restart after a question without extending the session's tracking budget.
    void trackReadiness(this, this.startupReadiness, true, this.createdAt.getTime() + MAX_WAIT_TIMEOUT_MS)
      .then(matched => this.recordReadiness(matched, matched ? 'condition-met' : this.exited ? 'exited' : 'timeout'));
  }

  private recordReadiness(matched: boolean, reason: string): void {
    this.readyFlag = matched;
    this.readyReasonValue = matched ? 'condition-met' : 'never-held';
    if (matched) this.logger.info('session ready', { id: this.id, reason });
    else this.logger.warn('session readiness condition never held', { id: this.id, reason });
    for (const listener of this.readyListeners) listener();
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      label: this.label,
      purpose: this.purpose,
      startedBy: this.startedBy,
      agent: this.agent,
      command: this.command,
      args: this.args,
      cols: this.cols,
      rows: this.rows,
      ready: this.readyFlag,
      ...(this.stallState === undefined ? {} : { stalled: this.stallState }),
      readyReason: this.readyReasonValue,
      geometryHeld: this.geometryHeldFlag,
      exited: this.exitedFlag,
      exitCode: this.exitCode,
      watchers: this.watchers,
      createdAt: this.createdAt.toISOString(),
    };
  }

  /**
   * Kill the whole process tree (design §3.1). Commands are shell-wrapped, so
   * killing only the direct child (`cmd.exe`) strands the real application,
   * and orphaned agent CLIs keep running and keep spending paid API tokens.
   *
   * Windows: `taskkill /T /F` walks and kills the tree, then `pty.kill()` runs.
   * node-pty's kill ends no process of its own
   * (`listNothingToKill` in `windowsPtyStart.ts`), and it closes the
   * pseudoconsole, which sends CTRL_CLOSE_EVENT to the processes on the
   * console, only while node-pty still holds the terminal: while the program
   * runs. After a tree kill that ended the program, its kill closes nothing,
   * so a process on the session's console outside the killed tree gets no
   * close event. The console host is not in that tree. After this returns, a
   * later list ends the one host created during this spawn's window. This does
   * not wait for that list. The daemon's pseudoconsole handle stays open, and
   * the host is given no CTRL_CLOSE_EVENT. (The design's Job
   * Object hardening needs a native module and is
   * deferred. If the daemon itself dies, its pseudoconsole handles close,
   * which gives console-attached descendants a close signal.)
   *
   * POSIX: the PTY child is the session leader of its own process group, so
   * signalling the negated pid takes the group down.
   *
   * The OS tree kill runs only while the root is still alive. A session whose
   * program exited on its own is reaped fifteen minutes later, and by then the
   * process group id may have been recycled, so an unconditional `kill(-pid)`
   * could take down something unrelated; on Windows `taskkill` cannot walk a
   * tree from a dead root either. So a grandchild that outlived its parent is
   * left alone rather than guessed at, a residual risk stated in
   * `docs/reference/security-model.md`. A session whose program has not been
   * seen to end (`programEnded`) is walked, whether or not the session has
   * ended. node-pty holds such a program's handle while it runs and closes it
   * as it sees the program end, a moment before the code is recorded, so a
   * kill in that moment can reach a pid just freed: the same kind of race
   * every kill has while `taskkill` enumerates the processes. Once the code
   * is recorded the pid is not walked.
   */
  kill(): Promise<void> {
    this.killPromise ??= this.killOnce();
    return this.killPromise;
  }

  /** True from the moment a kill begins, including while it waits for a pid. */
  get isKilled(): boolean {
    return this.killPromise !== null;
  }

  private async killOnce(): Promise<void> {
    this.clearStallTimer();
    this.publishStall(undefined);
    // node-pty creates a Windows terminal's program only once its output
    // worker has connected, a few tens of milliseconds after the spawn
    // returns, and reports pid 0 until then; a start whose connection fails
    // reports an exit instead. The wait keeps the tree kill below from
    // skipping a program that is about to exist (`programPid`).
    const pid = await this.programPid();
    this.logger.info('session kill', { id: this.id, pid });
    // Taken before the kill. The kill itself makes node-pty record the exit,
    // and that later record must not hide the result of a tree we did walk.
    const exitAlreadyRecorded = recordedExitCode(this.pty) !== undefined;

    if (this.endingProgram !== null) {
      // The session is already ending its program, after an exit with no code.
      await this.endingProgram;
    } else if (!this.programEnded) {
      await this.killTree(pid);
    }

    try {
      this.pty.kill();
    } catch {
      // Already dead: the outcome we wanted.
    }

    // Verify rather than assume. An orphaned agent CLI keeps running and keeps
    // spending paid API tokens, so the fact worth logging is "it died", not
    // "we sent a kill". Checking only the root pid is deliberate: a full
    // descendant walk needs recursive process queries that are far slower than
    // the kill itself (measured in minutes), and the root dying is what the
    // caller actually contracted for.
    // When the exit was already recorded, node-pty had already closed the
    // process handle and Windows may have given the pid out. A live pid is
    // then not reported as this session's root surviving: it may be someone
    // else's process. A pid that is gone is still the result worth logging.
    // A code recorded by this kill is not that case: the tree was still ours.
    // A pid of 0 means no program was ever created, and on Windows a liveness
    // probe of it answers as though something were there: nothing is probed
    // and no survivor is claimed for it.
    if (pid > 0 && !this.processAlive(pid)) {
      this.logger.info('session tree killed', { id: this.id, pid });
    } else if (pid > 0 && !exitAlreadyRecorded) {
      this.logger.error('session root SURVIVED the kill and may still be running', {
        id: this.id,
        pid,
      });
    }

    this.queueConsoleHost();
    await this.renderer.dispose();
  }

  /**
   * Queue an end of this session's console host, once. The list runs later
   * and is not awaited. With no window there is nothing to end. On any
   * platform but Windows the queue does nothing.
   */
  private queueConsoleHost(): void {
    if (this.platform !== 'win32') return;
    const window = this.consoleHostWindow;
    if (window === null || this.consoleHostQueued) return;
    this.consoleHostQueued = true;
    let settle: (ended: boolean) => void = () => undefined;
    this.consoleHostSettlement = new Promise<boolean>((resolve) => { settle = resolve; });
    this.endConsoleHost({
      id: this.id,
      window,
      log: (level, message, meta) => {
        this.logger[level](message, meta);
      },
      onSettled: settle,
    });
  }

  /** The failed attempt's own console-host result, after it has been queued. */
  whenConsoleHostSettled(): Promise<boolean> {
    return this.consoleHostSettlement ?? Promise.resolve(false);
  }

  /**
   * The program's pid, waiting for node-pty's deferred program creation:
   * on Windows the pid is 0 from the spawn until the output worker has
   * connected and the program exists, and a start whose connection fails
   * reports an exit instead of a pid, which ends the wait. POSIX reports the
   * pid at the spawn, so nothing is waited for there.
   */
  private async programPid(): Promise<number> {
    // One full wait per session: once a wait has run out with no program, a
    // later caller (a kill after shutdown's pre-wait) must not spend its budget
    // waiting again. It still reads the pid, so a program created since is
    // walked; with none, the kill skips the tree and node-pty's own pending
    // connection is cancelled by the kill.
    if (this.programWaitExpired) return this.pty.pid;
    const deadline = Date.now() + this.pidWaitMs;
    while (this.pty.pid <= 0 && !this.exitedFlag && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.pty.pid <= 0 && !this.exitedFlag) this.programWaitExpired = true;
    return this.pty.pid;
  }

  /**
   * The program's pid once node-pty has created it, or null when the session
   * ended before any program existed: a start whose ConPTY output worker
   * never connected, or one Windows refused the program of. The start
   * contract waits here: a session is reported as started only once its
   * program exists, as node-pty 1.1.0's synchronous spawn guaranteed.
   */
  async startedProgramPid(): Promise<number | null> {
    const pid = await this.programPid();
    return pid > 0 ? pid : null;
  }

  /** Only the pinned node-pty timeout, before a program exists, can be retried. */
  get conptyConnectionTimedOut(): boolean {
    return this.platform === 'win32' && this.exitedFlag && this.pty.pid <= 0 &&
      this.conptyStartError?.message === 'Timed out waiting for ConPTY output worker';
  }

  /**
   * What went wrong, for a start that ended before any program existed
   * (`startedProgramPid` returned null): node-pty 1.1.0's own words for a
   * program Windows would not create, with Windows' code; for the connection
   * bound, which 1.1.0 did not have, what actually ran out.
   */
  startFailure(): string {
    const code = this.exitCodeValue;
    if (code !== null && code > 0) return `Cannot create process, error code: ${String(code)}`;
    if (this.conptyStartError !== null && !this.conptyConnectionTimedOut) return this.conptyStartError.message;
    return 'the ConPTY output worker never connected, so node-pty never created the program';
  }

  /**
   * End the program of a session that ended with no exit code: node-pty
   * closed its terminal when its output failed, and the program would run on
   * where nobody can read or type into it, for an agent CLI still acting and
   * spending. The same tree kill a kill uses. It runs only after the exit, so
   * the pid is never waited for here; a pid of 0 (no program was created) is
   * skipped by the tree kill. Never rejects.
   */
  private async endProgram(): Promise<void> {
    const pid = await this.programPid();
    this.logger.warn('session output failed: ending its program', { id: this.id, pid });
    await this.killTree(pid);
  }

  /**
   * The OS tree kill of `kill()`, for a program that may still be running:
   * `taskkill /T /F` from a live root on Windows, the process group on POSIX.
   * Never rejects.
   */
  private async killTree(pid: number): Promise<void> {
    // A pid of 0 is a program node-pty has not created (its deferred
    // connection) or never created (a failed start): there is no tree, and on
    // Windows a liveness probe of pid 0 answers as though something were
    // there, so the checks below would not say no.
    if (pid <= 0) return;
    if (this.platform === 'win32') {
      // A root that has already died leaves no tree to walk. At daemon
      // shutdown this is the usual case: `killAll` has just killed every
      // session's tree in one run.
      const failure = this.processAlive(pid) ? await this.treeKiller([pid]) : null;
      if (failure !== null) {
        // Three very different things land here, so report which
        // actually happened.
        //
        // `timedOut` means OUR timeout fired and taskkill was terminated
        // mid-walk. The tree may be half-killed, so this is the one
        // that genuinely warrants attention.
        //
        // A non-zero exit is NOT proof of failure. `taskkill /T` walks
        // a live tree, and descendants routinely die of their own
        // accord (or as a side effect of a parent dying) between
        // enumeration and the kill call; taskkill then reports "not
        // found" for those and exits 128 having successfully killed
        // everything else. Measured: exit 128 alongside 78 SUCCESS
        // lines on a Qoder tree.
        this.logger.warn(
          failure.timedOut
            ? 'tree kill timed out; the process tree may be partially killed'
            : 'taskkill exited non-zero (usually descendants that vanished mid-walk)',
          { id: this.id, pid, ...failure, timeoutMs: TREE_KILL_TIMEOUT_MS },
        );
      }
    } else {
      // SIGKILL outright, with no SIGTERM grace: design §3.1 chooses the
      // process-group kill precisely so that children which ignore SIGTERM
      // cannot survive, and a grace period would hand them the chance back.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        this.logger.warn('process-group kill failed, falling back to pty.kill', {
          id: this.id,
          error: String(error),
        });
      }
    }
  }

  /**
   * Cheap liveness probe: signal 0 performs the permission and existence
   * checks without delivering a signal, on Windows as well as POSIX.
   */
  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process EXISTS but we are not allowed to signal it
      // (POSIX). Reporting that as "gone" would make this whole verification
      // dishonest in the one direction that matters: claiming a clean kill
      // over a survivor, which is the failure the probe exists to catch.
      // Only ESRCH ("no such process") is genuine evidence of death.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
