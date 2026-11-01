/**
 * The ShellPuppet daemon: one per user, owns every PTY, serves clients and
 * viewers (design §2). Binds 127.0.0.1 on an OS-assigned port, publishes its
 * discovery record atomically and defends the loopback surface (§4.2):
 * Host-header validation on every request, Origin validation on WebSocket
 * upgrades, bearer-token auth on the API, no CORS headers at all.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { SessionManager, PolicyViolationError } from '../core/manager.js';
import {
  CommandNotFoundError,
  DEFAULT_SESSION_ENV,
  SessionInputFailedError,
  SessionProgramEndedError,
  credentialShapedNames,
} from '../core/session.js';
import { NativePtyUnavailableError } from '../core/nativePty.js';
import { checkSessionCapacity, commandLine, compilePolicy, evaluateCommand } from '../core/policy.js';
import type { CompiledPolicy } from '../core/policy.js';
import { keyToBytes, knownKeys } from '../core/keys.js';
import { findOnScreen } from '../core/find.js';
import { screenShows } from '../core/echo.js';
import { RegexBudgetError } from '../core/regexBudget.js';
import { detectPrompt } from '../core/promptDetector.js';
import type { DetectedPrompt } from '../core/promptDetector.js';
import { WaitConditionError } from '../core/waiter.js';
import { agentNames, hideReasoning, latestResult, programName, signatureFor } from '../core/reasoning.js';
import type { CompiledSignature, FilteredLines } from '../core/reasoning.js';
import type { Session } from '../core/session.js';
import { ENV_NAME_PATTERN, howSessionEnded } from '../core/types.js';
import type {
  Logger,
  PolicyConfig,
  SessionEnvMode,
  SessionSummary,
  WaitCondition,
} from '../core/types.js';
import {
  DASHBOARD_COOKIE,
  TokenStore,
  VIEWER_COOKIE,
  VIEWER_GRANT_TTL_MS,
  bearerToken,
  cookieValues,
  dashboardCookie,
  dashboardProofFromProtocol,
  viewerCookie,
} from './auth.js';
import { NULL_AUDITOR } from './audit.js';
import { findBrowser, launchDashboard, launchViewer } from './viewerLauncher.js';
import type { ViewerLaunchResult } from './viewerLauncher.js';
import {
  DEFAULT_CAPTURE_TIMEOUT_MS,
  MAX_CAPTURE_TIMEOUT_MS,
  MIN_CAPTURE_TIMEOUT_MS,
  captureProfileRoot,
  captureViewer,
  sweepCaptureProfiles,
} from './screenshot.js';
import type { ViewerLaunchConfig } from './viewerLauncher.js';
import type { Auditor } from './audit.js';
import {
  claimDaemonState,
  daemonStatePath,
  ensureHome,
  inspectDaemonState,
  readDaemonState,
  removeDaemonState,
  removeDaemonStateIf,
  removeDaemonStateIfNotARecord,
} from './paths.js';
import { daemonRunning } from './liveness.js';
import type { DaemonState } from './paths.js';
import { packageVersion } from './meta.js';
import { terminalReportKind } from './terminalReports.js';
import { ViewerSync } from './viewerSync.js';
import { SessionFeed } from './sessionFeed.js';
import type { FeedFrame, FeedSummary } from './sessionFeed.js';
import {
  compileProfilePolicy,
  copyDaemonEnv,
  describeProfileText,
  expandProfileText,
  resolveLaunchCommand,
} from './launchProfiles.js';
import type { LaunchFolder, LaunchProfile, LauncherConfig } from './launchProfiles.js';

const DEFAULT_IDLE_MS = 30 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 60_000;
/**
 * How often a running daemon checks that daemon.json still names it, and
 * publishes it again when it is missing or names a daemon that has gone.
 */
const STATE_PUBLISH_CHECK_MS = 10_000;
/**
 * How long a naturally-exited session stays readable before it is reaped.
 * Long enough for an agent to come back and read the final screen; short
 * enough that a busy day of short-lived sessions does not ratchet memory.
 */
const EXITED_SESSION_GRACE_MS = 15 * 60_000;
const MAX_BODY_BYTES = 1_000_000;
/**
 * Prompt-stall detection: how often live screens are scanned for a
 * permission prompt, and how long the SAME prompt must persist before an
 * alert is emitted. The stall threshold exists so a prompt the human answers
 * within seconds never alerts at all: the alert is for prompts NOBODY is
 * looking at.
 */
const PROMPT_SCAN_INTERVAL_MS = 5_000;
const PROMPT_STALL_MS = 20_000;
// A repaint can leave a scan with no complete dialog. Keep the held prompt
// for one second, long enough for a TUI redraw. A one-off check at the end
// of that grace clears a lasting disappearance between normal scan beats.
const PROMPT_REPAINT_GRACE_MS = 1_000;
/**
 * How long `verify` looks for typed text: a base, plus time for each
 * character, up to a ceiling. Some TUIs work through every keystroke before
 * they draw any of it: OpenCode draws a 300-character line all at once, about
 * 2.2 s after it arrives (about 7 ms a character). The allowance per
 * character leaves room for a slower machine; it is spent only when the text
 * does not show.
 */
const VERIFY_BASE_MS = 600;
const VERIFY_MS_PER_CHAR = 15;
const VERIFY_MAX_MS = 15_000;
/**
 * Scrollback lines carried in the snapshot a viewer receives (design §5). The
 * viewport is always complete; this bounds the history behind it. A 5,000-line
 * buffer at 160 columns serialises to ~700 KB in ~200 ms of daemon time, and
 * every grid change sends a fresh snapshot to every watcher, so the history
 * a snapshot carries is bounded at 2,000 lines.
 */
const VIEWER_SNAPSHOT_SCROLLBACK_LINES = 2_000;
/** Default size of the browser window a screenshot is taken in, in CSS pixels. */
const CAPTURE_WIDTH = 1_400;
const CAPTURE_HEIGHT = 900;
/**
 * Bounds on a grid derived from a browser window (§5).
 *
 * A viewport drives the grid, so the human's monitor would otherwise set what
 * the agent reads: a maximised 4K window at a small font asks for roughly
 * 380x100, and every snapshot the driving agent takes is then about 38,000
 * characters against about 4,000 at the 120x34 default. The bound travels with
 * every geometry frame; past it the page grows its text until this much grid
 * fills the window, then proposes that grid (§5).
 */
const MAX_VIEWPORT_COLS = 400;
const MAX_VIEWPORT_ROWS = 150;
/**
 * RIS plus erase-saved-lines, ahead of every snapshot: the viewer starts from
 * nothing, THROUGH its write queue, so anything it had queued applies before
 * the wipe and nothing stale can paint after it.
 */
const VIEWER_WIPE = '\x1bc\x1b[3J';

/**
 * What a watcher is shown when the session ends: grey, on its own line
 * and identical whether it was sent live at the moment of exit or replayed
 * to someone who joined during the fifteen-minute grace. An end with no exit
 * code says why the session ended (`howSessionEnded`).
 */
function exitNotice(exitCode: number | null): string {
  const notice =
    exitCode === null ? `session ended: ${howSessionEnded(null)}` : `process exited: ${String(exitCode)}`;
  return `\r\n\x1b[90m[${notice}]\x1b[0m\r\n`;
}

/**
 * Static viewer assets, resolved once and served from a fixed allowlist.
 * There is no path concatenation from request input, so no traversal surface.
 * `../viewer/` is `dist/viewer/` in production (copied by the build) and
 * `src/viewer/` under the test runner; the xterm bundles come straight out of
 * node_modules via module resolution.
 */
const viewerDir = fileURLToPath(new URL('../viewer/', import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const xtermJsPath = nodeRequire.resolve('@xterm/xterm');
const STATIC_ASSETS: Readonly<
  Record<string, { file: string; type: string; binary?: boolean }>
> = {
  '/viewer/viewer.js': { file: path.join(viewerDir, 'viewer.js'), type: 'text/javascript' },
  '/viewer/pane.js': { file: path.join(viewerDir, 'pane.js'), type: 'text/javascript' },
  '/viewer/viewer.css': { file: path.join(viewerDir, 'viewer.css'), type: 'text/css' },
  '/viewer/dashboard.js': { file: path.join(viewerDir, 'dashboard.js'), type: 'text/javascript' },
  '/viewer/dashboard.css': { file: path.join(viewerDir, 'dashboard.css'), type: 'text/css' },
  // The mark. SVG first (crisp at any size, and what the tab uses); the PNGs
  // are for Windows, which wants a raster for the taskbar button of a Chrome
  // --app window. An SVG-only favicon leaves that button showing the generic
  // globe.
  '/viewer/icon.svg': { file: path.join(viewerDir, 'icon.svg'), type: 'image/svg+xml' },
  '/viewer/icon-16.png': { file: path.join(viewerDir, 'icon-16.png'), type: 'image/png', binary: true },
  '/viewer/icon-32.png': { file: path.join(viewerDir, 'icon-32.png'), type: 'image/png', binary: true },
  '/viewer/icon-180.png': { file: path.join(viewerDir, 'icon-180.png'), type: 'image/png', binary: true },
  '/viewer/icon-512.png': { file: path.join(viewerDir, 'icon-512.png'), type: 'image/png', binary: true },
  '/vendor/xterm.js': { file: xtermJsPath, type: 'text/javascript' },
  '/vendor/xterm.css': {
    file: path.join(path.dirname(xtermJsPath), '..', 'css', 'xterm.css'),
    type: 'text/css',
  },
  '/vendor/addon-fit.js': { file: nodeRequire.resolve('@xterm/addon-fit'), type: 'text/javascript' },
};
const viewerHtmlPath = path.join(viewerDir, 'index.html');
const dashboardHtmlPath = path.join(viewerDir, 'dashboard.html');
/**
 * Shared by the viewer page and the dashboard page. Inline styles are what
 * xterm uses to size itself. Scripts stay under `default-src 'self'`.
 */
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const DASHBOARD_PROOF_META = '<meta name="sp-csrf" content="">';

export interface DaemonOptions {
  home: string;
  logger: Logger;
  policy?: PolicyConfig;
  /** Session environment hygiene (design §4.6, ADR-008). Defaults to clean. */
  sessionEnv?: SessionEnvMode;
  /** Action audit log (design §4.5). Defaults to no auditing (tests). */
  audit?: Auditor;
  idleMs?: number;
  /** Test hook: how often the idle check (and exited-session sweep) runs. */
  idleCheckIntervalMs?: number;
  /** Test hook: how often the daemon checks that daemon.json still names it. */
  statePublishCheckMs?: number;
  /** How long exited sessions stay readable before being reaped. */
  exitedGraceMs?: number;
  /** Called after an idle or lost-race self-stop; the entry point wires process.exit. */
  onSelfStop?: (reason: string) => void;
  /** Prompt-stall detection cadence. Test hooks; defaults above. */
  promptScanIntervalMs?: number;
  promptStallMs?: number;
  /**
   * How the viewer window is opened on session start. Absent means
   * "none", a deliberately inert default, so a test daemon cannot put browser
   * windows on someone's desktop by forgetting to opt out. The daemon entry
   * point supplies the product default of `isolated-app`.
   */
  viewer?: ViewerLaunchConfig;
  /**
   * Test seam: what actually opens the window. Defaults to the real launcher.
   * It exists so a test can see the URL the daemon would open, and check
   * that the window gets a grant of its own rather than the caller's.
   */
  launcher?: typeof launchViewer;
  /**
   * Test seam: what photographs the page. Defaults to the real headless
   * capture. It exists so a test can see the credential a capture is handed
   * without starting a browser, and check that it may watch but never write.
   */
  capture?: typeof captureViewer;
  /**
   * Test seam: the clock dashboard grant expiry is read from. Absent means
   * `Date.now`. A request cannot choose a grant's lifetime.
   */
  now?: () => number;
  /**
   * The named programs the dashboard may start (`launcher.profiles`, design
   * §4.3). Absent means a watch-only dashboard. Problems are served with the
   * profile list and logged by the entry point at start.
   */
  launchProfiles?: LauncherConfig;
}

/** Thrown by `start()` when a healthy daemon already owns this home. */
export class AlreadyRunningError extends Error {
  constructor(readonly state: DaemonState) {
    super(
      `A healthy daemon is already running (pid ${String(state.pid)}, ` +
        `port ${String(state.port)}).`,
    );
    this.name = 'AlreadyRunningError';
  }
}

type JsonBody = Record<string, unknown>;

/** The scheme and authority that open an absolute-form request target (`http://user@host:port`). */
const SCHEME_AND_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

/**
 * A request target's path, for a log line: without its query or fragment,
 * and, for an absolute-form target, without the scheme and authority, which
 * name the host and can name a user and a password. Split rather than
 * parsed: a target `new URL` refuses must still be logged, and never throw
 * inside the error handler.
 */
function pathOnly(target: string | undefined): string {
  const path = (target ?? '').split(/[?#]/, 1)[0] ?? '';
  const absolute = SCHEME_AND_AUTHORITY.exec(path);
  return absolute === null ? path : path.slice(absolute[0].length) || '/';
}

function headerOne(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Subprotocols offered on an upgrade, in header order. */
function offeredProtocols(req: http.IncomingMessage): string[] {
  const value = req.headers['sec-websocket-protocol'];
  const raw = Array.isArray(value) ? value.join(',') : (value ?? '');
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** The 409 for input, a key or a resize sent to a session that has ended. */
function endedRefusal(id: string, exitCode: number | null): string {
  return (
    `Session ${id} has ${exitCode === null ? 'ended' : 'exited'} ` +
    `(${howSessionEnded(exitCode)}) and no longer accepts input or geometry changes.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * A request body over `MAX_BODY_BYTES`. Answered with 413, not a reset: the
 * reader keeps consuming and discarding what is left so the response can be
 * read, rather than destroying the socket mid-upload.
 */
class RequestBodyTooLargeError extends Error {
  constructor() {
    super(`Request body too large: the limit is ${String(MAX_BODY_BYTES)} bytes.`);
    this.name = 'RequestBodyTooLargeError';
  }
}

function readBody(req: http.IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // discard the rest, so the 413 can be read
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new RequestBodyTooLargeError());
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(isRecord(parsed) ? parsed : {});
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'string') ? value : undefined;
}

/**
 * The bounds a grid is held to wherever it is asked for, so `start` and
 * `resize` cannot disagree about what a legal grid is. An absent side is the
 * session default and is not checked.
 */
const MIN_GRID_SIDE = 2;
const MAX_GRID_COLS = 1_000;
const MAX_GRID_ROWS = 500;
const GRID_BOUNDS_ERROR = 'cols must be an integer from 2 to 1000 and rows from 2 to 500.';

function gridOutOfBounds(cols: number | undefined, rows: number | undefined): boolean {
  if (
    cols !== undefined &&
    (!Number.isInteger(cols) || cols < MIN_GRID_SIDE || cols > MAX_GRID_COLS)
  ) {
    return true;
  }
  return (
    rows !== undefined &&
    (!Number.isInteger(rows) || rows < MIN_GRID_SIDE || rows > MAX_GRID_ROWS)
  );
}

/**
 * What is wrong with the SHAPE of a start request, in words, or null.
 *
 * A field that is present but of the wrong type is refused rather than
 * replaced by a default: a caller with a bug in its own serialisation
 * (`{cols: "80", rows: "24", args: 4}`) is told so, not handed a session at
 * the default grid with no arguments. An absent field takes its default;
 * only present-and-wrong is refused.
 */
/**
 * Scrollback read over a screen whose reasoning is being hidden: a reasoning
 * block whose first line has scrolled above what is returned is still
 * recognised where it carries on into it (`reasoning.ts`).
 */
const REASONING_CONTEXT_LINES = 400;
/** How far back `terminal_result` looks for the latest turn and its answer. */
const RESULT_LINES = 3000;

/** Why a signature could not read a screen just now. */
function overBudgetMessage(signature: CompiledSignature): string {
  return (
    `The ${signature.name} signature ran past the regular-expression time budget and is set ` +
    'aside for a minute, so the screen is not returned filtered. Try again shortly.'
  );
}

/**
 * A query flag: absent, `0` or `false` is off, `1` or `true` is on, and
 * anything else is null, a mistake the caller is refused for. A flag that
 * guards what leaves the daemon must never read a misspelt "on" as off.
 */
function queryFlag(url: URL, name: string): boolean | null {
  const value = url.searchParams.get(name);
  if (value === null || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return null;
}

/**
 * `drive=0` on a session stream: a viewer or client socket adopts the grid
 * and does not become the controller by connecting. An absent flag is not
 * this request. The single-session viewer sends none and still drives.
 * `drive=false` is not a spelling. A dashboard credential does not consult
 * this flag: that socket is always passive.
 */
function passiveDrive(url: URL): boolean {
  return url.searchParams.get('drive') === '0';
}

const BAD_HIDE_REASONING = 'hideReasoning must be true or false (or 1 or 0).';

/**
 * The cursor among the lines a filtered screen returns: on its own row when
 * that row is kept, on the marker of the block that hid it otherwise.
 */
function filteredCursor(cursor: { x: number; y: number }, filtered: FilteredLines): { x: number; y: number } {
  let y = 0;
  for (let k = 0; k < filtered.rows.length; k++) {
    if (filtered.rows[k]! <= cursor.y) y = k;
    else break;
  }
  const kept = filtered.rows[y] === cursor.y && filtered.markers[y] !== true;
  return { x: kept ? cursor.x : 0, y };
}

function startShapeError(body: JsonBody): string | null {
  const checks: [string, (value: unknown) => boolean, string][] = [
    ['agent', (value) => typeof value === 'string', 'a string'],
    [
      'args',
      (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string'),
      'an array of strings',
    ],
    ['cwd', (value) => typeof value === 'string', 'a string'],
    ['cols', (value) => typeof value === 'number', 'a number'],
    ['rows', (value) => typeof value === 'number', 'a number'],
    ['hold', (value) => typeof value === 'boolean', 'a boolean'],
    ['openViewer', (value) => typeof value === 'boolean', 'a boolean'],
    ['shell', (value) => typeof value === 'boolean', 'a boolean'],
    ['label', (value) => typeof value === 'string', 'a string'],
    ['purpose', (value) => typeof value === 'string', 'a string'],
    ['readyText', (value) => typeof value === 'string', 'a string'],
    [
      'readyQuiet',
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
      'a non-negative number of milliseconds',
    ],
  ];
  for (const [field, accepts, expected] of checks) {
    if (body[field] !== undefined && !accepts(body[field])) {
      return `${field} must be ${expected}.`;
    }
  }
  // The session's own variables, by name and value (§4.6). A refusal names the
  // variable but never quotes its value: the values are secrets more often
  // than not, and errors travel back to callers and into logs.
  const env = body['env'];
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      return 'env must be an object mapping variable names to string values.';
    }
    for (const [name, value] of Object.entries(env)) {
      if (!ENV_NAME_PATTERN.test(name)) {
        return `env name ${JSON.stringify(name)} must be letters, digits and underscores, not starting with a digit.`;
      }
      if (typeof value !== 'string' || value.includes('\0')) {
        return `env value for ${name} must be a string with no NUL characters.`;
      }
    }
  }
  return null;
}

export class Daemon {
  private readonly options: DaemonOptions;
  private readonly logger: Logger;
  private readonly tokens = new TokenStore();
  private readonly manager: SessionManager;
  private readonly server: http.Server;
  private readonly wss = new WebSocketServer({
    noServer: true,
    // Echo a subprotocol only when the dashboard credential opens the feed
    // or a session stream. A client token wins a session stream, so that
    // upgrade selects none even if the cookie and a live proof are also
    // offered. Returning false leaves the upgrade with none selected.
    handleProtocols: (protocols, request) => this.dashboardProtocol(protocols, request),
  });
  private readonly sockets = new Set<WebSocket>();
  /** Every watcher of a session, with the gate that orders its stream across snapshots. */
  private readonly sessionSockets = new Map<string, Map<WebSocket, ViewerSync>>();
  /**
   * The viewport currently driving each session's grid (§5).
   *
   * Connecting is passive and acting takes control: the first single-session
   * viewport to arrive with nobody driving picks the grid up, a later one
   * adopts what it finds, and a resize from that human hands control over.
   * A dashboard credential is the exception, whatever the query says. It
   * adopts and does not pick the grid up on connect, and it does not inherit
   * the grid when the controlling socket leaves. Its resize counts only when
   * the frame carries `take: true`. `drive=0` is the same opt-out for a
   * viewer or client socket, and it cannot make a dashboard socket drive.
   */
  private readonly geometryController = new Map<string, WebSocket>();
  /** Subscribers to the daemon-wide event stream (`/events`). */
  private readonly eventSockets = new Set<WebSocket>();
  /**
   * Open `/dashboard/events` sockets. While one is open, a session start does
   * not launch a per-session viewer window and does not hand back a viewer URL.
   */
  private readonly dashboardEventSockets = new Set<WebSocket>();
  /**
   * Per-session prompt tracking for stall alerts: the signature of the prompt
   * currently on screen, when it was first seen and whether it has alerted.
   */
  private readonly promptStates = new Map<
    string,
    {
      signature: string;
      since: number;
      alerted: boolean;
      prompt: DetectedPrompt;
      /** First scan that saw no complete prompt during a possible repaint. */
      missingSince: number | null;
    }
  >();
  private readonly version = packageVersion();
  private readonly sessionFeed: SessionFeed;

  private portValue: number | null = null;
  private waitsInFlight = 0;
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private raceCheckTimer: NodeJS.Timeout | null = null;
  private statePublishTimer: NodeJS.Timeout | null = null;
  private statePublishRunning = false;
  /** What this daemon published in daemon.json, once it has claimed it. */
  private publishedState: DaemonState | null = null;
  /** The pid of another running daemon already reported as owning daemon.json. */
  private foreignOwnerReported: number | null = null;
  private promptScanTimer: NodeJS.Timeout | null = null;
  private readonly promptGraceTimers = new Map<string, NodeJS.Timeout>();
  private promptScanRunning = false;
  private stopPromise: Promise<void> | null = null;

  private readonly audit: Auditor;
  /**
   * What sessions get from the daemon's environment (ADR-008), resolved once so
   * that what the daemon reports is what its sessions get.
   */
  private readonly sessionEnv: SessionEnvMode;
  /** The profiles the dashboard may name, and the entries that did not load. */
  private readonly launchProfiles: LauncherConfig;
  /** The global policy, kept here so a launch can report it before creating. */
  private readonly compiledPolicy: CompiledPolicy;
  /** Accepted launch times, for the sliding sixty-second cap. */
  private readonly launchTimes: number[] = [];

  constructor(options: DaemonOptions) {
    this.options = options;
    this.logger = options.logger;
    this.audit = options.audit ?? NULL_AUDITOR;
    this.sessionEnv = options.sessionEnv ?? DEFAULT_SESSION_ENV;
    this.launchProfiles = options.launchProfiles ?? { profiles: [], problems: [] };
    this.compiledPolicy = compilePolicy(options.policy);
    this.manager = new SessionManager(compilePolicy(options.policy), this.logger, {
      sessionEnv: this.sessionEnv,
    }, (id) => this.sessionFeed.remove(id));
    this.sessionFeed = new SessionFeed(
      this.version,
      () => this.manager.list().map((summary) => this.summaryWithPrompt(summary)),
      this.logger,
    );
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error: unknown) => {
        // What a person needs to find the fault: the stack, and which request
        // met it by method and path. Never the query, the headers or the
        // body: a query can carry a viewer grant, a header the client token.
        this.logger.error('unhandled request error', {
          method: req.method,
          path: pathOnly(req.url),
          error: error instanceof Error ? (error.stack ?? String(error)) : String(error),
        });
        if (!res.headersSent) json(res, 500, { error: 'The daemon hit an unexpected error handling this request. Its daemon.log records the error.' });
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as import('node:net').Socket, head);
    });
  }

  get port(): number {
    if (this.portValue === null) throw new Error('Daemon not started.');
    return this.portValue;
  }

  /** Clock for dashboard grant expiry. Tests inject one; otherwise wall time. */
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get token(): string {
    return this.tokens.token;
  }

  get connectedSockets(): number {
    return this.sockets.size;
  }

  /**
   * How many waits are polling right now. A counter rather than a log line,
   * because `core/` and `client/` may not write to a stream and a test needs
   * to see that a wait whose caller has gone actually stopped.
   */
  get waitsPolling(): number {
    return this.waitsInFlight;
  }

  get liveSessions(): number {
    return this.manager.liveCount();
  }

  /** Subscribe inside the daemon to the dashboard's session feed. */
  subscribeDashboardFeed(listener: (frame: FeedFrame) => void): () => void {
    return this.sessionFeed.subscribe(listener);
  }

  // ------------------------------------------------------------------ start
  async start(): Promise<{ port: number; token: string }> {
    const { home } = this.options;
    const homeResult = await ensureHome(home);
    if (homeResult.warning !== undefined) {
      this.logger.warn('home hardening warning', { warning: homeResult.warning });
    }

    // Defer to an incumbent that is running, even one too busy to answer its
    // health check; clear a record whose daemon has gone (design §2.3).
    const existing = readDaemonState(home);
    if (existing !== null) {
      if (await this.incumbentRunning(existing)) throw new AlreadyRunningError(existing);
      this.logger.info('clearing stale daemon state', { stalePid: existing.pid });
      removeDaemonStateIf(home, existing);
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        // Once listening, an error is a connection the server failed to
        // accept, out of handles say. With no listener it would be an
        // uncaught exception, on which the daemon shuts down with every
        // session; the server goes on accepting instead.
        this.server.on('error', (error) => {
          this.logger.error('http server error', { error: String(error) });
        });
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to determine bound port.');
    }
    this.portValue = address.port;

    // Browser detection is slow the first time it runs (viewerLauncher.ts), and
    // a session start waits for its viewer launch, so look once now and let the
    // memoised answer serve every start. It never holds the event loop, so the
    // daemon answers /health and everything else while it runs.
    if ((this.options.viewer?.launchMode ?? 'none') === 'isolated-app') {
      void findBrowser(this.options.viewer?.browserPath, this.logger).catch(() => undefined);
    }

    const state: DaemonState = {
      port: this.portValue,
      token: this.tokens.token,
      pid: process.pid,
      version: this.version,
      startedAt: new Date().toISOString(),
    };

    // Atomic claim; on losing the race, defer to the winner (design §2.2:
    // the race is normal, not exceptional). A file that holds no record at all,
    // such as an emptied one, is cleared like a stale record.
    if (!claimDaemonState(home, state)) {
      const winner = inspectDaemonState(home);
      if (winner.kind === 'record' && (await this.incumbentRunning(winner.state))) {
        await this.closeServerOnly();
        throw new AlreadyRunningError(winner.state);
      }
      if (winner.kind === 'record') removeDaemonStateIf(home, winner.state);
      if (winner.kind === 'not-a-record') {
        this.logger.warn('clearing a daemon.json that holds no daemon record', {
          length: winner.raw.length,
        });
        removeDaemonStateIfNotARecord(home, winner.raw);
      }
      if (!claimDaemonState(home, state)) {
        await this.closeServerOnly();
        throw new Error(
          `Could not claim ${daemonStatePath(home)}: it could not be read, or another ` +
            `daemon claimed it first.`,
        );
      }
    }

    // Belt and braces for the unlink/claim TOCTOU sliver: shortly after
    // start-up, if the published record names someone else and nobody is
    // attached to us, bow out quietly. Clients only ever discover the daemon
    // named in the file, so nobody can be depending on us yet.
    this.raceCheckTimer = setTimeout(() => {
      const current = readDaemonState(home);
      if (
        current !== null &&
        current.pid !== process.pid &&
        this.manager.size() === 0 &&
        this.sockets.size === 0
      ) {
        this.logger.info('lost start-up race after claim, stopping', {
          winnerPid: current.pid,
        });
        void this.stop({ removeState: false }).then(() => {
          this.options.onSelfStop?.('lost-race');
        });
      }
    }, 1_000);
    this.raceCheckTimer.unref();

    // Capture profiles an earlier daemon on this home could not remove, which
    // Windows can refuse while a browser's last processes hold them. Only
    // folders a capture names, untouched for longer than any capture runs.
    void sweepCaptureProfiles(captureProfileRoot(home), this.logger);

    // Said once, at start, because passthrough leaks silently otherwise
    // (ADR-008): the names only, never the values.
    const { exposed } = this.environmentReport();
    if (exposed.length > 0) {
      this.logger.warn(
        'sessionEnv "passthrough" hands every session the daemon environment, including ' +
          'these variables whose names look like credentials; use "clean" or a list to keep them out',
        { names: exposed },
      );
    }

    this.publishedState = state;
    this.statePublishTimer = setInterval(() => {
      void this.keepStatePublished();
    }, this.options.statePublishCheckMs ?? STATE_PUBLISH_CHECK_MS);
    this.statePublishTimer.unref();

    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    this.idleTimer = setInterval(() => {
      // Reap sessions whose grace has lapsed before judging idleness. A
      // rejected sweep must be caught here, or it becomes an
      // unhandledRejection and the handler in index.ts stops the daemon.
      this.sweepExited().catch((error: unknown) => {
        this.logger.warn('exited-session sweep failed', { error: String(error) });
      });
      // Never exit while any session is live: an unattended agent run with no
      // connected clients is a core use case, not idleness (design §2.3).
      if (
        this.manager.liveCount() === 0 &&
        this.sockets.size === 0 &&
        Date.now() - this.lastActivity > idleMs
      ) {
        this.logger.info('idle shutdown', { idleMs });
        void this.stop().then(() => {
          this.options.onSelfStop?.('idle');
        });
      }
    }, this.options.idleCheckIntervalMs ?? IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref();

    // Prompt-stall scanner: overlap-guarded because snapshots are
    // async: a slow render must skip a beat, never queue a backlog.
    this.promptScanTimer = setInterval(() => {
      if (this.promptScanRunning) return;
      this.promptScanRunning = true;
      this.scanForPromptStalls()
        .catch((error: unknown) => {
          this.logger.warn('prompt scan failed', { error: String(error) });
        })
        .finally(() => {
          this.promptScanRunning = false;
        });
    }, this.options.promptScanIntervalMs ?? PROMPT_SCAN_INTERVAL_MS);
    this.promptScanTimer.unref();

    this.logger.info('daemon started', {
      port: this.portValue,
      pid: process.pid,
      version: this.version,
    });
    return { port: this.portValue, token: this.tokens.token };
  }

  /**
   * Whether the daemon a record names is running, so that this one must
   * defer to it: one that answers its health check, or one whose process is
   * alive and whose port accepts a connection although it is too busy to
   * answer. A record naming this very daemon is not an incumbent, and one
   * naming this process that does not answer is a leftover from an earlier
   * process that had the same pid.
   */
  private async incumbentRunning(record: DaemonState): Promise<boolean> {
    if (record.pid === process.pid && record.port === this.portValue) return false;
    if (await this.isHealthy(record.port)) return true;
    if (record.pid === process.pid) return false;
    if (await daemonRunning(record)) {
      this.logger.info('deferring to a running daemon that did not answer its health check', {
        pid: record.pid,
        port: record.port,
      });
      return true;
    }
    return false;
  }

  /**
   * Keep daemon.json naming this daemon while it runs. When the file is
   * missing, holds no daemon record or names a daemon that has gone, publish
   * it again, so new clients can still reach this daemon's sessions. When it
   * names another daemon that is running, leave it, but say so once in
   * daemon.log: new clients reach that daemon, and this one's sessions only
   * through clients already connected. A file that cannot be read is left
   * alone, since a failed read says nothing about what it holds.
   */
  private async keepStatePublished(): Promise<void> {
    const published = this.publishedState;
    if (published === null || this.stopPromise !== null || this.statePublishRunning) return;
    this.statePublishRunning = true;
    try {
      const { home } = this.options;
      const file = inspectDaemonState(home);
      if (file.kind === 'unreadable') return;
      if (file.kind === 'record') {
        const current = file.state;
        if (current.pid === published.pid && current.port === published.port) {
          this.foreignOwnerReported = null;
          return;
        }
        if (await daemonRunning(current)) {
          if (this.foreignOwnerReported !== current.pid) {
            this.foreignOwnerReported = current.pid;
            this.logger.warn('daemon.json names another running daemon; new clients reach it, not this one', {
              otherPid: current.pid,
              otherPort: current.port,
              sessions: this.manager.size(),
            });
          }
          return;
        }
        removeDaemonStateIf(home, current);
      } else if (file.kind === 'not-a-record') {
        removeDaemonStateIfNotARecord(home, file.raw);
      }
      if (this.stopPromise === null && claimDaemonState(home, published)) {
        this.foreignOwnerReported = null;
        this.logger.warn(
          'daemon.json was missing, held no daemon record or named a daemon that has gone; published it again',
          { pid: published.pid, port: published.port },
        );
      }
    } catch (error) {
      this.logger.warn('checking daemon.json failed', { error: String(error) });
    } finally {
      this.statePublishRunning = false;
    }
  }

  private async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return typeof body === 'object' && body !== null && (body as { ok?: boolean }).ok === true;
    } catch {
      return false;
    }
  }

  private closeServerOnly(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      // close() waits for idle connections; nothing is connected this early.
    });
  }

  // ------------------------------------------------------------------- stop
  /**
   * Kill every session's process tree, close everything, remove the state
   * file (unless we lost the race and it now belongs to the winner).
   * The daemon must never exit and strand running agent CLIs (design §2.3).
   */
  stop(opts: { removeState?: boolean } = {}): Promise<void> {
    // Idle-stop, signal handlers and explicit stops can overlap, so everyone
    // awaits the one real shutdown.
    this.stopPromise ??= this.doStop(opts);
    return this.stopPromise;
  }

  private async doStop(opts: { removeState?: boolean }): Promise<void> {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    if (this.raceCheckTimer !== null) clearTimeout(this.raceCheckTimer);
    if (this.statePublishTimer !== null) clearInterval(this.statePublishTimer);
    if (this.promptScanTimer !== null) clearInterval(this.promptScanTimer);
    for (const timer of this.promptGraceTimers.values()) clearTimeout(timer);
    this.promptGraceTimers.clear();

    // Stop LISTENING first, before tearing down session trees. Killing process
    // trees is not fast (`taskkill /T` on a loaded machine can take seconds
    // per session), and a daemon that still answers on its port while shutting
    // down looks alive to every client polling /health. `close()` refuses new
    // connections immediately while letting in-flight responses drain on
    // their existing socket, notably the reply to this very shutdown request.
    const listenerClosed = new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    for (const socket of this.sockets) {
      try {
        socket.close();
      } catch {
        // Best effort.
      }
    }

    await this.manager.killAll();
    if (opts.removeState !== false) {
      // Remove this daemon's record, or a file that holds none. A file that
      // cannot be read says nothing about what it holds, so it stays.
      const file = inspectDaemonState(this.options.home);
      if (file.kind === 'record' && file.state.pid === process.pid) {
        removeDaemonState(this.options.home);
      } else if (file.kind === 'not-a-record') {
        removeDaemonStateIfNotARecord(this.options.home, file.raw);
      }
    }
    // Only now terminate lingering keep-alive connections, so close() cannot hang.
    this.server.closeAllConnections();
    await listenerClosed;
    this.logger.info('daemon stopped');
  }

  /**
   * What sessions inherit (ADR-008): the mode, and under passthrough the names
   * of the credential-shaped variables in the daemon's environment. Never values.
   */
  private environmentReport(): { mode: 'clean' | 'list' | 'passthrough'; exposed: string[] } {
    const mode = this.sessionEnv;
    if (mode === 'passthrough') return { mode, exposed: credentialShapedNames(process.env) };
    return { mode: mode === 'clean' ? 'clean' : 'list', exposed: [] };
  }

  // ------------------------------------------------------- request handling
  private hostAllowed(host: string | undefined): boolean {
    if (host === undefined || this.portValue === null) return false;
    const normalised = host.toLowerCase();
    return (
      normalised === `127.0.0.1:${String(this.portValue)}` ||
      normalised === `localhost:${String(this.portValue)}`
    );
  }

  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true; // non-browser clients send none
    if (this.portValue === null) return false;
    const normalised = origin.toLowerCase();
    return (
      normalised === `http://127.0.0.1:${String(this.portValue)}` ||
      normalised === `http://localhost:${String(this.portValue)}`
    );
  }

  /**
   * An Origin that is this daemon's own and whose host matches `Host`.
   * `127.0.0.1` and `localhost` are both allowed names, and they are not the
   * same host: a cookie minted for one must not be presented as the other.
   */
  private originMatchesRequest(req: http.IncomingMessage): boolean {
    const origin = headerOne(req, 'origin');
    if (origin === undefined || origin === '') return false;
    if (!this.originAllowed(origin)) return false;
    const host = headerOne(req, 'host');
    if (host === undefined) return false;
    try {
      return new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  /** Top-level document load of the dashboard. Origin may be absent. */
  private isDocumentNavigation(req: http.IncomingMessage): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (headerOne(req, 'sec-fetch-mode') !== 'navigate') return false;
    if (headerOne(req, 'sec-fetch-dest') !== 'document') return false;
    const site = headerOne(req, 'sec-fetch-site');
    if (site !== 'none' && site !== 'same-origin') return false;
    const origin = headerOne(req, 'origin');
    if (origin === undefined || origin === '') return true;
    return this.originMatchesRequest(req);
  }

  /** Same-origin read, such as `GET /sessions` from the dashboard page. */
  private isSameOriginRead(req: http.IncomingMessage): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (headerOne(req, 'sec-fetch-site') !== 'same-origin') return false;
    const mode = headerOne(req, 'sec-fetch-mode');
    if (mode !== 'cors' && mode !== 'no-cors' && mode !== 'same-origin') return false;
    const origin = headerOne(req, 'origin');
    if (origin === undefined || origin === '') return true;
    return this.originMatchesRequest(req);
  }

  /** `same-site`, `cross-site`, or any site value that is not a dashboard site. */
  private forbiddenFetchSite(site: string | undefined): boolean {
    if (site === undefined || site === '') return false;
    return site !== 'none' && site !== 'same-origin';
  }

  private dashboardCookiePresented(header: string | undefined): boolean {
    if (header === undefined) return false;
    for (const part of header.split(';')) {
      const at = part.indexOf('=');
      if (at === -1) continue;
      if (part.slice(0, at).trim() === DASHBOARD_COOKIE) return true;
    }
    return false;
  }

  /** The first `sp_dash` value the daemon issued for the current credential. */
  private dashboardCookieToken(header: string | undefined): string | null {
    for (const value of cookieValues(header, DASHBOARD_COOKIE)) {
      if (this.tokens.verifyDashboardToken(value)) return value;
    }
    return null;
  }

  private auditDashboardRefusal(req: http.IncomingMessage, reason: string): void {
    this.audit.record('dashboard', 'refuse', undefined, {
      method: req.method ?? '',
      path: pathOnly(req.url),
      reason,
    });
  }

  /**
   * Why a presented cookie was refused on a route that may omit Origin:
   * the dashboard page, outside a document navigation, and `GET /sessions`.
   * A present Origin that does not match is `origin`. These routes allow an
   * absent Origin, so that absence is not the reason: the Fetch Metadata is.
   */
  private cookieRefusalReason(req: http.IncomingMessage): string {
    const origin = headerOne(req, 'origin');
    const originAbsent = origin === undefined || origin === '';
    if (!originAbsent && !this.originMatchesRequest(req)) return 'origin';
    return 'fetch-site';
  }

  private dashboardDocument(proof: string | null): string {
    const html = fs.readFileSync(dashboardHtmlPath, 'utf8');
    if (proof === null) return html.replace(DASHBOARD_PROOF_META, '');
    return html.replace(DASHBOARD_PROOF_META, `<meta name="sp-csrf" content="${proof}">`);
  }

  private sendDashboardPage(
    res: http.ServerResponse,
    proof: string | null,
    setCookieHeader: string | undefined,
    head: boolean,
  ): void {
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': PAGE_CSP,
    };
    if (setCookieHeader !== undefined) headers['set-cookie'] = setCookieHeader;
    res.writeHead(200, headers);
    res.end(head ? '' : this.dashboardDocument(proof));
  }

  /**
   * `GET` and `HEAD /dashboard`. A grant is spent only by an accepted
   * document navigation. A fetch of the same URL does not spend it. A bad,
   * spent or absent grant with no live cookie still returns the page, with
   * no cookie and no proof, so this route does not say whether a grant was real.
   */
  private handleDashboardPage(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const site = headerOne(req, 'sec-fetch-site');
    if (this.forbiddenFetchSite(site)) {
      this.auditDashboardRefusal(req, 'fetch-site');
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    const grant = url.searchParams.get('dt');
    const grantPresented = grant !== null && grant !== '';
    const cookiePresented = this.dashboardCookiePresented(req.headers.cookie);
    const cookie = this.dashboardCookieToken(req.headers.cookie);
    if (this.isDocumentNavigation(req)) {
      let freshCookie: string | undefined;
      if (grantPresented) {
        const redeemed = this.tokens.redeemDashboardGrant(grant, this.now());
        if (redeemed !== null) {
          freshCookie = dashboardCookie(redeemed.token);
          this.audit.record('dashboard', 'grant-redeem');
        }
      }
      const authed = freshCookie !== undefined || cookie !== null;
      const proof = authed ? this.tokens.issueDashboardProof() : null;
      this.sendDashboardPage(res, proof, freshCookie, req.method === 'HEAD');
      return;
    }
    if (grantPresented || cookiePresented) {
      if (!this.isSameOriginRead(req)) {
        this.auditDashboardRefusal(req, this.cookieRefusalReason(req));
        json(res, 403, { error: 'Forbidden.' });
        return;
      }
    }
    this.sendDashboardPage(res, null, undefined, req.method === 'HEAD');
  }

  private async handleDashboardOpen(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    actor: string,
  ): Promise<void> {
    // The body cannot choose a lifetime. It is read so a keep-alive connection
    // is not left holding it, and then ignored.
    await readBody(req);
    const grant = this.tokens.mintDashboardGrant({ now: this.now() });
    const pageUrl = `http://127.0.0.1:${String(this.port)}/dashboard?dt=${grant}`;
    // The dashboard opens only in the isolated profile. The viewer launcher
    // may fall back to the default browser so a session start never fails;
    // that fallback would hand this grant to a profile with extensions.
    const launch = this.options.launcher ?? launchDashboard;
    let opened: ViewerLaunchResult;
    try {
      opened = await launch(pageUrl, this.options.home, this.options.viewer ?? {}, this.logger);
    } catch {
      // The thrown text can carry the URL. It is not logged and not returned.
      opened = { launched: false, mode: 'none' };
    }
    if (!opened.launched || opened.mode === 'default-browser') {
      this.tokens.revokeDashboardGrant(grant);
      this.auditDashboardRefusal(req, 'launch-failed');
      json(res, 502, {
        error:
          'The dashboard window did not open. ShellPuppet opens the dashboard only in its ' +
          'own browser profile; set viewer.browserPath in config.json to a Chromium-family ' +
          'browser.',
      });
      return;
    }
    this.audit.record(actor, 'grant-mint', undefined, { credential: 'dashboard' });
    json(res, 200, { opened: true });
  }

  private writeSessionList(res: http.ServerResponse, url: URL): void {
    const hide = queryFlag(url, 'hideReasoning');
    if (hide === null) {
      json(res, 400, { error: BAD_HIDE_REASONING });
      return;
    }
    json(res, 200, { sessions: this.listWithPrompts(hide), version: this.version });
  }

  /** Cookie-authenticated `GET /sessions`. A missing or wrong proof is a 403. */
  private serveDashboardSessionList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const presented = this.dashboardCookiePresented(req.headers.cookie);
    const cookie = this.dashboardCookieToken(req.headers.cookie);
    if (cookie === null) {
      if (presented) this.auditDashboardRefusal(req, 'unauthenticated');
      json(res, 401, { error: 'Unauthorised: a valid client token is required.' });
      return;
    }
    if (!this.isSameOriginRead(req)) {
      this.auditDashboardRefusal(req, this.cookieRefusalReason(req));
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    const proof = headerOne(req, 'x-shellpuppet-csrf');
    if (!this.tokens.acceptsDashboardProof(proof)) {
      this.auditDashboardRefusal(req, 'proof');
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    this.lastActivity = Date.now();
    this.writeSessionList(res, url);
  }

  /** A cookie mutation: same-origin Fetch Metadata and a matching Origin. */
  private isSameOriginMutation(req: http.IncomingMessage): boolean {
    if (headerOne(req, 'sec-fetch-site') !== 'same-origin') return false;
    return this.originMatchesRequest(req);
  }

  /**
   * Why a cookie mutation is refused, for the audit. A missing or foreign
   * `Origin` is `origin`; a request whose `Origin` is this page's but whose
   * `Sec-Fetch-Site` is not `same-origin` is `fetch-site`. The route needs
   * both, so this only decides the reason a request failing both is recorded
   * under: naming the Origin keeps the two defences apart in the log.
   */
  private mutationRefusalReason(req: http.IncomingMessage): string {
    const origin = headerOne(req, 'origin');
    if (origin === undefined || origin === '' || !this.originMatchesRequest(req)) return 'origin';
    return 'fetch-site';
  }

  /**
   * What the page needs to show a profile, and nothing secret: the command
   * and arguments are the profile's own, and `envFromDaemon` contributes
   * names. `{folder}` stays unexpanded here because it depends on the click.
   */
  private profileDescription(profile: LaunchProfile): Record<string, unknown> {
    return {
      name: profile.name,
      label: describeProfileText(profile.label ?? '', profile.name),
      purpose: describeProfileText(profile.purpose ?? '', profile.name),
      command: profile.command,
      args: [...profile.args],
      folderRequired: profile.askCwd,
      folders: profile.folders.map((folder) => ({ name: folder.name, path: folder.path })),
      envFromDaemon: [...profile.envFromDaemon],
    };
  }

  /** Cookie-authenticated `GET /dashboard/profiles`. A missing proof is a 403. */
  private serveDashboardProfiles(req: http.IncomingMessage, res: http.ServerResponse): void {
    const presented = this.dashboardCookiePresented(req.headers.cookie);
    const cookie = this.dashboardCookieToken(req.headers.cookie);
    if (cookie === null) {
      if (presented) this.auditDashboardRefusal(req, 'unauthenticated');
      json(res, 401, { error: 'Unauthorised: a valid client token is required.' });
      return;
    }
    if (!this.isSameOriginRead(req)) {
      this.auditDashboardRefusal(req, this.cookieRefusalReason(req));
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    if (!this.tokens.acceptsDashboardProof(headerOne(req, 'x-shellpuppet-csrf'))) {
      this.auditDashboardRefusal(req, 'proof');
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    this.lastActivity = Date.now();
    json(res, 200, {
      profiles: this.launchProfiles.profiles.map((profile) => this.profileDescription(profile)),
      problems: [...this.launchProfiles.problems],
    });
  }

  /**
   * The directory a launch starts in: the selected folder's configured path,
   * the profile's fixed path, or the user's home. Relative paths are taken
   * from the user's home, as a direct `POST /sessions` does. The path is a
   * spawn `cwd`, never a command-line fragment.
   */
  private resolveLaunchCwd(
    profile: LaunchProfile,
    folder: LaunchFolder | undefined,
  ): { cwd: string } | { error: string } {
    const configured = folder?.path ?? profile.cwd;
    const cwd = configured === undefined ? os.homedir() : path.resolve(os.homedir(), configured);
    try {
      if (!fs.statSync(cwd).isDirectory()) return { error: `Working directory is not a directory: ${cwd}` };
    } catch {
      return { error: `Working directory does not exist: ${cwd}` };
    }
    return { cwd };
  }

  /** Accepted launch times inside the last sixty seconds, oldest first. */
  private pruneLaunchTimes(now: number): void {
    while (this.launchTimes.length > 0 && (this.launchTimes[0] ?? now) <= now - 60_000) {
      this.launchTimes.shift();
    }
  }

  /**
   * `POST /dashboard/launch`: one configured profile, and nothing else. The
   * body names a profile and, when that profile asks, one of its folders. It
   * cannot supply a command, arguments, a path or an environment value.
   */
  private async handleDashboardLaunch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const presented = this.dashboardCookiePresented(req.headers.cookie);
    const cookie = this.dashboardCookieToken(req.headers.cookie);
    if (cookie === null) {
      if (presented) this.auditDashboardRefusal(req, 'unauthenticated');
      json(res, 401, { error: 'Unauthorised: a valid client token is required.' });
      return;
    }
    if (!this.isSameOriginMutation(req)) {
      this.auditDashboardRefusal(req, this.mutationRefusalReason(req));
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    // Only `application/json`, with optional parameters such as `charset`.
    // A missing header and `application/jsonp` are both refused: the launch
    // body is JSON and nothing else.
    const mediaType = (headerOne(req, 'content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (mediaType !== 'application/json') {
      this.auditDashboardRefusal(req, 'content-type');
      json(res, 415, { error: 'The launch body must be JSON (application/json).' });
      return;
    }
    if (!this.tokens.acceptsDashboardProof(headerOne(req, 'x-shellpuppet-csrf'))) {
      this.auditDashboardRefusal(req, 'proof');
      json(res, 403, { error: 'Forbidden.' });
      return;
    }

    let body: JsonBody;
    try {
      body = await readBody(req);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        this.auditDashboardRefusal(req, 'body-size');
        json(res, 413, { error: error.message });
        return;
      }
      if (error instanceof Error && error.message.startsWith('Request body')) {
        this.auditDashboardRefusal(req, 'body');
        json(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    const profileName = asString(body['profile']);
    if (profileName === undefined || profileName === '') {
      json(res, 400, { error: 'profile (string) is required.' });
      return;
    }
    for (const key of Object.keys(body)) {
      if (key !== 'profile' && key !== 'folder') {
        this.auditDashboardRefusal(req, 'body');
        json(res, 400, {
          error:
            `The launch body may name only profile and folder: "${key}" is not accepted. ` +
            'A command, arguments, a path and an environment value come from the profile.',
        });
        return;
      }
    }
    const profile = this.launchProfiles.profiles.find((entry) => entry.name === profileName);
    if (profile === undefined) {
      json(res, 400, { error: `No such launch profile: ${profileName}` });
      return;
    }

    const folderName = body['folder'];
    let folder: LaunchFolder | undefined;
    if (profile.askCwd) {
      if (folderName === undefined) {
        json(res, 400, { error: `folder (string) is required for profile "${profileName}".` });
        return;
      }
      if (typeof folderName !== 'string') {
        json(res, 400, { error: 'folder must be a string.' });
        return;
      }
      folder = profile.folders.find((entry) => entry.name === folderName);
      if (folder === undefined) {
        json(res, 400, {
          error: `No such folder for profile "${profileName}": ${folderName}`,
        });
        return;
      }
    } else if (folderName !== undefined) {
      json(res, 400, {
        error: `Profile "${profileName}" uses a fixed working directory and does not accept a folder.`,
      });
      return;
    }

    const resolved = this.resolveLaunchCwd(profile, folder);
    if ('error' in resolved) {
      json(res, 400, { error: resolved.error });
      return;
    }

    // Global policy runs first, then the profile's own deny and allow lists.
    // Both see the real command line, before any Windows shell wrap.
    const globalDecision = evaluateCommand(this.compiledPolicy, profile.command, profile.args);
    if (!globalDecision.allowed) {
      this.auditDashboardRefusal(req, 'policy');
      json(res, 403, { error: globalDecision.reason ?? 'Command refused by policy.' });
      return;
    }
    if (profile.policy !== undefined) {
      const ownDecision = evaluateCommand(
        compileProfilePolicy(profile.policy),
        profile.command,
        profile.args,
      );
      if (!ownDecision.allowed) {
        this.auditDashboardRefusal(req, 'policy');
        json(res, 403, { error: ownDecision.reason ?? 'Command refused by policy.' });
        return;
      }
    }

    // Resolve the command to the file that will run before anything starts.
    // Policy and the page keep the written command; the spawn gets the
    // absolute path, so the folder's contents cannot choose the program.
    const resolvedCommand = resolveLaunchCommand(profile.command, resolved.cwd);
    if ('error' in resolvedCommand) {
      this.auditDashboardRefusal(req, 'command');
      json(res, 400, {
        error: `Profile "${profile.name}" cannot be started: ${resolvedCommand.error}`,
      });
      return;
    }

    const now = this.now();
    this.pruneLaunchTimes(now);
    if (this.launchTimes.length >= 8) {
      this.auditDashboardRefusal(req, 'rate');
      json(res, 429, {
        error:
          'Dashboard launch rate reached (8 in 60 seconds). Wait before starting another profile.',
      });
      return;
    }

    const live = this.manager.liveCount();
    if (this.compiledPolicy.maxSessions === undefined) {
      if (live >= 32) {
        this.auditDashboardRefusal(req, 'limit');
        json(res, 403, {
          error:
            'Session limit reached (32 live sessions). Kill a session or set policy.maxSessions.',
        });
        return;
      }
    } else {
      const capacity = checkSessionCapacity(this.compiledPolicy, live);
      if (!capacity.allowed) {
        this.auditDashboardRefusal(req, 'limit');
        json(res, 403, { error: capacity.reason ?? 'Session limit reached.' });
        return;
      }
    }

    const { env, copied } = copyDaemonEnv(profile.envFromDaemon, process.env);
    const envNames = Object.keys(env);
    const folderLabel = folder?.name;
    const options = {
      command: resolvedCommand.file,
      args: [...profile.args],
      cwd: resolved.cwd,
      ...(profile.shell !== undefined ? { shell: profile.shell } : {}),
      ...(profile.agent !== undefined ? { agent: profile.agent } : {}),
      ...(profile.readyText !== undefined ? { readyText: profile.readyText } : {}),
      ...(profile.readyQuiet !== undefined ? { readyQuiet: profile.readyQuiet } : {}),
      // The written command stays the session's label, as it was before the
      // path was resolved: the page shows the profile, not a machine path.
      ...(profile.label !== undefined
        ? { label: expandProfileText(profile.label, profile.name, folderLabel) }
        : { label: profile.command }),
      ...(profile.purpose !== undefined
        ? { purpose: expandProfileText(profile.purpose, profile.name, folderLabel) }
        : {}),
      ...(envNames.length > 0 ? { env } : {}),
      // The audit actor, not a caller-declared identity: the dashboard page
      // has no client environment and no other way to name itself.
      startedBy: 'dashboard',
    };

    let session: Session;
    try {
      session = this.manager.create(options);
    } catch (error) {
      if (error instanceof PolicyViolationError) {
        this.auditDashboardRefusal(req, 'policy');
        json(res, 403, { error: error.message });
        return;
      }
      if (error instanceof CommandNotFoundError) {
        json(res, 400, { error: error.message });
        return;
      }
      this.logger.error('dashboard session start failed', {
        error: error instanceof Error ? (error.stack ?? String(error)) : String(error),
      });
      if (error instanceof NativePtyUnavailableError) {
        json(res, 500, { error: error.message });
        return;
      }
      json(res, 500, { error: `Failed to start session: ${String(error)}` });
      return;
    }
    this.launchTimes.push(now);
    // A launch is an API call: the idle timer counts from it, so a session
    // that has just started is not reaped sooner than `idleMinutes` allows.
    this.lastActivity = Date.now();

    this.sessionFeed.add(this.summaryWithPrompt(session.summary()));
    session.onExit(() => this.updateFeedSession(session.id));
    session.onReady(() => this.updateFeedSession(session.id));

    // The profile name and the written command line, the file that was
    // actually resolved and started, and the names of the variables actually
    // copied from the daemon. Never a value.
    this.audit.record('dashboard', 'start', session.id, {
      profile: profile.name,
      command: profile.command,
      args: profile.args,
      resolvedCommand: resolvedCommand.file,
      ...(copied.length > 0 ? { envFromDaemon: copied } : {}),
      ...(folder !== undefined ? { folder: folder.name } : {}),
      ...(session.label !== '' ? { label: session.label } : {}),
    });

    // No viewer window and no viewer grant: the dashboard page is the
    // window, and it acts on the profile's `open` value.
    json(res, 200, {
      id: session.id,
      open: profile.open,
      profile: profile.name,
      ...(copied.length > 0 ? { envFromDaemon: [...copied] } : {}),
    });
  }

  /**
   * `DELETE /sessions/<id>` for the dashboard cookie. Origin, Fetch Metadata
   * and the document proof are the same checks as launch. One call kills the
   * session and audits actor `dashboard`. A client token never reaches here.
   */
  private async handleDashboardKill(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const presented = this.dashboardCookiePresented(req.headers.cookie);
    const cookie = this.dashboardCookieToken(req.headers.cookie);
    if (cookie === null) {
      if (presented) this.auditDashboardRefusal(req, 'unauthenticated');
      json(res, 401, { error: 'Unauthorised: a valid client token is required.' });
      return;
    }
    if (!this.isSameOriginMutation(req)) {
      this.auditDashboardRefusal(req, this.mutationRefusalReason(req));
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    if (!this.tokens.acceptsDashboardProof(headerOne(req, 'x-shellpuppet-csrf'))) {
      this.auditDashboardRefusal(req, 'proof');
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    // Drain the body so a keep-alive connection is not left holding it. The
    // kill takes nothing from the body: a command there cannot change it.
    try {
      await readBody(req);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        this.auditDashboardRefusal(req, 'body-size');
        json(res, 413, { error: error.message });
        return;
      }
      if (error instanceof Error && error.message.startsWith('Request body')) {
        this.auditDashboardRefusal(req, 'body');
        json(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    if (this.manager.get(id) === undefined) {
      json(res, 404, { error: `No such session: ${id}` });
      return;
    }
    this.lastActivity = Date.now();
    this.audit.record('dashboard', 'kill', id);
    await this.manager.kill(id);
    this.dropSessionArtifacts(id);
    json(res, 200, { ok: true, killed: id });
  }

  /**
   * Why a `/dashboard/events` upgrade is refused, or null when it may attach.
   * The client token on the query is not a way in. The proof is the
   * subprotocol, not `X-ShellPuppet-CSRF`.
   */
  private dashboardUpgradeRefusal(
    req: http.IncomingMessage,
  ): { code: number; reason: string; audit: string } | null {
    if (this.dashboardCookieToken(req.headers.cookie) === null) {
      return { code: 401, reason: 'Unauthorized', audit: 'unauthenticated' };
    }
    if (!this.originMatchesRequest(req)) {
      return { code: 403, reason: 'Forbidden', audit: 'origin' };
    }
    // Chromium's WebSocket handshake omits both Fetch Metadata headers. The
    // exact Origin and document proof above still bind it to this page. When
    // either header is present, require the complete same-origin pair.
    const site = headerOne(req, 'sec-fetch-site');
    const mode = headerOne(req, 'sec-fetch-mode');
    if (!((site === 'same-origin' && mode === 'websocket') ||
      (site === undefined && mode === undefined))) {
      return { code: 403, reason: 'Forbidden', audit: 'fetch-site' };
    }
    const accepted = offeredProtocols(req).some((protocol) => {
      const proof = dashboardProofFromProtocol(protocol);
      return proof !== null && this.tokens.acceptsDashboardProof(proof);
    });
    if (!accepted) return { code: 403, reason: 'Forbidden', audit: 'proof' };
    return null;
  }

  /**
   * Select `sp-csrf.<proof>` when this upgrade's credential is the dashboard
   * cookie: the dashboard feed, or a session stream the client token did not
   * take. The echo names that credential. A viewer or client socket, including
   * a client token that also carries the cookie and offers a live proof,
   * selects none. Returning false leaves the upgrade with none selected.
   */
  private dashboardProtocol(protocols: Set<string>, request: http.IncomingMessage): string | false {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      return false;
    }
    const segments = url.pathname.split('/').filter((part) => part !== '');
    const sessionStream =
      segments.length === 3 && segments[0] === 'sessions' && segments[2] === 'stream';
    if (url.pathname !== '/dashboard/events' && !sessionStream) return false;
    // Same preference as sessionStreamDecision: a live client token opens a
    // client socket, so the echoed protocol must not say this is the dashboard.
    if (sessionStream && this.tokens.verify(url.searchParams.get('token'))?.kind === 'client') {
      return false;
    }
    if (this.dashboardCookieToken(request.headers.cookie) === null) return false;
    for (const protocol of protocols) {
      const proof = dashboardProofFromProtocol(protocol);
      if (proof !== null && this.tokens.acceptsDashboardProof(proof)) return protocol;
    }
    return false;
  }

  /**
   * Who may open `/sessions/<id>/stream`, or why not.
   *
   * A client token and a viewer cookie for this session keep the check they
   * already have: a missing Origin is allowed, and a foreign one is refused.
   * The dashboard cookie is a third way in, and only with the events
   * upgrade's rules: a live `sp-csrf` subprotocol, a matching Origin, and
   * same-origin Fetch Metadata. A header is not the proof. A viewer cookie,
   * including a read-only one, is never treated as the dashboard credential.
   * When both are present and the proof is live, the dashboard cookie is the
   * one that opens the socket, so a read-only viewer cookie in the same jar
   * does not mask it. When the proof is missing, a viewer cookie for this
   * session still opens the socket on its own rules.
   */
  private sessionStreamDecision(
    req: http.IncomingMessage,
    url: URL,
    sessionId: string,
  ):
    | { ok: true; credential: { kind: 'client' | 'viewer' | 'dashboard'; readOnly: boolean } }
    | { ok: false; code: number; reason: string; audit: string | null } {
    const client = this.tokens.verify(url.searchParams.get('token'));
    if (client?.kind === 'client') {
      if (!this.originAllowed(req.headers.origin)) {
        return { ok: false, code: 403, reason: 'Forbidden', audit: null };
      }
      return { ok: true, credential: { kind: 'client', readOnly: false } };
    }

    const dashboard = this.dashboardUpgradeRefusal(req);
    if (dashboard === null) {
      return { ok: true, credential: { kind: 'dashboard', readOnly: false } };
    }

    const viewer = cookieValues(req.headers.cookie, VIEWER_COOKIE)
      .map((value) => this.tokens.verifyStreamToken(value))
      .find((found) => found?.kind === 'viewer' && found.sessionId === sessionId);
    if (viewer?.kind === 'viewer') {
      if (!this.originAllowed(req.headers.origin)) {
        return { ok: false, code: 403, reason: 'Forbidden', audit: null };
      }
      return { ok: true, credential: { kind: 'viewer', readOnly: viewer.readOnly } };
    }

    // The dashboard cookie was offered and did not authenticate. Say why,
    // including a planted value. A stream with no dashboard cookie and no
    // other credential is the ordinary 401, and it is not a dashboard refusal.
    if (this.dashboardCookiePresented(req.headers.cookie)) {
      return { ok: false, code: dashboard.code, reason: dashboard.reason, audit: dashboard.audit };
    }
    return { ok: false, code: 401, reason: 'Unauthorized', audit: null };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // DNS-rebinding defence (design §4.2): a browser on any website can make
    // requests reach a loopback port; the Host header gives the rebind away.
    if (!this.hostAllowed(req.headers.host)) {
      if (pathOnly(req.url).startsWith('/dashboard')) this.auditDashboardRefusal(req, 'host');
      json(res, 403, { error: 'Forbidden: unexpected Host header.' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(this.portValue ?? 0)}`);
    const segments = url.pathname.split('/').filter((s) => s !== '');

    // Unauthenticated by design (§4.1): clients must be able to poll before
    // the token file settles, and it reveals nothing sensitive.
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, version: this.version, pid: process.pid });
      return;
    }

    // The viewer page itself is served without auth, and must stay that way:
    // refusing it would tell an unauthenticated caller which session ids
    // exist. The page holds no secrets either.
    //
    // What DOES happen here is the one-use exchange (§4.1): a `vt` in the
    // query is redeemed, once, for a stream credential delivered as an
    // HttpOnly cookie. After this the URL is inert, the page's own scripts
    // never see a credential and the browser attaches the cookie to the
    // WebSocket upgrade by itself. An absent, stale or already-redeemed grant
    // is NOT an error here: the page loads and then reports that it could not
    // connect, which keeps this route's silence about session ids intact.
    if (req.method === 'GET' && segments[0] === 'view') {
      const headers: Record<string, string | string[]> = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // `style-src 'unsafe-inline'` is required: xterm.js sizes
        // rows, the cursor and its character-measurement element with inline
        // styles, and a real browser reported ten CSP violations per load
        // without it. Scripts stay strict under `default-src 'self'`: inline
        // styles cannot execute code, and terminal output never reaches the
        // DOM as markup (xterm renders it as text).
        'content-security-policy': PAGE_CSP,
      };
      const redeemed = this.tokens.redeemViewerGrant(url.searchParams.get('vt'));
      if (redeemed !== null) {
        headers['set-cookie'] = viewerCookie(redeemed.sessionId, redeemed.streamToken);
        this.audit.record('viewer', 'grant-redeem', redeemed.sessionId, {
          readOnly: redeemed.readOnly,
        });
        // The grant says which session this is for; `s=` is only how the page
        // learns it. A link whose `s=` had been edited would otherwise spend
        // its grant on a page that then asks for the wrong stream.
        if (url.searchParams.get('s') !== redeemed.sessionId) {
          headers['location'] = `/view?s=${encodeURIComponent(redeemed.sessionId)}`;
          res.writeHead(302, headers);
          res.end();
          return;
        }
      }
      res.writeHead(200, headers);
      res.end(fs.readFileSync(viewerHtmlPath));
      return;
    }

    // Browsers request this unprompted, before any <link rel="icon"> is parsed,
    // and a Chrome --app window asks for it when it builds the taskbar
    // button. Serving the real mark here is what stops that button falling
    // back to the generic globe.
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(viewerDir, 'icon-32.png')));
      return;
    }
    if (req.method === 'GET') {
      const asset = STATIC_ASSETS[url.pathname];
      if (asset !== undefined) {
        res.writeHead(200, {
          // charset belongs on text only: `image/png; charset=utf-8` is
          // meaningless, and stating an encoding for binary invites a proxy or
          // a browser to treat the bytes as text.
          'content-type': asset.binary === true ? asset.type : `${asset.type}; charset=utf-8`,
          'cache-control': 'no-store',
        });
        res.end(fs.readFileSync(asset.file));
        return;
      }
    }

    // The dashboard page is served without a client token. A live grant is
    // redeemed only on an accepted document navigation. Anything else gets
    // the page with no cookie and no proof, unless Fetch Metadata forbids it.
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/dashboard') {
      this.handleDashboardPage(req, res, url);
      return;
    }

    // The two launch routes are dashboard-cookie routes. They are checked
    // before the client token so a bearer token cannot take the profile list
    // or the launch path as an ordinary API call.
    if (req.method === 'GET' && url.pathname === '/dashboard/profiles') {
      this.serveDashboardProfiles(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/dashboard/launch') {
      await this.handleDashboardLaunch(req, res);
      return;
    }

    const auth = this.tokens.verify(bearerToken(req.headers.authorization));
    if (auth === null || auth.kind !== 'client') {
      // `GET /sessions` is the HTTP read the dashboard cookie may make.
      // `DELETE /sessions/<id>` is the kill: the same origin, Fetch Metadata
      // and document proof as launch. A bearer token, handled above, does
      // not reach this branch, so a client-token kill keeps its own actor.
      if (req.method === 'GET' && segments.length === 1 && segments[0] === 'sessions') {
        this.serveDashboardSessionList(req, res, url);
        return;
      }
      if (req.method === 'DELETE' && segments.length === 2 && segments[0] === 'sessions') {
        await this.handleDashboardKill(req, res, segments[1] ?? '');
        return;
      }
      // A dashboard cookie on any other route, and any other dashboard path,
      // is a refusal. An ordinary missing client token is not: that 401 is
      // what every unauthenticated API call already gets.
      if (
        this.dashboardCookiePresented(req.headers.cookie) ||
        url.pathname.startsWith('/dashboard')
      ) {
        this.auditDashboardRefusal(req, 'unauthenticated');
      }
      json(res, 401, { error: 'Unauthorised: a valid client token is required.' });
      return;
    }
    this.lastActivity = Date.now();

    // Audit actor (design §4.5): adapters self-identify via a header, the MCP
    // adapter as `mcp:<clientInfo.name>` and the CLI as `cli`. Untrusted input,
    // so sanitise; it labels log lines and nothing else.
    const actorHeader = req.headers['x-shellpuppet-actor'];
    const actor =
      (typeof actorHeader === 'string'
        ? // eslint-disable-next-line no-control-regex
          actorHeader.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64)
        : '') || 'client';

    try {
      if (segments[0] === 'daemon' && segments[1] === 'shutdown' && req.method === 'POST') {
        const body = await readBody(req);
        const force = asBoolean(body['force']) ?? false;
        const live = this.manager.liveCount();
        if (live > 0 && !force) {
          json(res, 409, {
            error:
              `Refusing to stop: ${String(live)} live session(s). ` +
              `Pass force to kill them.`,
          });
          return;
        }
        this.audit.record(actor, 'shutdown', undefined, { force, liveSessions: live });
        json(res, 200, { ok: true, stopping: true });
        void this.stop().then(() => {
          this.options.onSelfStop?.('shutdown-request');
        });
        return;
      }

      // Behind the token, unlike /health: names of credential-shaped
      // variables are not for anyone who can reach the port.
      if (req.method === 'GET' && segments.length === 1 && segments[0] === 'environment') {
        json(res, 200, this.environmentReport());
        return;
      }

      if (req.method === 'POST' && segments[0] === 'dashboard' && segments[1] === 'open' && segments.length === 2) {
        await this.handleDashboardOpen(req, res, actor);
        return;
      }

      if (segments[0] !== 'sessions') {
        json(res, 404, { error: 'Not found.', path: url.pathname });
        return;
      }

      if (req.method === 'GET' && segments.length === 1) {
        this.writeSessionList(res, url);
        return;
      }

      if (req.method === 'POST' && segments.length === 1) {
        await this.handleStart(req, res, actor);
        return;
      }

      const id = segments[1] ?? '';
      const session = this.manager.get(id);
      if (session === undefined) {
        json(res, 404, { error: `No such session: ${id}` });
        return;
      }

      if (req.method === 'DELETE' && segments.length === 2) {
        this.audit.record(actor, 'kill', id);
        await this.manager.kill(id);
        this.dropSessionArtifacts(id);
        json(res, 200, { ok: true, killed: id });
        return;
      }

      const action = segments[2];

      // A fresh viewer link (§4.1). Grants are one-use and short-lived, so
      // there has to be a way to get another without restarting the session:
      // the human closed the window, the link expired unopened or a second
      // device wants its own. Client token only: a viewer cannot mint itself
      // a new credential, let alone a wider one.
      if (req.method === 'POST' && action === 'viewer') {
        const body = await readBody(req);
        const readOnly = body['readOnly'] === true;
        const grant = this.tokens.mintViewerGrant(id, { readOnly });
        this.audit.record(actor, 'grant-mint', id, { readOnly });
        json(res, 200, {
          viewerUrl: this.viewerUrlFor(id, grant),
          readOnly,
          expiresInMs: VIEWER_GRANT_TTL_MS,
        });
        return;
      }

      // A picture of the viewer, as a browser draws it (§5). The daemon's
      // text snapshot is what the agent reads; this is what the human sees,
      // and the two can disagree in ways no text-level check can catch.
      // Also the faithful way to illustrate documentation.
      if (req.method === 'POST' && action === 'screenshot') {
        const body = await readBody(req);
        if (body['hideReasoning'] !== undefined && typeof body['hideReasoning'] !== 'boolean') {
          json(res, 400, { error: BAD_HIDE_REASONING });
          return;
        }
        const hide = body['hideReasoning'] === true;
        const signature = hide ? this.readerFor(session, res) : null;
        if (hide && signature === null) return;
        // Absent means the default; present and not a number is a mistake to
        // report, not to paper over with the default.
        const width = body['width'] === undefined ? CAPTURE_WIDTH : asNumber(body['width']);
        const height = body['height'] === undefined ? CAPTURE_HEIGHT : asNumber(body['height']);
        if (
          width === undefined ||
          height === undefined ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 200 ||
          width > 4_000 ||
          height < 200 ||
          height > 4_000
        ) {
          json(res, 400, { error: 'width and height must be integers between 200 and 4000.' });
          return;
        }
        // A caller who knows its machine is slow, or wants to fail faster,
        // can say how long a capture may take, within these bounds.
        const timeoutMs =
          body['timeoutMs'] === undefined
            ? DEFAULT_CAPTURE_TIMEOUT_MS
            : asNumber(body['timeoutMs']);
        if (
          timeoutMs === undefined ||
          !Number.isInteger(timeoutMs) ||
          timeoutMs < MIN_CAPTURE_TIMEOUT_MS ||
          timeoutMs > MAX_CAPTURE_TIMEOUT_MS
        ) {
          json(res, 400, {
            error:
              `timeoutMs must be an integer between ${String(MIN_CAPTURE_TIMEOUT_MS)} and ` +
              `${String(MAX_CAPTURE_TIMEOUT_MS)}.`,
          });
          return;
        }
        const browser = await findBrowser(this.options.viewer?.browserPath, this.logger);
        if (browser === null) {
          // No silent fallback to re-rendering the cells ourselves: that would
          // return a picture of what the daemon thinks, labelled as what the
          // browser drew, which is exactly the disagreement this exists to find.
          json(res, 503, {
            error:
              'No Chromium-family browser found, so the viewer cannot be photographed. ' +
              'Install one, or set viewer.browserPath in config.json.',
          });
          return;
        }
        let redactedRows: Map<number, string> | undefined;
        let expectedRows: string[] | undefined;
        if (signature !== null) {
          const view = await session.styledScreen(REASONING_CONTEXT_LINES);
          const filtered = hideReasoning(view.lines, signature, view.firstVisible);
          if (filtered === null) {
            json(res, 400, { error: overBudgetMessage(signature) });
            return;
          }
          redactedRows = new Map<number, string>();
          const visibleRows = view.lines.length - view.firstVisible;
          expectedRows = view.lines.slice(view.firstVisible).map((line) => line.text.replace(/\s+$/, ''));
          while (expectedRows.length > 0 && expectedRows.at(-1) === '') expectedRows.pop();
          filtered.lines.forEach((line, index) => {
            if (!filtered.markers[index]) return;
            const from = filtered.rows[index]!;
            const to = filtered.rows[index + 1] ?? visibleRows;
            for (let row = from; row < to; row++) redactedRows!.set(row, row === from ? line : '');
          });
        }
        // Read-only, because a photograph must not be able to type into the
        // thing it is photographing.
        const grant = this.tokens.mintViewerGrant(id, { readOnly: true });
        try {
          const capture = await (this.options.capture ?? captureViewer)({
            browser,
            viewerUrl: this.viewerUrlFor(id, grant),
            width,
            height,
            timeoutMs,
            profileRoot: captureProfileRoot(this.options.home),
            ...(redactedRows === undefined ? {} : { hiddenRows: [...redactedRows.keys()] }),
            logger: this.logger,
          });
          if (expectedRows !== undefined && this.options.capture === undefined &&
              JSON.stringify(capture.rows) !== JSON.stringify(expectedRows)) {
            json(res, 409, { error: 'The screen changed before its filtered picture could be taken. Try again.' });
            return;
          }
          this.audit.record(actor, 'screenshot', id, { width, height });
          json(res, 200, {
            png: capture.png.toString('base64'),
            // The picture's own dimensions, read from it rather than the request.
            width: capture.width,
            height: capture.height,
            cols: session.cols,
            rows: session.rows,
            lines: redactedRows === undefined
              ? capture.rows
              : capture.rows.map((line, row) => redactedRows.get(row) ?? line),
          });
        } catch (error) {
          this.logger.warn('screenshot failed', { id, error: String(error) });
          json(res, 500, {
            error: `Could not photograph the viewer: ${String(error)}`,
          });
        } finally {
          // The photographer is gone, so its credential goes with it. A human's
          // viewer keeps theirs until the session ends, because a dropped socket
          // has to reconnect without a fresh link; a headless browser that has
          // already closed has nothing to reconnect. In a `finally` because a
          // capture that failed leaves the same credential behind as one that
          // worked.
          this.tokens.revokeViewerGrant(grant);
        }
        return;
      }

      if (req.method === 'GET' && action === 'snapshot') {
        const lastLinesParam = url.searchParams.get('lastLines');
        let count: number | undefined;
        if (lastLinesParam !== null) {
          count = Number(lastLinesParam);
          if (!Number.isInteger(count) || count < 1 || count > 10_000) {
            json(res, 400, { error: 'lastLines must be an integer between 1 and 10000.' });
            return;
          }
        }
        const hide = queryFlag(url, 'hideReasoning');
        if (hide === null) {
          json(res, 400, { error: BAD_HIDE_REASONING });
          return;
        }
        if (!hide) {
          const snapshot = await session.snapshot();
          json(res, 200, count === undefined ? snapshot : { ...snapshot, lastLines: await session.lastLines(count) });
          return;
        }
        // Fails closed: without a signature to read the screen by, nothing
        // is returned, never the screen unfiltered.
        const signature = this.readerFor(session, res);
        if (signature === null) return;
        const snapshot = await session.snapshot();
        const view = await session.styledScreen(REASONING_CONTEXT_LINES);
        const screen = hideReasoning(view.lines, signature, view.firstVisible);
        let tail: ReturnType<typeof hideReasoning> | undefined;
        if (count !== undefined) {
          const lines = await session.styledTail(count, REASONING_CONTEXT_LINES);
          tail = hideReasoning(lines.lines, signature, lines.firstVisible);
        }
        if (screen === null || tail === null) {
          json(res, 400, { error: overBudgetMessage(signature) });
          return;
        }
        json(res, 200, {
          ...snapshot,
          screen: screen.lines.join('\n'),
          cursor: filteredCursor(snapshot.cursor, screen),
          ...(tail !== undefined ? { lastLines: tail.lines } : {}),
          reasoning: {
            agent: signature.name,
            hiddenLines: screen.hiddenLines,
            hiddenBlocks: screen.hiddenBlocks,
            ...(tail !== undefined ? { lastLinesHiddenLines: tail.hiddenLines } : {}),
          },
        });
        return;
      }

      if (req.method === 'GET' && action === 'result') {
        const signature = this.readerFor(session, res);
        if (signature === null) return;
        const { lines } = await session.styledTail(RESULT_LINES);
        json(res, 200, {
          id: session.id,
          agent: signature.name,
          exited: session.exited,
          exitCode: session.exitCode,
          ...latestResult(lines, signature),
        });
        return;
      }

      // resize is refused alongside input/key once the session has ended. In
      // the moment before that, once node-pty has seen the program end,
      // `Session.resize` refuses it itself, and the route below answers that
      // with the same 409.
      if (
        (action === 'input' || action === 'key' || action === 'resize') &&
        session.exited
      ) {
        json(res, 409, { error: endedRefusal(id, session.exitCode) });
        return;
      }

      if (req.method === 'POST' && action === 'input') {
        const body = await readBody(req);
        const data = asString(body['data']);
        if (data === undefined) {
          json(res, 400, { error: 'data (string) is required.' });
          return;
        }
        // Awaited: long input is chunked (Session.write), so verify below must
        // not read the screen until every chunk has actually been written.
        // The write resolves with the screen as it was just before this input
        // went in, which verify compares with, so what was already on screen
        // cannot make up the typed text's wrapped pieces.
        //
        // The exit guard above is not enough on its own: a chunked write spans
        // real time, so the session can die between the guard and the last
        // chunk. That is the same "you are writing to a dead session" condition
        // the guard reports, so it gets the same 409. A 500 would blame the
        // caller's request for a race in the session's lifetime. A session
        // whose input pipe has failed refuses the write too, and its error
        // says what to do.
        let before: string;
        try {
          before = await session.write(data);
        } catch (error) {
          json(res, 409, {
            error:
              error instanceof SessionInputFailedError
                ? error.message
                : `Session ${id} exited while the input was being written: ${String(error)}`,
          });
          return;
        }
        // §4.5: content NEVER logged by default, only the length. Keystrokes
        // are where the secrets are.
        this.audit.record(actor, 'input', id, {
          chars: data.length,
          ...(this.audit.captureContent ? { data } : {}),
        });
        this.broadcastControl(id, { type: 'input-source', source: 'agent' });
        // §3.1: TUIs silently swallow input while loading or when a panel has
        // stolen focus. verify re-reads the screen and reports whether the
        // text landed (best effort: hidden-input prompts and heavy
        // transforms legitimately fail it; `escape` is the focus reset).
        if (asBoolean(body['verify']) === true) {
          json(res, 200, {
            ok: true,
            bytes: data.length,
            verified: await this.verifyTyped(session, data, before),
          });
          return;
        }
        json(res, 200, { ok: true, bytes: data.length });
        return;
      }

      if (req.method === 'POST' && action === 'key') {
        const body = await readBody(req);
        const key = asString(body['key']);
        const bytes = key === undefined ? null : keyToBytes(key);
        if (key === undefined || bytes === null) {
          json(res, 400, {
            error: `Unknown key: ${key ?? '(missing)'}. Known keys: ${knownKeys().join(', ')}`,
          });
          return;
        }
        // Same exit race and failed input pipe as the input endpoint above:
        // 409, not 500.
        try {
          await session.write(bytes);
        } catch (error) {
          json(res, 409, {
            error:
              error instanceof SessionInputFailedError
                ? error.message
                : `Session ${id} exited while the key was being written: ${String(error)}`,
          });
          return;
        }
        this.audit.record(actor, 'key', id, { key });
        this.broadcastControl(id, { type: 'input-source', source: 'agent' });
        json(res, 200, { ok: true, key });
        return;
      }

      if (req.method === 'GET' && action === 'wait') {
        // Checked before waiting, so a wait that could only end refused is
        // refused at once.
        const hide = queryFlag(url, 'hideReasoning');
        if (hide === null) {
          json(res, 400, { error: BAD_HIDE_REASONING });
          return;
        }
        const reader = hide ? this.readerFor(session, res) : null;
        if (hide && reader === null) return;
        const condition: WaitCondition = {};
        const text = url.searchParams.get('text');
        const regex = url.searchParams.get('regex');
        const quiet = url.searchParams.get('quiet');
        const prompt = url.searchParams.get('prompt');
        if (text !== null) condition.text = text;
        if (regex !== null) condition.regex = regex;
        if (quiet !== null) condition.quiet = Number(quiet);
        // Presence alone is not enough: `?prompt=false` must not silently
        // become a prompt wait, and the waiter's exactly-one check counts
        // `prompt === true` only.
        if (prompt !== null) condition.prompt = prompt !== 'false' && prompt !== '0';
        const timeoutParam = url.searchParams.get('timeout');
        const debounceParam = url.searchParams.get('debounce');
        const afterInputParam = url.searchParams.get('matchAfterInput');
        // A wait ends with its caller. A response that closes before it has
        // been written means the client gave up or its process died, so the
        // wait is aborted rather than left to poll to its full timeout for an
        // answer nobody would read. A response that completed normally has
        // already cleared this.
        const abort = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) abort.abort();
        };
        res.on('close', onClose);
        this.waitsInFlight += 1;
        let result;
        try {
          result = await session.waitFor(condition, {
            ...(timeoutParam !== null ? { timeout: Number(timeoutParam) } : {}),
            ...(debounceParam !== null ? { debounce: Number(debounceParam) } : {}),
            // Same parse as `prompt` above: `false`/`0` mean false, anything
            // else present means true.
            ...(afterInputParam !== null
              ? { matchAfterInput: afterInputParam !== 'false' && afterInputParam !== '0' }
              : {}),
            signal: abort.signal,
          });
        } finally {
          this.waitsInFlight -= 1;
          res.off('close', onClose);
        }
        // Nobody to answer, and writing to a closed response throws.
        if (abort.signal.aborted) return;
        if (reader !== null) {
          // The screen as it stands now, a moment after the wait resolved,
          // with the reasoning left out.
          const view = await session.styledScreen(REASONING_CONTEXT_LINES);
          const filtered = hideReasoning(view.lines, reader, view.firstVisible);
          if (filtered === null) {
            json(res, 400, { error: overBudgetMessage(reader) });
            return;
          }
          const visiblePrompt = result.prompt === undefined
            ? null
            : detectPrompt(filtered.lines.join('\n'));
          const prompt = visiblePrompt !== null && visiblePrompt.signature === result.prompt?.signature
            ? {
                question: visiblePrompt.question,
                options: visiblePrompt.options,
                signature: visiblePrompt.signature,
              }
            : undefined;
          json(res, 200, {
            ...result,
            screen: filtered.lines.join('\n'),
            ...(result.prompt === undefined ? {} : { prompt }),
            reasoning: { agent: reader.name, hiddenLines: filtered.hiddenLines, hiddenBlocks: filtered.hiddenBlocks },
            id: session.id,
            exited: session.exited,
            exitCode: session.exitCode,
          });
          return;
        }
        json(res, 200, {
          ...result,
          id: session.id,
          exited: session.exited,
          exitCode: session.exitCode,
        });
        return;
      }

      if (req.method === 'GET' && action === 'find') {
        const pattern = url.searchParams.get('pattern');
        if (pattern === null || pattern === '') {
          json(res, 400, { error: 'pattern is required.' });
          return;
        }
        try {
          const hide = queryFlag(url, 'hideReasoning');
          if (hide === null) {
            json(res, 400, { error: BAD_HIDE_REASONING });
            return;
          }
          if (!hide) {
            const result = findOnScreen(await session.viewportLines(), pattern);
            json(res, 200, { id: session.id, pattern, ...result });
            return;
          }
          const signature = this.readerFor(session, res);
          if (signature === null) return;
          const view = await session.styledScreen(REASONING_CONTEXT_LINES);
          const filtered = hideReasoning(view.lines, signature, view.firstVisible);
          if (filtered === null) {
            json(res, 400, { error: overBudgetMessage(signature) });
            return;
          }
          // Only the kept rows are searched, each reported by the screen's
          // own row number, so a hidden row can neither match nor count
          // towards the cap on matches.
          const keptRows: number[] = [];
          const keptText: string[] = [];
          filtered.lines.forEach((text, k) => {
            if (filtered.markers[k]) return;
            keptRows.push(filtered.rows[k]!);
            keptText.push(text);
          });
          const result = findOnScreen(keptText, pattern);
          json(res, 200, {
            id: session.id,
            pattern,
            matches: result.matches.map((match) => ({ ...match, line: keptRows[match.line - 1]! + 1 })),
            truncated: result.truncated,
            reasoning: { agent: signature.name, hiddenLines: filtered.hiddenLines },
          });
        } catch (error) {
          // A pattern that will not finish is a different mistake from one
          // that will not compile, and the caller can only fix the one it is
          // told about.
          json(res, 400, {
            error:
              error instanceof RegexBudgetError
                ? error.message
                : `Invalid pattern: ${pattern}`,
          });
        }
        return;
      }

      if (req.method === 'POST' && action === 'resize') {
        const body = await readBody(req);
        const cols = asNumber(body['cols']);
        const rows = asNumber(body['rows']);
        if (cols === undefined || rows === undefined || gridOutOfBounds(cols, rows)) {
          json(res, 400, { error: GRID_BOUNDS_ERROR });
          return;
        }
        const hold = body['hold'] === true;
        try {
          session.resize(cols, rows, { hold });
        } catch (error) {
          if (!(error instanceof SessionProgramEndedError)) throw error;
          json(res, 409, { error: endedRefusal(id, error.exitCode) });
          return;
        }
        this.audit.record(actor, 'resize', id, { cols, rows, hold });
        // An API resize takes the grid away from whichever viewport had it, so
        // nobody is left believing they still drive it. It does NOT hold
        // unless asked: a human whose window is now the wrong shape gets it
        // back by moving that window, which is the only escape they have while
        // there is no takeover control to press (§5).
        this.geometryController.delete(id);
        this.announceGeometry(id, session);
        json(res, 200, { ok: true, cols, rows, geometryHeld: session.geometryHeld });
        return;
      }

      json(res, 404, { error: 'Not found.', path: url.pathname });
    } catch (error) {
      if (error instanceof WaitConditionError) {
        json(res, 400, { error: error.message });
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        json(res, 413, { error: error.message });
        return;
      }
      if (error instanceof Error && error.message.startsWith('Request body')) {
        json(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
  }

  private async handleStart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    actor: string,
  ): Promise<void> {
    const body = await readBody(req);
    const command = asString(body['command']);
    if (command === undefined || command === '') {
      json(res, 400, { error: 'command (string) is required.' });
      return;
    }
    const shapeError = startShapeError(body);
    if (shapeError !== null) {
      json(res, 400, { error: shapeError });
      return;
    }
    if (gridOutOfBounds(asNumber(body['cols']), asNumber(body['rows']))) {
      json(res, 400, { error: GRID_BOUNDS_ERROR });
      return;
    }
    const agent = asString(body['agent']);
    if (agent !== undefined && !agentNames().includes(agent)) {
      json(res, 400, {
        error:
          `agent must be one of: ${agentNames().join(', ')}. Config agents.signatures can ` +
          'describe another.',
      });
      return;
    }
    // A session starts in the user's home directory unless the caller names a
    // folder, and a relative one is taken from there. Never the daemon's own
    // working directory: that is wherever the daemon happened to be started,
    // and the ShellPuppet home would put a program beside daemon.json and its
    // token. The CLI and the MCP server send their own working directory, so
    // this default is for a direct caller of the API.
    const cwd = path.resolve(os.homedir(), asString(body['cwd']) ?? '.');
    // A working directory that is not one is a caller mistake, reported as
    // one here rather than left to fail deep inside ConPTY as "Cannot create
    // process, error code: 267", which gives the caller nothing to act on.
    let isDirectory: boolean;
    try {
      isDirectory = fs.statSync(cwd).isDirectory();
    } catch {
      json(res, 400, { error: `cwd does not exist: ${cwd}` });
      return;
    }
    if (!isDirectory) {
      json(res, 400, { error: `cwd is not a directory: ${cwd}` });
      return;
    }
    const options = {
      command,
      ...(asStringArray(body['args']) !== undefined ? { args: asStringArray(body['args']) } : {}),
      cwd,
      ...(asNumber(body['cols']) !== undefined ? { cols: asNumber(body['cols']) } : {}),
      ...(asNumber(body['rows']) !== undefined ? { rows: asNumber(body['rows']) } : {}),
      ...(body['hold'] === true ? { hold: true } : {}),
      ...(asString(body['label']) !== undefined ? { label: asString(body['label']) } : {}),
      ...(asString(body['purpose']) !== undefined ? { purpose: asString(body['purpose']) } : {}),
      ...(agent !== undefined ? { agent } : {}),
      // From the request's audit identity rather than the body, so it cannot
      // diverge from the audit trail. Self-declared, not authenticated: see
      // SessionOptions.startedBy.
      startedBy: actor,
      ...(asString(body['readyText']) !== undefined
        ? { readyText: asString(body['readyText']) }
        : {}),
      ...(asNumber(body['readyQuiet']) !== undefined
        ? { readyQuiet: asNumber(body['readyQuiet']) }
        : {}),
      ...(asBoolean(body['shell']) !== undefined ? { shell: asBoolean(body['shell']) } : {}),
      // Shape-checked above: names to string values.
      ...(body['env'] !== undefined ? { env: body['env'] as Record<string, string> } : {}),
    };
    const envNames = Object.keys(options.env ?? {});

    let session: Session;
    try {
      session = this.manager.create(options);
    } catch (error) {
      if (error instanceof PolicyViolationError) {
        json(res, 403, { error: error.message });
        return;
      }
      if (error instanceof CommandNotFoundError) {
        json(res, 400, { error: error.message });
        return;
      }
      this.logger.error('session start failed', {
        error: error instanceof Error ? (error.stack ?? String(error)) : String(error),
      });
      // The install cannot open a terminal at all. The message says what to
      // do, so it goes out as written.
      if (error instanceof NativePtyUnavailableError) {
        json(res, 500, { error: error.message });
        return;
      }
      json(res, 500, { error: `Failed to start session: ${String(error)}` });
      return;
    }

    // Registration is synchronous with creation, before any asynchronous
    // viewer launch or readiness work can publish a change for this id.
    this.sessionFeed.add(this.summaryWithPrompt(session.summary()));
    session.onExit(() => {
      this.clearPromptGraceCheck(session.id);
      this.promptStates.delete(session.id);
      this.updateFeedSession(session.id);
    });
    session.onReady(() => this.updateFeedSession(session.id));

    // Commands are policy-visible by definition, so the command line IS
    // audited (§4.5), unlike typed content. Passed variables are audited by
    // name only, whatever `audit.captureContent` says: a value is a secret
    // the caller handed over, not something anyone typed.
    this.audit.record(actor, 'start', session.id, {
      command: options.command,
      args: options.args ?? [],
      ...(envNames.length > 0 ? { envNames } : {}),
      ...(agent !== undefined ? { agent } : {}),
      label: session.label,
    });

    // The human's way in (design §3.1): a viewer window the daemon opens for
    // them or, when nothing opened, a viewer URL the caller hands them. Either
    // carries a one-use viewer grant, never the client token (§4.1).
    // The session id goes in the QUERY, not the path, and that is load-bearing
    // on Windows. Chrome derives an `--app` window's AppUserModelID from
    // host + PATH only, and Windows groups taskbar buttons
    // by AppUserModelID. A per-session path would give every viewer its own
    // taskbar icon; a constant path puts them all under ONE icon whose hover
    // list is the open sessions, which is how a human with five agent CLIs
    // running actually navigates. Measured:
    //   /view/s1  -> Chrome.127.0.0.1_/view/s1.…   (separate buttons)
    //   /view?s=s1 -> Chrome.127.0.0.1_/view.…     (one button, five windows)
    // `/view/<id>` serves the same page.
    // A start that asks for no window (the CLI's `--no-viewer`, for a short
    // scripted session nobody needs to watch) mints no grant and opens
    // nothing; the session is listed as any other, and `viewer-url` gives a
    // link to it whenever someone asks.
    const wantsViewer = body['openViewer'] !== false;
    // A connected dashboard is the human's window. Do not mint a viewer grant
    // that would sit unused, and do not open a second window.
    const dashboardWatching = wantsViewer && this.dashboardEventSockets.size > 0;
    const viewerUrl =
      wantsViewer && !dashboardWatching
        ? this.viewerUrlFor(session.id, this.tokens.mintViewerGrant(session.id))
        : '';

    // Open the window for the human, and wait to hear whether anything
    // opened: the launcher only spawns, detached, so the wait costs the start
    // milliseconds, and the answer decides what the caller is told. A browser
    // that will not start must never fail a session start, the one path every
    // delegate depends on, so the launcher is built not to throw, and a
    // failure here is logged and counts as "nothing opened".
    const launch = this.options.launcher ?? launchViewer;
    let opened: ViewerLaunchResult;
    if (dashboardWatching) {
      opened = { launched: false, mode: 'none', reason: 'a dashboard is connected' };
    } else if (!wantsViewer) {
      opened = { launched: false, mode: 'none', reason: 'not requested at start' };
    } else {
      try {
        opened = await launch(viewerUrl, this.options.home, this.options.viewer ?? {}, this.logger);
      } catch (error: unknown) {
        this.logger.warn('viewer launch failed', { id: session.id, error: String(error) });
        opened = {
          launched: false,
          mode: this.options.viewer?.launchMode ?? 'none',
          reason: String(error),
        };
      }
    }

    // One grant per start, and the window has it. A window that opened gives
    // the caller no link: a link nobody asked for would sit in a transcript as
    // a live capability until it expired (§4.1). When nothing opened, the
    // grant never reached a browser, so the same URL goes to the caller as the
    // human's way in, audited like any other link under the actor that asked
    // for the session. A window's use of its grant shows in the log as the
    // `grant-redeem` its page performs.
    const handOver = wantsViewer && !dashboardWatching && !opened.launched;
    if (handOver) this.audit.record(actor, 'grant-mint', session.id, { readOnly: false });

    json(res, 200, {
      id: session.id,
      label: session.label,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
      ready: session.ready,
      // Without the reason, `ready: true` is ambiguous: it may mean nothing
      // was checked. Callers need to tell those apart before they type.
      readyReason: session.readyReason,
      geometryHeld: session.geometryHeld,
      viewer: {
        opened: opened.launched,
        mode: opened.mode,
        ...(opened.reason !== undefined ? { reason: opened.reason } : {}),
      },
      ...(handOver ? { viewerUrl } : {}),
    });
  }

  /**
   * The signature that reads a session's screen for `hideReasoning` and
   * `terminal_result`. Without one, a 400 is sent and null returned: those
   * readers fail closed.
   */
  private readerFor(session: Session, res: http.ServerResponse): CompiledSignature | null {
    const signature = signatureFor(session.agent, session.command);
    if (signature !== null) return signature;
    const known = agentNames().join(', ');
    json(res, 400, {
      error:
        session.agent !== undefined
          ? `Session ${session.id} was started as agent "${session.agent}", whose signature is not ` +
            `available now (removed from config, or set aside for running past its time budget), ` +
            `so its screen is not read for hideReasoning or a result.`
          : `Session ${session.id} runs ${programName(session.command)}, which has no agent ` +
            `signature, so its screen is not returned with hideReasoning or read for a result. ` +
            `Start it with agent set to one of: ${known}. Read it without hideReasoning only if ` +
            `no agent's reasoning is on it.`,
    });
    return null;
  }

  /**
   * Poll for the typed text to appear on screen, for longer the longer the
   * text (VERIFY_MS_PER_CHAR). Matches on the last
   * printable run of the input (up to 40 chars) so a trailing Enter or an
   * embedded control sequence does not defeat the check. For input long
   * enough to be lost in pieces, it matches on the FIRST run as well (see the
   * needle comments below for the loss this exists to catch).
   *
   * Both needles must appear, read the way a TUI wraps typed text
   * (`screenShows`): a long prompt is redrawn across the rows of an input
   * box, and the line break, the continuation row's indent, the box's border
   * and any side panel drawn on the same rows land in the middle of the
   * needle. `before` is the screen as it was before the input: rows still the
   * same are not read as wrapped pieces of it.
   */
  private async verifyTyped(session: Session, typed: string, before: string): Promise<boolean> {
    // eslint-disable-next-line no-control-regex
    const printableRuns = typed.split(/[\x00-\x1f\x7f]+/).filter((s) => s.length > 0);

    // Check the HEAD as well as the tail, and only for input long enough to be
    // lost in pieces. A long prompt can reach a TUI with its front missing and
    // its tail intact, so a tail-only check could not fail on the one loss
    // mode it needs to catch. A check that cannot fail is worse than no check:
    // it converts a silent problem into a confident wrong answer.
    const needles: string[] = [];
    const last = printableRuns[printableRuns.length - 1];
    if (last !== undefined) needles.push(last.slice(-40));
    const first = printableRuns[0];
    if (first !== undefined && typed.length > 200) needles.push(first.slice(0, 40));

    // A false report for text that arrived perfectly is not harmless: an agent
    // trusting it would retype and DUPLICATE its input, which is worse than
    // not checking at all.
    const visible = needles.filter((n) => n.trim() !== '');
    if (visible.length === 0) return true; // control/whitespace only: nothing to see

    const deadline =
      Date.now() + Math.min(VERIFY_BASE_MS + typed.length * VERIFY_MS_PER_CHAR, VERIFY_MAX_MS);
    for (;;) {
      const { screen } = await session.snapshot();
      if (visible.every((needle) => screenShows(screen, needle, before))) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Reap naturally-exited sessions once their grace lapses, releasing what a
   * kill releases: the renderer, the session's viewer grants and credentials, and its
   * watcher sockets, so an abandoned viewer tab cannot hold off idle shutdown.
   */
  private async sweepExited(): Promise<void> {
    const graceMs = this.options.exitedGraceMs ?? EXITED_SESSION_GRACE_MS;
    const reaped = await this.manager.reapExited(graceMs);
    for (const id of reaped) {
      this.audit.record('daemon', 'reap', id);
      this.dropSessionArtifacts(id);
    }
  }

  /** Revoke a removed session's viewer grants and credentials and close its watcher sockets. */
  private dropSessionArtifacts(id: string): void {
    this.tokens.revokeViewerTokens(id);
    for (const [ws, sync] of this.sessionSockets.get(id) ?? []) {
      sync.close();
      try {
        ws.close();
      } catch {
        // Best effort.
      }
    }
    this.sessionSockets.delete(id);
    this.geometryController.delete(id);
  }

  /** Whether a live viewport is currently driving this session's grid. */
  private hasGeometryController(sessionId: string): boolean {
    const controller = this.geometryController.get(sessionId);
    if (controller === undefined) return false;
    if (controller.readyState === controller.OPEN) return true;
    this.geometryController.delete(sessionId);
    return false;
  }

  // ---------------------------------------------------- prompt-stall alerts
  /**
   * Session list decorated with whatever prompt each session is holding. The
   * stall alert also goes to `daemon.log` and the `/events` socket, but an
   * agent reaches the daemon through request-and-answer tool calls or one-shot
   * CLI runs, so it can never hold that socket: `terminal_list` is how a
   * manager agent learns that its delegate is blocked, which is the whole
   * point of detecting it.
   *
   * Read from the scanner's own state rather than re-detecting here: one
   * source of truth means what the list reports and what the log announces
   * cannot disagree, and a list call stays cheap (no render per session).
   * The cost is staleness bounded by the scan interval: 5 s, immaterial
   * against prompts that sit for minutes.
   */
  private listWithPrompts(hideReasoning = false): (SessionSummary & {
    waitingOnPrompt?: { question?: string; options?: string[]; waitingMs: number; alerted: boolean };
  })[] {
    const now = Date.now();
    return this.manager.list().map((summary) => {
      const full = this.summaryWithPrompt(summary, now);
      const waiting = full.waitingOnPrompt;
      if (!hideReasoning || waiting === undefined) return full;
      return { ...full, waitingOnPrompt: { waitingMs: waiting.waitingMs, alerted: waiting.alerted } };
    });
  }

  private summaryWithPrompt(summary: SessionSummary, now = Date.now()): FeedSummary {
    const state = this.promptStates.get(summary.id);
    if (state === undefined) return summary;
    return {
      ...summary,
      waitingOnPrompt: {
        question: state.prompt.question,
        options: state.prompt.options,
        waitingMs: now - state.since,
        alerted: state.alerted,
      },
    };
  }

  private updateFeedSession(id: string): void {
    const session = this.manager.get(id);
    if (session !== undefined) this.sessionFeed.update(this.summaryWithPrompt(session.summary()));
  }

  private clearPromptGraceCheck(id: string): void {
    const timer = this.promptGraceTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.promptGraceTimers.delete(id);
  }

  private schedulePromptGraceCheck(id: string, delayMs: number): void {
    if (this.promptGraceTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.promptGraceTimers.delete(id);
      if (this.stopPromise !== null || !this.promptStates.has(id)) return;
      if (this.promptScanRunning) {
        this.schedulePromptGraceCheck(id, 25);
        return;
      }
      this.promptScanRunning = true;
      this.scanForPromptStalls()
        .catch((error: unknown) => {
          this.logger.warn('prompt grace check failed', { id, error: String(error) });
        })
        .finally(() => {
          this.promptScanRunning = false;
        });
    }, delayMs);
    timer.unref();
    this.promptGraceTimers.set(id, timer);
  }

  /**
   * Scan every live session's screen for a permission prompt and alert when
   * the SAME prompt has been waiting longer than the stall threshold, so an
   * unserviced prompt does not cost the delegate tens of idle minutes until
   * someone happens to snapshot the session.
   */
  private async scanForPromptStalls(): Promise<void> {
    const stallMs = this.options.promptStallMs ?? PROMPT_STALL_MS;
    const seen = new Set<string>();
    for (const summary of this.manager.list()) {
      const session = this.manager.get(summary.id);
      if (session === undefined || session.exited) continue;
      seen.add(session.id);

      let detected: DetectedPrompt | null;
      try {
        const snapshot = await session.snapshot();
        detected = detectPrompt(snapshot.screen);
      } catch (error) {
        // One session's render fault must not blind the scan for every
        // session after it in list order, so skip it and keep scanning; its
        // own prompt state, if any, waits for a healthier beat.
        this.logger.warn('prompt scan skipped a session', {
          id: session.id,
          error: String(error),
        });
        continue;
      }
      const previous = this.promptStates.get(session.id);

      if (detected === null) {
        // A snapshot may land midway through a repaint. Keep the prompt and
        // its clock for a short wall-clock grace period, independent of the
        // scan interval; a lasting disappearance still clears it.
        if (previous !== undefined) {
          if (previous.missingSince === null) previous.missingSince = Date.now();
          const remaining = previous.missingSince + PROMPT_REPAINT_GRACE_MS - Date.now();
          if (remaining > 0) {
            this.schedulePromptGraceCheck(session.id, remaining);
            continue;
          }
        }
        this.clearPromptGraceCheck(session.id);
        if (previous?.alerted === true) {
          this.emitEvent({
            type: 'prompt-clear',
            session: session.id,
            label: summary.label ?? null,
          });
          // Viewers were told the prompt was waiting; they must be told it is
          // over, or a badge raised by the stall alert never comes down.
          this.broadcastControl(session.id, { type: 'prompt-clear' });
        }
        if (previous !== undefined) {
          this.promptStates.delete(session.id);
          this.updateFeedSession(session.id);
        }
        continue;
      }
      // A real sighting cancels a pending repaint gap: the prompt is still there.
      // Refresh the stored prompt with it, too: the signature deliberately
      // normalises Grok's radio markers so that MOVING the selection does not
      // restart the stall clock, which means the same signature can describe a
      // visibly different set of options. Storing only on signature change
      // would serve a stale selection to `terminal_list` and to a viewer
      // joining late.
      const promptChanged = previous === undefined ||
        previous.prompt.question !== detected.question ||
        previous.prompt.options.length !== detected.options.length ||
        previous.prompt.options.some((option, index) => option !== detected.options[index]);
      if (previous !== undefined) {
        this.clearPromptGraceCheck(session.id);
        previous.missingSince = null;
        previous.prompt = detected;
      }

      // A dialog can redraw at another width, or alongside changing sidebar
      // text, without changing its question or choices. Its rendered signature
      // then changes although the person still faces the same decision.
      // A stable signature also covers focus markers moving among options.
      const sameContent = previous !== undefined && !promptChanged;
      if (previous === undefined || (previous.signature !== detected.signature && !sameContent)) {
        // A new (or changed) prompt starts its stall clock; it has not
        // alerted yet, so a prompt answered promptly stays silent.
        if (previous?.alerted === true) {
          // The previous prompt was announced and has now been replaced
          // rather than cleared. Retract it, otherwise a viewer badges the
          // old question while a different one is on screen.
          //
          // BOTH channels, symmetrically with the null path above. Retracting
          // to viewers only would leave `/events` emitting stall(Q1) then
          // stall(Q2) with no clear between them, which reads as two concurrent
          // holds or an unresolved first one. Nothing in this repository
          // subscribes to it, but the socket is a real API and an asymmetric
          // one is a trap for the first thing that consumes it.
          this.emitEvent({
            type: 'prompt-clear',
            session: session.id,
            label: summary.label ?? null,
          });
          this.broadcastControl(session.id, { type: 'prompt-clear' });
        }
        this.promptStates.set(session.id, {
          signature: detected.signature,
          since: Date.now(),
          alerted: false,
          prompt: detected,
          missingSince: null,
        });
        if (promptChanged || previous?.alerted === true) this.updateFeedSession(session.id);
        continue;
      }

      previous.signature = detected.signature;

      if (promptChanged) this.updateFeedSession(session.id);

      if (!previous.alerted && Date.now() - previous.since >= stallMs) {
        previous.alerted = true;
        this.updateFeedSession(session.id);
        const waitingMs = Date.now() - previous.since;
        this.audit.record('daemon', 'prompt-stall', session.id);
        this.logger.warn('session waiting on a prompt', {
          id: session.id,
          waitingMs,
          options: detected.options.length,
        });
        this.emitEvent({
          type: 'prompt-stall',
          session: session.id,
          label: summary.label ?? null,
          waitingMs,
          question: detected.question,
          options: detected.options,
        });
        // The session's own viewers get the same signal, so an open viewer
        // tab can badge itself without subscribing to the daemon stream.
        this.broadcastControl(session.id, {
          type: 'prompt-stall',
          waitingMs,
          question: detected.question,
          // The options travel to viewers as well as to /events, so the badge
          // can say what the choices are, not only THAT something is being
          // asked.
          options: detected.options,
        });
      }
    }

    // Sessions that exited or were reaped take their prompt state with them.
    for (const id of [...this.promptStates.keys()]) {
      if (!seen.has(id)) {
        this.clearPromptGraceCheck(id);
        this.promptStates.delete(id);
        this.updateFeedSession(id);
      }
    }
  }

  /** Fan an event out to every `/events` subscriber (TEXT JSON frames). */
  private emitEvent(event: Record<string, unknown>): void {
    const message = JSON.stringify({ ...event, at: new Date().toISOString() });
    for (const ws of this.eventSockets) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  }

  // ------------------------------------------------------------- websockets
  private handleUpgrade(
    req: http.IncomingMessage,
    socket: import('node:net').Socket,
    head: Buffer,
  ): void {
    // Node takes its own 'error' listener off the socket before it emits
    // 'upgrade', and ws adds one only inside its handleUpgrade, which a
    // refusal never reaches. An error with no listener would be an uncaught
    // exception, on which the daemon shuts down with every session.
    socket.on('error', () => socket.destroy());
    const reject = (code: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${String(code)} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (!this.hostAllowed(req.headers.host)) {
      if (pathOnly(req.url).startsWith('/dashboard')) this.auditDashboardRefusal(req, 'host');
      reject(403, 'Forbidden');
      return;
    }
    // A foreign Origin is refused before the target is parsed and before any
    // credential is read, on every upgrade (design §4.2). A missing Origin
    // stays allowed here: non-browser clients send none on `/events` and on a
    // session stream. `/dashboard/events` still requires a present Origin
    // whose host matches `Host`, with its other cookie rules, below.
    if (!this.originAllowed(req.headers.origin)) {
      if (pathOnly(req.url).startsWith('/dashboard')) this.auditDashboardRefusal(req, 'origin');
      reject(403, 'Forbidden');
      return;
    }

    // Parsed inside a guard, before anything is authenticated: Node's HTTP
    // parser accepts an unparsable request target (`GET http://[ HTTP/1.1`)
    // and hands it over verbatim, and no exception may escape the upgrade
    // event. Such a request is refused with a 400.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${String(this.portValue ?? 0)}`);
    } catch {
      reject(400, 'Bad Request');
      return;
    }
    const segments = url.pathname.split('/').filter((s) => s !== '');

    // The dashboard feed is cookie-only. Its Origin rule is stricter than the
    // client-token sockets below, which still allow a missing Origin.
    if (segments[0] === 'dashboard' && segments[1] === 'events' && segments.length === 2) {
      const refusal = this.dashboardUpgradeRefusal(req);
      if (refusal !== null) {
        this.auditDashboardRefusal(req, refusal.audit);
        reject(refusal.code, refusal.reason);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.attachDashboardSocket(ws);
      });
      return;
    }

    // Daemon-wide event stream: prompt-stall alerts and their clears, as TEXT
    // JSON frames. CLIENT token only: viewer credentials are session-scoped
    // and must not see other sessions' prompts. A foreign Origin was refused
    // above. A missing Origin stays allowed: non-browser clients send none.
    if (segments.length === 1 && segments[0] === 'events') {
      const auth = this.tokens.verify(url.searchParams.get('token'));
      if (auth === null || auth.kind !== 'client') {
        reject(401, 'Unauthorized');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.attachEventSocket(ws);
      });
      return;
    }

    if (segments[0] !== 'sessions' || segments[2] !== 'stream') {
      reject(404, 'Not Found');
      return;
    }
    const sessionId = segments[1] ?? '';

    // Auth BEFORE existence: session ids are sequential, and answering 404
    // to an unauthenticated prober would let it enumerate which ones exist,
    // the same leak the unauthenticated viewer route deliberately avoids.
    // A foreign Origin was already refused above, so that probe is a 403
    // and never a 401.
    // A viewer grant is not a way in (§4.1). A client token may ride the
    // query, because it is the same-user secret from `daemon.json` and never
    // travels in a URL a human sees. A browser presents the HttpOnly cookie
    // it was given when its grant was redeemed. The dashboard cookie is the
    // third way in, with the proof as the subprotocol and the events
    // upgrade's Origin rules, which are stricter than a viewer cookie's.
    const decision = this.sessionStreamDecision(req, url, sessionId);
    if (!decision.ok) {
      if (decision.audit !== null) this.auditDashboardRefusal(req, decision.audit);
      reject(decision.code, decision.reason);
      return;
    }

    const session = this.manager.get(sessionId);
    if (session === undefined) {
      reject(404, 'Not Found');
      return;
    }

    // `drive=0` opts a viewer or client socket out of taking the grid. A
    // dashboard credential is made passive in attachSocket, whatever the
    // query says, so this flag cannot turn that socket into a driver.
    const passive = passiveDrive(url);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Which credential opened the socket travels with it, so the audit log
      // names that credential rather than assuming a browser: `client` for
      // the client token on the query, `viewer` for a viewer cookie,
      // `dashboard` for the dashboard cookie.
      this.attachSocket(ws, session, decision.credential, { passive });
    });
  }

  /** Attach a subscriber to the daemon-wide event stream. */
  private attachEventSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    this.eventSockets.add(ws);
    this.lastActivity = Date.now();
    this.audit.record('client', 'events-connect', '-');
    ws.send(JSON.stringify({ type: 'hello', version: this.version }));
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.eventSockets.delete(ws);
      this.lastActivity = Date.now();
    });
    ws.on('error', () => {
      ws.close();
    });
    // The stream is outbound-only; inbound frames are ignored by design.
  }

  /**
   * Attach a subscriber to the dashboard session feed. Frames are the feed's
   * own: hello, a snapshot, then session deltas. Inbound frames are ignored.
   * The socket counts as connected so idle shutdown waits while the dashboard
   * is open.
   */
  private attachDashboardSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    this.dashboardEventSockets.add(ws);
    this.lastActivity = Date.now();
    const unsubscribe = this.subscribeDashboardFeed((frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    });
    ws.on('message', () => {
      // Outbound only. A frame is not a keystroke, a resize or a launch.
    });
    ws.on('close', () => {
      unsubscribe();
      this.sockets.delete(ws);
      this.dashboardEventSockets.delete(ws);
      this.lastActivity = Date.now();
    });
    ws.on('error', () => {
      ws.close();
    });
  }

  /** Send a JSON control message (TEXT frame) to every watcher of a session. */
  private broadcastControl(sessionId: string, control: Record<string, unknown>): void {
    const watchers = this.sessionSockets.get(sessionId);
    if (watchers === undefined) return;
    const message = JSON.stringify(control);
    for (const ws of watchers.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  }

  /**
   * Tell every watcher the current grid and who drives it, then hand each one
   * a snapshot at that size. Both halves matter: the frame moves their grid,
   * and the snapshot repaints it from the daemon's renderer rather than from
   * xterm's in-place reflow of what they had (§5).
   */
  private announceGeometry(
    sessionId: string,
    session: Session,
    options: { resync?: boolean } = {},
  ): void {
    for (const [ws, sync] of this.sessionSockets.get(sessionId) ?? []) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(this.geometryFrame(session, ws)));
      }
      if (options.resync !== false) sync.resync();
    }
    this.updateFeedSession(sessionId);
  }

  /** What one watcher is told about the grid, from its own point of view. */
  private geometryFrame(session: Session, ws: WebSocket): Record<string, unknown> {
    return {
      type: 'geometry',
      cols: session.cols,
      rows: session.rows,
      // The most a viewport may ask for (§5), with every frame: a page whose
      // window wants more can then size its text for the grid it will be
      // given, rather than proposing one it never will be.
      max: { cols: MAX_VIEWPORT_COLS, rows: MAX_VIEWPORT_ROWS },
      control: session.geometryHeld
        ? 'held'
        : this.geometryController.get(session.id) === ws
          ? 'yours'
          : 'adopt',
    };
  }

  /** The viewer URL for a session, carrying a one-use grant. */
  private viewerUrlFor(sessionId: string, grant: string): string {
    return (
      `http://127.0.0.1:${String(this.port)}/view` +
      `?s=${encodeURIComponent(sessionId)}&vt=${grant}`
    );
  }

  /** The daemon's rendered state as viewer bytes: a wipe, then the rebuild. */
  private async snapshotForViewer(session: Session): Promise<string> {
    try {
      const state = await session.viewerState({
        scrollback: VIEWER_SNAPSHOT_SCROLLBACK_LINES,
      });
      return VIEWER_WIPE + state;
    } catch (error) {
      // The gate releases live bytes anyway; the viewer just misses this repaint.
      this.logger.warn('viewer snapshot failed', { id: session.id, error: String(error) });
      throw error;
    }
  }

  /**
   * Wire protocol: BINARY frames carry terminal bytes (snapshots, live mirror,
   * exit notice); TEXT frames are JSON control messages. Incoming text frames
   * are either JSON controls (resize) or bytes for the program: a person's
   * keystrokes, or the viewer's terminal answering the program
   * (terminalReports.ts).
   */
  private attachSocket(
    ws: WebSocket,
    session: Session,
    credential: { kind: 'client' | 'viewer' | 'dashboard'; readOnly: boolean },
    options: { passive?: boolean } = {},
  ): void {
    const { readOnly } = credential;
    // A dashboard credential is always passive, whatever the query says.
    // Connecting does not make it the controller, and a resize is ignored
    // unless the frame says `take`. `drive=0` is that same opt-out for a
    // viewer or client socket. The query cannot turn a dashboard socket
    // into a driver.
    const passive = credential.kind === 'dashboard' || options.passive === true;
    // The audit actor is the credential that opened this socket, not the
    // route: `viewer` means the socket presented a viewer cookie (what a
    // viewer link's grant becomes when it is opened), `client` means the
    // same-user client token rode the query, and `dashboard` means the
    // dashboard cookie did. The actor names the credential, not the person
    // or program behind it.
    const actor = credential.kind;
    this.sockets.add(ws);
    let watchers = this.sessionSockets.get(session.id);
    if (watchers === undefined) {
      watchers = new Map();
      this.sessionSockets.set(session.id, watchers);
    }
    const sync = new ViewerSync(
      (bytes) => {
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(bytes, 'utf8'));
      },
      () => this.snapshotForViewer(session),
    );
    watchers.set(ws, sync);
    this.lastActivity = Date.now();
    this.audit.record(actor, 'ws-connect', session.id);

    // Who this session belongs to and what it is for. Sent before anything
    // else so the window is identifiable the instant it paints: with several
    // viewer windows open, an unlabelled one is indistinguishable from the
    // rest until you read its terminal content and infer.
    ws.send(
      JSON.stringify({
        type: 'identity',
        session: session.id,
        label: session.label,
        purpose: session.purpose,
        startedBy: session.startedBy,
        command: commandLine(session.command, session.args),
        // The page reflects this rather than deciding it: its own toggle is a
        // convenience, this is the daemon's answer (§4.1).
        readOnly,
        // A session stays reachable for fifteen minutes after its process
        // exits, and a viewer joining in that window is told so at once,
        // rather than shown a terminal that looks alive.
        exited: session.exited,
        exitCode: session.exitCode,
        // Likewise a session whose input has failed, before the viewer types.
        inputFailed: session.inputFailed,
      }),
    );

    // Settle geometry from the SERVER on connect, before the viewer decides
    // anything for itself. A viewer that fitted on open would resize the PTY
    // before it could learn whether it was entitled to. The frame below says
    // which of the three positions this viewer is in, so the choice is made
    // knowing the answer rather than raced against it.
    //
    // This MUST precede the snapshot below: the viewer writes snapshot bytes
    // into whatever grid it currently has, so sizing it afterwards reflows
    // content that was already laid out at the wrong width.
    //
    // Nobody driving, and free to be driven: this viewport picks it up, and
    // will propose a grid that fills its window. A read-only credential never
    // drives, because choosing the grid is a write. A dashboard credential
    // never picks it up by connecting, whatever the query says, and neither
    // does a `drive=0` socket. Neither inherits a controller that has left:
    // this is the only place a socket becomes the controller without sending
    // `take`.
    if (
      !session.geometryHeld &&
      !readOnly &&
      !passive &&
      !this.hasGeometryController(session.id)
    ) {
      this.geometryController.set(session.id, ws);
    }
    ws.send(JSON.stringify(this.geometryFrame(session, ws)));

    // What the daemon renders, as the bytes that rebuild it (design §5). Not
    // a slice of the raw stream: a slice starts mid-frame, and a program that
    // only repaints what changed never puts the rest of its frame back. Every
    // agent CLI repaints that way once its chrome is up, and on Windows every
    // program does as ConPTY relays it. Live bytes queue behind the
    // snapshot in the gate.
    sync.resync();

    // Whoever was watching when the process exited got this notice on the
    // wire, and someone who arrives inside the fifteen-minute grace is owed
    // the same thing: without it the screen is just the program's last frame,
    // which looks exactly like a program that is still there. Delivered
    // AFTER the resync, so the gate holds it behind the snapshot instead of
    // letting the snapshot's wipe erase it.
    if (session.exited) {
      sync.deliver(exitNotice(session.exitCode));
    }

    // A stall is announced once, at the moment it trips. Someone who opens the
    // viewer BECAUSE they were told a session is stuck arrives after
    // the only announcement, and is the exact person the badge is for. Replay the
    // current state to them.
    const held = this.promptStates.get(session.id);
    if (held?.alerted === true) {
      ws.send(
        JSON.stringify({
          type: 'prompt-stall',
          waitingMs: Date.now() - held.since,
          question: held.prompt.question,
          options: held.prompt.options,
        }),
      );
    }

    const unsubscribeData = session.onData((data) => sync.deliver(data));
    this.updateFeedSession(session.id);
    const unsubscribeExit = session.onExit((exitCode) => {
      sync.deliver(exitNotice(exitCode));
      // The notice is bytes on the terminal; the page needs a frame to change
      // its own state.
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exited', exitCode }));
      }
    });

    // A protocol error, such as a malformed frame or a reset mid-handshake,
    // is logged and closes the socket rather than escaping as an uncaught
    // exception. The close handler below does the bookkeeping either way.
    ws.on('error', (error) => {
      this.logger.warn('viewer socket error', { id: session.id, error: String(error) });
      ws.close();
    });

    /** Whether this socket has been told that the session's input has failed. */
    let toldInputFailed = false;
    ws.on('message', (message: Buffer | string) => {
      this.lastActivity = Date.now();
      const text = typeof message === 'string' ? message : message.toString('utf8');
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { type?: string }).type === 'resize'
        ) {
          const { cols, rows, take } = parsed as { cols?: number; rows?: number; take?: unknown };
          // Fit, Enlarge, Focus and Restore are a resize that says `take`.
          // A passive socket's other resizes, including one a dashboard pane
          // sends because the window moved, are not that act: the grid stays,
          // nobody is handed it, and nothing is audited. Passivity is the
          // dashboard credential, or `drive=0` on a viewer or client socket.
          if (passive && take !== true) return;
          if (
            !readOnly &&
            typeof cols === 'number' &&
            typeof rows === 'number' &&
            Number.isInteger(cols) &&
            Number.isInteger(rows) &&
            cols >= 2 &&
            cols <= 1_000 &&
            rows >= 2 &&
            rows <= 500 &&
            !session.exited
          ) {
            if (session.geometryHeld) {
              // Held against viewports. Answer with the real grid so the page
              // stops proposing one it will never be given.
              ws.send(JSON.stringify(this.geometryFrame(session, ws)));
              return;
            }
            const wanted = {
              cols: Math.min(cols, MAX_VIEWPORT_COLS),
              rows: Math.min(rows, MAX_VIEWPORT_ROWS),
            };
            const handedOver = this.geometryController.get(session.id) !== ws;
            const changed = wanted.cols !== session.cols || wanted.rows !== session.rows;
            let applied = false;
            try {
              session.resize(wanted.cols, wanted.rows);
              applied = true;
            } catch (error) {
              // The program has ended (a viewer fitting its window while
              // looking at a dying session), and the session's exit follows
              // within about a second, with an `exited` frame to every
              // watcher. Nothing moved and nobody takes the grid, so nothing
              // is said: an answer would have a driving page whose window
              // does not fit the grid propose again at once, over and over
              // until the exit arrives.
              if (error instanceof SessionProgramEndedError) return;
              // Any other failure is logged rather than left to escape: an
              // exception from a WS handler would take the whole daemon down
              // via the uncaughtException path.
              this.logger.warn('viewer resize failed', {
                id: session.id,
                error: String(error),
              });
            }
            // Asking is the deliberate act that takes control, whether or not
            // the grid actually moves: a viewport that already fits is still
            // the one driving.
            this.geometryController.set(session.id, ws);
            // A geometry change is a geometry change whoever made it, and
            // `resize` is on the list of audited actions the security page
            // publishes. Only the ones that actually took: a proposal the
            // grid already satisfied moved nothing, and one that failed moved
            // nothing either, so neither is recorded as a success. `hold` is
            // false because a viewport never holds: holding is asked for
            // explicitly, over the API (§5).
            if (changed && applied) {
              this.audit.record(actor, 'resize', session.id, {
                cols: wanted.cols,
                rows: wanted.rows,
                hold: false,
              });
            }
            // Everyone sees the same grid, and each is told whether they are
            // now driving it. A proposal that changed nothing needs no
            // snapshot, because the page already shows this grid. But if the
            // grid changed hands, everyone is told that much, or the old
            // driver goes on believing it is theirs.
            if (changed) this.announceGeometry(session.id, session);
            else if (handedOver) this.announceGeometry(session.id, session, { resync: false });
          }
          return;
        }
      } catch {
        // Not JSON: bytes for the program, a person's keystrokes or the
        // viewer's terminal answering the program. Straight into the PTY
        // either way: shared typing is the point of the tool.
      }
      if (readOnly) {
        // A watch-only credential. Dropped silently and on the daemon's side:
        // the page has already been told it is read-only and disables its own
        // input, so anything arriving here is not a human mistyping.
        return;
      }
      if (session.exited) {
        // A session stays reachable for fifteen minutes after its process
        // exits, and input typed into that window is refused out loud, as the
        // HTTP path refuses it with a 409.
        // Told to this socket alone: the other watchers did not type it.
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'input-refused',
              reason: 'exited',
              exitCode: session.exitCode,
            }),
          );
        }
        return;
      }
      if (session.inputFailed) {
        // The input pipe has failed (Windows): nothing typed reaches the
        // program, so nothing is written, audited or logged. This socket is
        // told once, and the page says so; the 409 on the HTTP path is the
        // same refusal.
        if (!toldInputFailed && ws.readyState === ws.OPEN) {
          toldInputFailed = true;
          ws.send(JSON.stringify({ type: 'input-refused', reason: 'input-failed' }));
        }
        return;
      }
      // write() is async, so a failure arrives as a rejection and never as a
      // synchronous throw: a try/catch here would be dead code. Not awaited:
      // this is the viewer's data handler and must stay responsive, and
      // ordering is guaranteed inside write() by its queue rather than here.
      // (xterm hands us multi-character strings for pastes and escape
      // sequences, so this is not always one keystroke.) .catch keeps the exit
      // race, the session dying mid-write, from escaping as an unhandled
      // rejection.
      void session.write(text).catch((error: unknown) => {
        this.logger.warn('viewer input failed', {
          id: session.id,
          error: String(error),
        });
      });
      // The viewer's terminal answering the program, such as where the cursor
      // is or that the window gained focus, is written above like a keystroke
      // because the program asked for it. Nobody typed it, so it is audited
      // as a report and leaves the "last input" indicator alone (§4.5, §5).
      // Content only under captureContent, as for input.
      const report = terminalReportKind(text);
      if (report !== null) {
        this.audit.record(actor, 'report', session.id, {
          kind: report,
          chars: text.length,
          ...(this.audit.captureContent ? { data: text } : {}),
        });
        return;
      }
      this.audit.record(actor, 'input', session.id, {
        chars: text.length,
        ...(this.audit.captureContent ? { data: text } : {}),
      });
      this.broadcastControl(session.id, { type: 'input-source', source: 'human' });
    });

    ws.on('close', () => {
      unsubscribeData();
      unsubscribeExit();
      sync.close();
      this.sockets.delete(ws);
      this.sessionSockets.get(session.id)?.delete(ws);
      this.updateFeedSession(session.id);
      // The grid stays where it is; it simply no longer belongs to anyone.
      // The next single-session viewport to arrive, or a `take`, picks it
      // up. A dashboard socket, and a `drive=0` socket, that is already
      // connected does not inherit it.
      if (this.geometryController.get(session.id) === ws) {
        this.geometryController.delete(session.id);
      }
      this.lastActivity = Date.now();
      this.audit.record(actor, 'ws-close', session.id);
    });
  }
}
