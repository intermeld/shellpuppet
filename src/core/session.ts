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

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import { ensureSpawnHelperExecutable, explainSpawnFailure, loadNodePty } from './nativePty.js';
import { ScreenRenderer } from './renderer.js';
import type { SerializeOptions, StyledLine } from './renderer.js';
import { commandLine } from './policy.js';
import { detectPrompt, StalePromptGuard } from './promptDetector.js';
import { waitFor } from './waiter.js';
import type { WaitTarget } from './waiter.js';
import { listenForTerminalErrors, recordedExitCode, releaseFailedStarts } from './windowsPtyStart.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
  MAX_WAIT_TIMEOUT_MS,
  NULL_LOGGER,
} from './types.js';
import type {
  Logger,
  ScreenSnapshot,
  SessionEnvMode,
  SessionOptions,
  SessionSummary,
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
export const taskkillTrees: TreeKiller = (pids) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      'taskkill',
      ['/T', '/F', ...pids.flatMap((pid) => ['/PID', String(pid)])],
      // A line of output per process killed, descendants included.
      { windowsHide: true, timeout: TREE_KILL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
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

/** A bare command name that is not on PATH: a caller error, mapped to 400. */
export class CommandNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandNotFoundError';
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
 */
function resolveExecutable(command: string, platform: NodeJS.Platform): string {
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
  const searchBases = explicitPath
    ? [command]
    : (process.env['PATH'] ?? '')
        .split(path.delimiter)
        .filter((d) => d !== '')
        .map((dir) => path.join(dir, command));

  for (const base of searchBases) {
    for (const candidate of candidatesFor(base)) {
      if (usable(candidate)) return candidate;
    }
  }

  throw new CommandNotFoundError(
    explicitPath
      ? `Not an executable file: ${command}.`
      : `Command not found on PATH: ${command}. Give an absolute path, or drop ` +
        `shell:false (--no-shell) and let the shell wrapper resolve it.`,
  );
}

export interface SessionDeps {
  logger?: Logger;
  /** Platform override, for tests only. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Environment hygiene mode (design §4.6). Defaults to `DEFAULT_SESSION_ENV`. */
  sessionEnv?: SessionEnvMode;
  /** Windows tree killer override, for tests only. Defaults to `taskkillTrees`. */
  treeKiller?: TreeKiller;
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
 */
export function buildSessionEnv(
  mode: SessionEnvMode,
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv = process.env,
  passed: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  if (mode === 'passthrough') {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) env[key] = value;
    }
  } else {
    const baseline = CLEAN_ENV_KEYS[platform === 'win32' ? 'win32' : 'posix'];
    const wanted = new Set(
      (mode === 'clean' ? baseline : [...baseline, ...mode]).map((k) => k.toUpperCase()),
    );
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && wanted.has(key.toUpperCase())) env[key] = value;
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
  readonly agent: string | undefined;
  readonly createdAt: Date;

  private readonly pty: IPty;
  private readonly renderer: ScreenRenderer;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly treeKiller: TreeKiller;
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

  /** Whether the program has hidden the cursor (DECTCEM off), carried to viewers. */
  private cursorHidden = false;
  /** Serialises write() so chunked writes cannot interleave. See write(). */
  private writeChain: Promise<void> = Promise.resolve();
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
  private readyFlag: boolean;
  private readyReasonValue: SessionSummary['readyReason'] = 'not-tracked';
  private geometryHeldFlag: boolean;
  private killed = false;

  constructor(id: string, options: SessionOptions, deps: SessionDeps = {}) {
    this.id = id;
    this.command = options.command;
    this.args = options.args ?? [];
    this.label = options.label ?? options.command;
    this.purpose = options.purpose ?? '';
    this.startedBy = options.startedBy ?? 'unknown';
    this.agent = options.agent;
    this.createdAt = new Date();
    this.logger = deps.logger ?? NULL_LOGGER;
    this.platform = deps.platform ?? process.platform;
    this.treeKiller = deps.treeKiller ?? taskkillTrees;

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    this.renderer = new ScreenRenderer({ cols, rows, scrollback: DEFAULT_SCROLLBACK });

    // cols/rows say where to START, and nothing more: a size that also froze
    // the grid would leave a viewer with a grid it could not change, and a
    // window of a different shape could only letterbox. Holding is asked
    // for explicitly, because the common case is a human watching in a browser
    // that should simply fill, and the rare case is a run that would be
    // invalidated by a reflow.
    this.geometryHeldFlag = options.hold === true;

    const { file, fileArgs } = this.wrapCommand(options);
    this.logger.info('session spawn', {
      id,
      command: this.command,
      args: this.args,
      wrapped: file !== this.command,
      // Names only: the values are secrets more often than not.
      ...(options.env !== undefined ? { envNames: Object.keys(options.env) } : {}),
    });

    // node-pty is loaded on the first start, not with the daemon, so an install
    // that left it unable to open a terminal fails here with what to do
    // (`nativePty.ts`).
    const { spawn } = loadNodePty();
    // A Windows start that fails part-way must not leave node-pty's
    // half-built terminal behind (`windowsPtyStart.ts`).
    if (process.platform === 'win32') releaseFailedStarts();
    ensureSpawnHelperExecutable();
    try {
      this.pty = spawn(file, fileArgs, {
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
      });
    } catch (error) {
      // On Windows node-pty loads its native module here, as the terminal is
      // built, so a missing binary surfaces now rather than at the load above.
      throw explainSpawnFailure(error);
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

    this.pty.onData((data) => {
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
      // First paint is decided by the RENDERER, not by bytes arriving: ConPTY
      // emits mode-set sequences ~140 ms after spawn that draw nothing, and a
      // quiet/readyQuiet that counted them as output would report a CLI ready
      // before its first byte. Checked per chunk only until it
      // holds, so the snapshot cost stops at the first visible character.
      if (!this.painted) {
        void rendered.then(() => {
          if (!this.painted && this.renderer.snapshot().screen !== '') this.painted = true;
        });
      }
      this.lastChange = Date.now();
      for (const listener of this.dataListeners) listener(data);
    });

    this.pty.onExit(({ exitCode: reported }) => {
      // node-pty closes a Windows terminal whose output socket failed and
      // reports an exit with no code, while the program may run on: the
      // session can no longer be read or typed into, so it has ended, but its
      // program has not been seen to end (`programEnded`).
      const exitCode = typeof reported === 'number' ? reported : null;
      this.exitedFlag = true;
      this.exitedAtValue = Date.now();
      this.exitCodeValue = exitCode;
      this.lastChange = Date.now();
      this.logger.info('session exit', { id, exitCode });
      for (const listener of this.exitListeners) listener(exitCode);
    });

    // Readiness (§3.1): first paint ≠ ready. With no condition given the
    // session counts as ready at spawn; otherwise readiness flips when the
    // condition holds. A session whose condition never holds stays not-ready,
    // which is the truth and is visible in list/snapshot output.
    if (options.readyText !== undefined || options.readyQuiet !== undefined) {
      this.readyFlag = false;
      this.readyReasonValue = 'pending';
      const condition: WaitCondition =
        options.readyText !== undefined
          ? { text: options.readyText }
          : { quiet: options.readyQuiet };
      void waitFor(this, condition, { timeout: MAX_WAIT_TIMEOUT_MS }).then((result) => {
        if (result.matched) {
          this.readyFlag = true;
          this.readyReasonValue = 'condition-met';
          this.logger.info('session ready', { id, reason: result.reason });
        } else {
          this.readyReasonValue = 'never-held';
          this.logger.warn('session readiness condition never held', {
            id,
            reason: result.reason,
          });
        }
      });
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
        file: resolveExecutable(options.command, this.platform),
        fileArgs: options.args ?? [],
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
  /** Null until the session ends, and for an end that came with no code. */
  get exitCode(): number | null {
    return this.exitCodeValue;
  }
  /**
   * Whether the session's program is known to have ended: its exit came with
   * a code, or node-pty has recorded one since. An exit with no code ends the
   * session but not necessarily its program, whose tree a kill still walks.
   */
  get programEnded(): boolean {
    return this.exitedFlag && (this.exitCodeValue !== null || recordedExitCode(this.pty) !== undefined);
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
  write(data: string): Promise<string> {
    const queued = this.writeChain.then(() => this.writeInput(data));
    // The chain must survive a failed write, or one rejection would wedge every
    // subsequent write on this session.
    this.writeChain = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async writeInput(data: string): Promise<string> {
    this.refuseIfInputFailed();
    // Recorded BEFORE the bytes go in, when the screen still shows what this
    // input is answering: the waiter's stale-prompt guard needs that prompt,
    // and its echo guard needs the input itself.
    this.lastInputData = data;
    const { screen } = this.renderer.snapshot();
    this.stalePrompts.noteInput(screen);

    if (data.length <= WRITE_CHUNK_CHARS) {
      this.pty.write(data);
      return screen;
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
      return screen;
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
    return screen;
  }

  /** Input written after the input pipe has failed would be lost: refuse it. */
  private refuseIfInputFailed(): void {
    if (this.inputFailure !== null) throw new SessionInputFailedError(this.id, this.inputFailure);
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
   */
  resize(cols: number, rows: number, options: { hold?: boolean } = {}): void {
    this.pty.resize(cols, rows);
    this.renderer.resize(cols, rows);
    if (options.hold !== undefined) this.geometryHeldFlag = options.hold;
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

  async snapshot(): Promise<ScreenSnapshot> {
    await this.renderer.flush();
    const rendered = this.renderer.snapshot();
    // Every look at the screen is evidence for the stale-prompt guard. A
    // snapshot that finds no prompt, or a different one, is what lets a later
    // prompt with identical text count as new rather than as the one just
    // answered, and that includes the ones the daemon's stall scan and verify
    // take.
    this.stalePrompts.observe(detectPrompt(rendered.screen)?.signature ?? null);
    return {
      id: this.id,
      label: this.label,
      cols: rendered.cols,
      rows: rendered.rows,
      cursor: rendered.cursor,
      exited: this.exitedFlag,
      exitCode: this.exitCodeValue,
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

  /**
   * The last `count` lines, scrollback included, as drawn, with up to
   * `context` more lines over them; `firstVisible` is where the `count` begin.
   */
  async styledTail(count: number, context = 0): Promise<{ lines: StyledLine[]; firstVisible: number }> {
    await this.renderer.flush();
    const { lines } = this.renderer.styledLines({ last: count + context });
    return { lines, firstVisible: Math.max(0, lines.length - count) };
  }

  waitFor(condition: WaitCondition, options?: WaitOptions): Promise<WaitResult> {
    return waitFor(this, condition, options);
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      label: this.label,
      purpose: this.purpose,
      startedBy: this.startedBy,
      agent: this.agent ?? null,
      command: this.command,
      args: this.args,
      cols: this.cols,
      rows: this.rows,
      ready: this.readyFlag,
      readyReason: this.readyReasonValue,
      geometryHeld: this.geometryHeldFlag,
      exited: this.exitedFlag,
      exitCode: this.exitCodeValue,
      watchers: this.watchers,
      createdAt: this.createdAt.toISOString(),
    };
  }

  /**
   * Kill the whole process tree (design §3.1). Commands are shell-wrapped, so
   * killing only the direct child (`cmd.exe`) strands the real application,
   * and orphaned agent CLIs keep running and keep spending paid API tokens.
   *
   * Windows: `taskkill /T /F` walks and kills the tree; closing the ConPTY via
   * `pty.kill()` also sends CTRL_CLOSE_EVENT to console-attached
   * survivors. (The design's Job Object hardening needs a native module and is
   * deferred. If the daemon itself dies, its ConPTY handles close, which gives
   * console-attached descendants the same close signal.)
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
   * ended: on Windows node-pty holds such a program's process handle, so its
   * pid is still its own.
   */
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    const pid = this.pty.pid;
    this.logger.info('session kill', { id: this.id, pid });

    if (!this.programEnded) {
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
    if (!this.processAlive(pid)) {
      this.logger.info('session tree killed', { id: this.id, pid });
    } else {
      this.logger.error('session root SURVIVED the kill and may still be running', {
        id: this.id,
        pid,
      });
    }

    this.renderer.dispose();
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
