/**
 * Shared domain types and defaults for ShellPuppet.
 *
 * Everything here is pure data, with no I/O and no Node APIs. The design document
 * (`docs/architecture/design.md`) is the source of truth for the shapes below;
 * section references are given where a type encodes a specific decision.
 */

import type { DetectedPrompt } from './promptDetector.js';

export type { DetectedPrompt };

/** Injected logging interface (design §2.4).
 *
 * `core/` and `client/` never write to stdout or stderr: a stray console line
 * corrupts the MCP stdio protocol. Adapters decide where log output goes: the CLI
 * wires this to the console, the MCP adapter to a file or stderr, the daemon to
 * its own log.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A logger that discards everything: the safe default where none is injected. */
export const NULL_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------- sessions

/** Options accepted when starting a session (design §3, `terminal_start`). */
export interface SessionOptions {
  /** The real, pre-wrap command: e.g. `goose`, never `cmd.exe /c goose` (§4.3). */
  command: string;
  args?: string[];
  cwd?: string;
  /** The grid to START at. Not a freeze: see `hold`. */
  cols?: number;
  rows?: number;
  /**
   * Hold the grid against viewers (§5). Off by default, because the ordinary
   * case is a human watching in a browser whose window should fill. Turn it on
   * for a run whose output is compared against a known width, where a reflow
   * would invalidate the run and bars are the right answer.
   */
  hold?: boolean;
  label?: string;
  /**
   * What this session is FOR, in a sentence, shown to the human watching it.
   * A label names the session; a purpose explains why it exists, and
   * when several viewer windows are open at once that is the difference
   * between picking the right one and guessing.
   */
  purpose?: string;
  /**
   * Which client started the session (the audit actor, e.g. `mcp:claude-code`).
   * Set by the daemon from the request's `x-shellpuppet-actor` header rather
   * than from the body, so it cannot be set independently of the audit trail.
   *
   * It is **self-declared, not authenticated**: a client may send whatever
   * actor it likes. This is provenance for a human reading a viewer window,
   * not an identity control, and the same-user model means there is no
   * boundary here to enforce.
   */
  startedBy?: string;
  /**
   * Which agent CLI the session runs, by signature name (`reasoning.ts`):
   * how `hideReasoning` and `terminal_result` read its screen. Needed when
   * the agent is reached through a shell, a wrapper or a launcher script;
   * without it the start command's own name chooses the signature.
   */
  agent?: string;
  /** Text that must appear on screen before the session reports `ready` (§3.1). */
  readyText?: string;
  /** Quiescence (ms of no output) that marks the session `ready` (§3.1). */
  readyQuiet?: number;
  /**
   * Shell-wrap the command daemon-side (`cmd.exe /c` on Windows). Defaults to
   * true on Windows because direct ConPTY spawns of single-file binaries hang
   * (§7). Applied AFTER policy evaluation: policy always sees the pre-wrap
   * command (§4.3).
   */
  shell?: boolean;
  /**
   * Variables set in this session's environment on top of what `sessionEnv`
   * gives it, by name and value (§4.6). The MCP server fills it from its own
   * environment, for the names the human allowed in `mcp.passEnv`. The values
   * are spawn input only: the session never keeps them, and logs and the
   * audit trail record the names alone.
   */
  env?: Record<string, string>;
}

/** One session's public state, as returned by `terminal_list`. */
export interface SessionSummary {
  id: string;
  label: string;
  /** What the session is for; empty when the caller did not say. */
  purpose: string;
  /** The audit actor that started it, e.g. `mcp:claude-code`, `cli`. */
  startedBy: string;
  /** The agent it was started as (`SessionOptions.agent`), or null. */
  agent: string | null;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  ready: boolean;
  /**
   * Why `ready` holds the value it does. `ready: true` alone is ambiguous and
   * easily read as a green light to start typing: when the caller supplies no
   * `readyText`/`readyQuiet`, readiness is not being tracked at all, and a
   * bare `true` says nothing about whether the program can accept input.
   *
   * - `not-tracked`: no readiness condition was given. `ready` is true by
   *   convention only; **do not** treat it as safe to type.
   * - `pending`: a condition was given and has not held yet.
   * - `condition-met`: the condition held; this is the only affirmative one.
   * - `never-held`: the condition timed out without holding.
   */
  readyReason: 'not-tracked' | 'pending' | 'condition-met' | 'never-held';
  /**
   * True when the grid is HELD: no viewer may change it, so a viewer whose
   * window is a different shape scales its text and letterboxes rather than
   * reflowing the session (§5). False is the ordinary case: the session's
   * grid follows whichever viewport is driving it.
   */
  geometryHeld: boolean;
  exited: boolean;
  exitCode: number | null;
  /** Number of connected viewer/WebSocket clients. */
  watchers: number;
  createdAt: string;
}

/** Cursor position within the visible viewport. */
export interface CursorPosition {
  x: number;
  y: number;
}

/** The rendered screen, as returned by `terminal_snapshot` and `terminal_wait`. */
export interface ScreenSnapshot {
  id: string;
  label: string;
  cols: number;
  rows: number;
  cursor: CursorPosition;
  exited: boolean;
  exitCode: number | null;
  /** Plain-text screen content, lines joined with `\n`, trailing blanks trimmed. */
  screen: string;
}

// ------------------------------------------------------------------------ waiting

/**
 * A wait condition (design §3, `terminal_wait`). Exactly one of `text`, `regex`,
 * `quiet` or `prompt` must be provided.
 */
export interface WaitCondition {
  /** Case-insensitive substring to await on the rendered screen. */
  text?: string;
  /** Case-insensitive regular expression (source string) to await. */
  regex?: string;
  /** Quiescence: resolve once no output has arrived for this many milliseconds. */
  quiet?: number;
  /**
   * Resolve when the screen shows a permission prompt waiting on a human.
   * The supervision condition: an agent supervising another agent CLI wants
   * to be woken when that CLI needs an answer rather than poll snapshots
   * hoping to catch one. Same heuristic the daemon's stall alerts use, so
   * what this waits for and what `daemon.log` announces cannot drift apart.
   */
  prompt?: boolean;
}

export interface WaitOptions {
  /** Overall timeout in ms. Defaults to 60,000, clamped to 300,000 (§3.1). */
  timeout?: number;
  /**
   * For text, regex and prompt conditions: after the first match, keep
   * polling until the screen has been stable for this many ms before resolving
   * (0 = resolve immediately on match). Lets a mid-paint TUI settle before the
   * screen is read.
   */
  debounce?: number;
  /**
   * Only count what comes AFTER the caller's last input.
   *
   * - text/regex, default false: ignore matches at or before the echo of the
   *   last input, so a pattern that describes the expected output cannot be
   *   satisfied by the prompt that asked for it. That closes the echo trap at
   *   the tool rather than restating it in prose.
   * - prompt, default TRUE: the prompt that was showing when the last input
   *   was sent counts as answered until the screen has been seen without it;
   *   a supervisor never wants the question it has just answered handed back.
   *   Pass false to accept whatever prompt is on screen.
   */
  matchAfterInput?: boolean;
  /**
   * Stop waiting because nobody is listening any more. The daemon aborts a
   * wait whose HTTP client has gone: the poll would otherwise run to its full
   * timeout, taking a renderer snapshot every tick for an answer no one will
   * read. Resolves `{ matched: false, reason: 'aborted' }` and clears the poll
   * timer.
   */
  signal?: AbortSignal;
}

export type WaitReason =
  | 'text'
  | 'regex'
  | 'quiet'
  | 'prompt'
  | 'exited'
  | 'timeout'
  | 'aborted';

export interface WaitResult {
  matched: boolean;
  reason: WaitReason;
  waitedMs: number;
  /** The rendered screen at the moment the wait resolved. */
  screen: string;
  /**
   * The prompt that satisfied a `prompt` condition, with its question and
   * options, so the caller can decide the answer without a second round trip
   * to read the screen it already has. Absent for every other condition.
   */
  prompt?: DetectedPrompt;
  /**
   * Why the wait did NOT match, when the waiter can say more than the reason,
   * e.g. quiet timed out because the program has not painted anything yet.
   * The waiter's own words, never screen content. Absent on a match.
   */
  detail?: string;
}

// ------------------------------------------------------------------------- policy

export type PolicyMode = 'allow-all' | 'allowlist' | 'denylist';

/** Command policy configuration (design §4.3): `policy` in `config.json`. */
export interface PolicyConfig {
  mode: PolicyMode;
  /** Regex sources matched against the pre-wrap command line (allowlist mode). */
  allow?: string[];
  /** Regex sources matched against the pre-wrap command line. */
  deny?: string[];
  /** Maximum concurrent live sessions. No limit when unset. */
  maxSessions?: number;
  /**
   * Set ONLY by the daemon's config validation (never by users) when the
   * policy section was structurally invalid: it compiles to a policy that
   * refuses every command with this reason. A policy that cannot be evaluated
   * as written must not be guessed at.
   */
  configError?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Human-readable explanation, present whenever the command is refused. */
  reason?: string;
  /** The rule (regex source) that decided the outcome, where one did. */
  rule?: string;
}

// ------------------------------------------------------------------ environment

/**
 * Session environment hygiene (design §4.6, ADR-008). The daemon's own
 * environment is whatever the first client that auto-started it had. `clean`,
 * the default, passes a minimal functional set; an array passes that set plus
 * the named variables; `passthrough` hands all of the daemon's environment
 * (possibly including API keys) to every session, and has to be chosen by name.
 * `TERM`/`COLORTERM` are always injected regardless.
 */
export type SessionEnvMode = 'passthrough' | 'clean' | string[];

/**
 * A variable name a session's own environment may carry (`SessionOptions.env`)
 * and `mcp.passEnv` may list: letters, digits and underscores, not starting
 * with a digit. That is every name an API key or setting is given in
 * practice, and it keeps out names that a shell or an environment block would
 * read some other way. `__proto__` is refused too: an ordinary object would
 * swallow it rather than store it, and the variable would silently not pass.
 */
export const ENV_NAME_PATTERN = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]*$/;

// ----------------------------------------------------------------------- defaults

/** The grid a session starts with when the caller names none. */
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 34;

/** Scrollback depth for the headless renderer and the viewer (design §5). */
export const DEFAULT_SCROLLBACK = 5000;

/**
 * Wait timeout defaults (design §3.1): agent CLIs take 15 to 50 s to first paint
 * and emit nothing meanwhile, so the default is deliberately generous.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;
export const WAIT_POLL_INTERVAL_MS = 80;

/**
 * How long any one evaluation of a caller's regular expression may take
 * (`regexBudget.ts`). A screen is a few thousand characters, so a sane pattern
 * finishes in microseconds; this is the point at which a pattern is assumed to
 * be backtracking rather than searching. It applies per evaluation for a wait
 * (up to two a poll with matchAfterInput), once to a whole find and once per
 * rule for a policy decision, so a policy with several rules may take several
 * budgets to decide.
 */
export const REGEX_BUDGET_MS = 250;
