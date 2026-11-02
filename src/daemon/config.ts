/**
 * Shape validation for `~/.shellpuppet/config.json` (design §4.3 fail-closed).
 *
 * Why this exists: parsed JSON is not a config until its shape has been
 * checked. A string where an array belongs (`"allow": "^goose"`) must not
 * reach `compilePolicy`, whose `for…of` would read it one character at a
 * time as single-character rules. A shape mistake must fail CLOSED, exactly
 * as a malformed pattern does.
 *
 * The rules:
 * - No config file ⇒ pure defaults (the documented behaviour).
 * - A file that cannot be read or parsed, or whose root is not a JSON object
 *   ⇒ the intended policy is unknowable: the policy refuses every command
 *   (naming the problem in each refusal) and sessionEnv falls back to
 *   `clean`.
 * - A structurally invalid `policy` section ⇒ deny-all, problem named. No
 *   per-field salvage: a policy that cannot be evaluated as written must not
 *   be guessed at. Unknown keys INSIDE `policy` invalidate it too: a
 *   misspelt `deny` must not silently deny nothing.
 * - Invalid `sessionEnv` ⇒ `clean`, never passthrough: environment hygiene
 *   is a security control, and its failure mode
 *   must not silently hand every session the daemon's secrets.
 * - Invalid `idleMinutes` / `audit` ⇒ safe defaults, problem named
 *   (`captureContent` records typed secrets, so anything unclear means OFF).
 * - Unknown top-level keys ⇒ reported (typo detection), config otherwise
 *   honoured.
 *
 * `parseDaemonConfig` is pure; `readDaemonConfig` adds the file read. The
 * daemon stays up in every case: refusing to start would strand every
 * client with no error message at all, whereas a running daemon can say
 * exactly what is wrong on every refused request.
 */

import * as fs from 'node:fs';
import { configPath } from './paths.js';
import { compileDialogs } from '../core/dialogs.js';
import type { DialogSignature } from '../core/dialogs.js';
import { BUILT_IN_SIGNATURES, compileSignatures } from '../core/reasoning.js';
import type { AgentSignature } from '../core/reasoning.js';
import { ENV_NAME_PATTERN } from '../core/types.js';
import type { PolicyConfig, PolicyMode, SessionEnvMode } from '../core/types.js';
import type { ViewerLaunchConfig, ViewerLaunchMode } from './viewerLauncher.js';
import { parseLauncher } from './launchProfiles.js';
import type { LauncherConfig } from './launchProfiles.js';

export const DEFAULT_VIEWER_LAUNCH_MODE: ViewerLaunchMode = 'dashboard';

export interface DaemonConfig {
  /** How clients start a missing daemon. This is read before daemon startup. */
  daemon?: { startWith?: string[]; startWithOnlyIfEnvContains?: string };
  policy?: PolicyConfig;
  /** Idle self-shutdown threshold in minutes; fractions allowed (design §2.3). */
  idleMinutes?: number;
  /** Session environment hygiene (design §4.6). */
  sessionEnv?: SessionEnvMode;
  /** Audit options (design §4.5). */
  audit?: { captureContent?: boolean };
  /** How the viewer window is opened. */
  viewer?: ViewerLaunchConfig;
  /** Initial dashboard text size when the browser has no saved preference. */
  dashboard?: { fontSize?: number };
  /**
   * The named programs the dashboard may start (`launcher.profiles`, design
   * §4.3). Absent means a watch-only dashboard. Invalid entries are named in
   * `problems` and left out; their siblings still load.
   */
  launcher?: LauncherConfig;
  /**
   * Permission dialogs to recognise beyond the built-in ones (`dialogs.ts`):
   * the entries that compile. The rest are reported and left out.
   */
  dialogs?: DialogSignature[];
  /**
   * Agent signatures beyond the built-in ones, or replacing one by name
   * (`reasoning.ts`): the entries that compile. The rest are reported and
   * left out.
   */
  agentSignatures?: AgentSignature[];
  /**
   * The variables each agent's sessions receive from the environment of the
   * client that starts them (`agents.passEnv`, design §4.6), by agent name.
   * The MCP server and the CLI hold the values and apply the lists; the
   * daemon only checks them, so a mistake is reported in `daemon.log` too.
   */
  agentPassEnv?: Record<string, string[]>;
  /**
   * The variables a caller may name at start for a session that runs as no
   * agent (`envNames`, design §4.6): `terminal_start`'s `envNames` and the
   * CLI's `--env-name`. The MCP server and the CLI hold the values and apply
   * the list; the daemon only checks it, so a mistake is reported in
   * `daemon.log` too.
   */
  envNames?: string[];
}

export interface ParsedDaemonConfig {
  config: DaemonConfig;
  /** Human-readable problems. The daemon logs each one loudly at startup. */
  problems: string[];
}

const POLICY_MODES: readonly PolicyMode[] = ['allow-all', 'allowlist', 'denylist'];
const POLICY_KEYS = new Set(['mode', 'allow', 'deny', 'maxSessions']);
/**
 * `mcp` is the MCP adapter's section, known here so it is not flagged; the
 * daemon looks inside it only for a `passEnv`, which it reports.
 */
const TOP_LEVEL_KEYS = new Set([
  'policy',
  'idleMinutes',
  'sessionEnv',
  'audit',
  'mcp',
  'viewer',
  'dashboard',
  'prompts',
  'agents',
  'envNames',
  'launcher',
  'daemon',
]);
const DAEMON_KEYS = new Set(['startWith', 'startWithOnlyIfEnvContains']);
const VIEWER_KEYS = new Set(['launchMode', 'browserPath', 'profileDir']);
const VIEWER_LAUNCH_MODES: readonly ViewerLaunchMode[] = [
  'dashboard',
  'isolated-app',
  'default-browser',
  'no-window',
];

/**
 * Viewer launch options. An invalid value falls back to "no-window", NOT to the
 * launching default: config the daemon cannot read must not cause it to start
 * spawning browser windows on someone's desktop, and a viewer that did not
 * open is visibly wrong in a way the operator can act on.
 */
function parseViewer(raw: unknown, problems: string[]): ViewerLaunchConfig {
  if (!isRecord(raw)) {
    problems.push('viewer must be an object: not opening the viewer automatically');
    return { launchMode: 'no-window' };
  }
  for (const key of Object.keys(raw)) {
    if (!VIEWER_KEYS.has(key)) {
      problems.push(`viewer has an unknown key "${key}": ignored (typo?)`);
    }
  }
  const config: ViewerLaunchConfig = {};
  const launchMode = raw['launchMode'];
  if (launchMode !== undefined) {
    if (launchMode === 'none') {
      config.launchMode = 'no-window';
    } else if (
      typeof launchMode === 'string' &&
      VIEWER_LAUNCH_MODES.includes(launchMode as ViewerLaunchMode)
    ) {
      config.launchMode = launchMode as ViewerLaunchMode;
    } else {
      config.launchMode = 'no-window';
      problems.push(
        `viewer.launchMode must be one of ${VIEWER_LAUNCH_MODES.join(' | ')}: not opening the viewer automatically`,
      );
    }
  }
  for (const key of ['browserPath', 'profileDir'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value !== '') {
      config[key] = value;
    } else {
      problems.push(`viewer.${key} must be a non-empty string: ignored`);
    }
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * `agents.passEnv`: agent name to the variables its sessions receive. An entry
 * for an agent with no signature, or that is not a list, is reported and left
 * out; names that are not variable names are reported and dropped from their
 * list. Nothing else is affected.
 */
function parseAgentPassEnv(
  value: unknown,
  known: ReadonlySet<string>,
  problems: string[],
): Record<string, string[]> | undefined {
  if (!isRecord(value)) {
    problems.push('agents.passEnv must be an object of agent names to lists of variable names: passing none');
    return undefined;
  }
  const lists: Record<string, string[]> = {};
  for (const [agent, names] of Object.entries(value)) {
    if (!known.has(agent)) {
      problems.push(`agents.passEnv names ${agent}, which has no agent signature: that entry is ignored`);
      continue;
    }
    if (!Array.isArray(names)) {
      problems.push(`agents.passEnv.${agent} must be a list of variable names: that entry is ignored`);
      continue;
    }
    const valid = names.filter((name): name is string => typeof name === 'string' && ENV_NAME_PATTERN.test(name));
    if (valid.length !== names.length) {
      problems.push(`agents.passEnv.${agent}: ignoring entries that are not variable names`);
    }
    lists[agent] = valid;
  }
  return lists;
}

/**
 * Whether a problem bears on the `envNames` list, for the clients that apply
 * it to report alongside their own refusals: a problem with the list itself,
 * the unread `mcp.passEnv`, or a `config.json` that could not be read at all,
 * which leaves the list empty.
 */
export function isEnvNamesProblem(problem: string): boolean {
  return (
    problem.startsWith('envNames') ||
    problem.startsWith('mcp.passEnv') ||
    (problem.startsWith('config.json ') && problem.includes('refusing all commands'))
  );
}

/**
 * The daemon.log line for a signature that ran past the regular-expression
 * time budget on a screen and is set aside for a minute (`SET_ASIDE_MS`), to
 * be tried again. One from config is a CONFIG PROBLEM its author can act on.
 * A built-in one is not anybody's to change, and a busy machine can make an
 * ordinary pattern overrun, so its line says so and asks nothing.
 */
export function signatureOverBudgetLog(
  kind: 'dialog' | 'agent',
  name: string,
  builtIn: boolean,
): { message: string; meta: Record<string, string> } {
  if (builtIn) {
    return {
      message: 'signature set aside',
      meta: {
        signature: name,
        note:
          `the built-in "${name}" ${kind} signature ran past the regular-expression time budget on a ` +
          'screen, as a busy machine can make it do; it is tried again in a minute, and there is nothing to change',
      },
    };
  }
  return {
    message: 'CONFIG PROBLEM',
    meta: {
      problem:
        `the "${name}" ${kind} signature ran past the regular-expression time budget on a screen ` +
        'and is set aside for a minute at a time; if it keeps happening, simplify its patterns',
    },
  };
}

/** A policy that refuses every command, naming the configuration problem. */
function denyAllPolicy(reason: string): PolicyConfig {
  // The empty allowlist is belt-and-braces: even if configError were ever
  // ignored, nothing can match an empty allow list.
  return { mode: 'allowlist', allow: [], configError: reason };
}

function parsePolicy(raw: unknown, problems: string[]): PolicyConfig {
  const invalid = (detail: string): PolicyConfig => {
    problems.push(`policy ${detail}: refusing all commands until it is fixed`);
    return denyAllPolicy(`the policy section is invalid: ${detail}.`);
  };

  if (!isRecord(raw)) return invalid('is not an object');
  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.has(key)) return invalid(`has an unknown key "${key}"`);
  }
  const mode = raw['mode'] ?? 'allow-all';
  if (typeof mode !== 'string' || !POLICY_MODES.includes(mode as PolicyMode)) {
    return invalid(`mode must be one of ${POLICY_MODES.join(' | ')}`);
  }
  for (const listName of ['allow', 'deny'] as const) {
    const list = raw[listName];
    if (list !== undefined && !isStringArray(list)) {
      return invalid(`${listName} must be an ARRAY of regex strings (e.g. ["^goose"])`);
    }
  }
  const maxSessions = raw['maxSessions'];
  if (
    maxSessions !== undefined &&
    (typeof maxSessions !== 'number' || !Number.isInteger(maxSessions) || maxSessions < 1)
  ) {
    return invalid('maxSessions must be a positive integer');
  }
  return {
    mode: mode as PolicyMode,
    ...(isStringArray(raw['allow']) ? { allow: raw['allow'] } : {}),
    ...(isStringArray(raw['deny']) ? { deny: raw['deny'] } : {}),
    ...(typeof maxSessions === 'number' ? { maxSessions } : {}),
  };
}

/** The fail-closed result for a config whose intent is unknowable. */
function unknowableConfig(reason: string, problem: string): ParsedDaemonConfig {
  return {
    config: { policy: denyAllPolicy(reason), sessionEnv: 'clean' },
    problems: [problem],
  };
}

/** Validate a parsed config value. `undefined` means "no file": pure defaults. */
export function parseDaemonConfig(raw: unknown): ParsedDaemonConfig {
  if (raw === undefined) return { config: {}, problems: [] };
  if (!isRecord(raw)) {
    return unknowableConfig(
      'config.json is not a JSON object.',
      'config.json is not a JSON object: refusing all commands and using the clean session env until it is fixed',
    );
  }

  const problems: string[] = [];
  const config: DaemonConfig = {};
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      problems.push(`config.json has an unknown key "${key}": ignored (typo?)`);
    }
  }

  if (raw['policy'] !== undefined) config.policy = parsePolicy(raw['policy'], problems);

  if (raw['daemon'] !== undefined) {
    const daemon = raw['daemon'];
    if (!isRecord(daemon)) {
      problems.push('daemon must be an object: starting directly');
    } else {
      let valid = true;
      for (const key of Object.keys(daemon)) {
        if (!DAEMON_KEYS.has(key)) {
          problems.push(`daemon has an unknown key "${key}": starting directly`);
          valid = false;
        }
      }
      const startWith = daemon['startWith'];
      const condition = daemon['startWithOnlyIfEnvContains'];
      if (startWith !== undefined && (!Array.isArray(startWith) || startWith.length < 1 ||
          startWith.length > 16 || startWith.some((part) => typeof part !== 'string' ||
            part.trim() === '' || part.length > 1024 || part.includes('\0')))) {
        problems.push('daemon.startWith must have 1 to 16 non-blank strings of at most 1024 characters: starting directly');
        valid = false;
      }
      if (condition !== undefined && (typeof condition !== 'string' || condition.trim() === '' ||
          condition.length > 256)) {
        problems.push('daemon.startWithOnlyIfEnvContains must be a non-blank string of at most 256 characters: starting directly');
        valid = false;
      }
      if (valid && isStringArray(startWith)) {
        config.daemon = {
          startWith,
          ...(typeof condition === 'string' ? { startWithOnlyIfEnvContains: condition } : {}),
        };
      }
    }
  }

  const sessionEnv = raw['sessionEnv'];
  if (sessionEnv !== undefined) {
    if (sessionEnv === 'passthrough' || sessionEnv === 'clean' || isStringArray(sessionEnv)) {
      config.sessionEnv = sessionEnv;
    } else {
      config.sessionEnv = 'clean';
      problems.push(
        'sessionEnv must be "passthrough", "clean" or an array of variable names: using "clean"',
      );
    }
  }

  const idleMinutes = raw['idleMinutes'];
  if (idleMinutes !== undefined) {
    if (typeof idleMinutes === 'number' && Number.isFinite(idleMinutes) && idleMinutes > 0) {
      config.idleMinutes = idleMinutes;
    } else {
      problems.push('idleMinutes must be a positive number of minutes: using the default');
    }
  }

  const audit = raw['audit'];
  if (audit !== undefined) {
    const captureContent = isRecord(audit) ? audit['captureContent'] : undefined;
    if (isRecord(audit) && (captureContent === undefined || typeof captureContent === 'boolean')) {
      config.audit = {
        ...(typeof captureContent === 'boolean' ? { captureContent } : {}),
      };
    } else {
      problems.push('audit.captureContent must be a boolean: content capture stays off');
    }
  }

  if (raw['viewer'] !== undefined) config.viewer = parseViewer(raw['viewer'], problems);
  if (raw['dashboard'] !== undefined) {
    const dashboard = raw['dashboard'];
    if (!isRecord(dashboard)) {
      problems.push('dashboard must be an object: ignored');
    } else {
      config.dashboard = {};
      for (const key of Object.keys(dashboard)) {
        if (key !== 'fontSize') problems.push(`dashboard has an unknown key "${key}": ignored (typo?)`);
      }
      if (dashboard['fontSize'] !== undefined) {
        const size = dashboard['fontSize'];
        if (typeof size === 'number' && Number.isInteger(size) && size >= 8 && size <= 32) {
          config.dashboard.fontSize = size;
        } else {
          problems.push('dashboard.fontSize must be an integer from 8 to 32: ignored');
        }
      }
    }
  }

  // Extra dialog signatures. A broken one is reported and left out, and the
  // built-in ones are recognised regardless: detection that misses a dialog
  // costs only what it cost before, so there is nothing to fail closed for.
  const prompts = raw['prompts'];
  if (prompts !== undefined) {
    const dialogs = isRecord(prompts) ? prompts['dialogs'] : undefined;
    const shapeOk =
      isRecord(prompts) &&
      Object.keys(prompts).every((key) => key === 'dialogs') &&
      (dialogs === undefined || Array.isArray(dialogs));
    if (!shapeOk) {
      problems.push(
        'prompts must be an object whose only key is dialogs, an array: using the built-in dialogs only',
      );
    } else if (Array.isArray(dialogs)) {
      const compiled = compileDialogs(dialogs);
      problems.push(...compiled.problems);
      config.dialogs = compiled.usable.map((index) => dialogs[index] as DialogSignature);
    }
  }

  // Extra agent signatures. A broken one is reported and left out; a session
  // that would have needed it is refused by the readers, which fail closed.
  const agents = raw['agents'];
  if (agents !== undefined) {
    if (!isRecord(agents)) {
      problems.push(
        'agents must be an object with signatures (an array) and passEnv (an object): using the ' +
          'built-in signatures and passing no variables',
      );
    } else {
      // Each part stands alone: a mistake in one never knocks out the other.
      for (const key of Object.keys(agents)) {
        if (key !== 'signatures' && key !== 'passEnv') problems.push(`agents has an unknown key ${key}: ignored`);
      }
      const signatures = agents['signatures'];
      if (signatures !== undefined && !Array.isArray(signatures)) {
        problems.push('agents.signatures must be an array: using the built-in signatures only');
      } else if (Array.isArray(signatures)) {
        const compiled = compileSignatures(signatures);
        problems.push(...compiled.problems);
        config.agentSignatures = compiled.usable.map((index) => signatures[index] as AgentSignature);
      }
      if (agents['passEnv'] !== undefined) {
        const known = new Set([
          ...BUILT_IN_SIGNATURES.map((signature) => signature.name),
          ...(config.agentSignatures ?? []).map((signature) => signature.name),
        ]);
        const passEnv = parseAgentPassEnv(agents['passEnv'], known, problems);
        if (passEnv !== undefined) config.agentPassEnv = passEnv;
      }
    }
  }

  // Dashboard launch profiles. A broken entry is named and left out; its
  // siblings still load, and nothing here changes policy.
  if (raw['launcher'] !== undefined) {
    const known = new Set([
      ...BUILT_IN_SIGNATURES.map((signature) => signature.name),
      ...(config.agentSignatures ?? []).map((signature) => signature.name),
    ]);
    const parsed = parseLauncher(raw['launcher'], known);
    config.launcher = parsed.launcher;
    problems.push(...parsed.problems);
  }

  // The variables a caller may name at start. A list under `mcp.passEnv` is
  // not read: it passes nothing, and the problem says where the list goes.
  const envNames = raw['envNames'];
  if (envNames !== undefined) {
    if (!Array.isArray(envNames)) {
      problems.push('envNames in config.json must be an array of variable names: passing none');
    } else {
      const valid = envNames.filter((name): name is string => typeof name === 'string' && ENV_NAME_PATTERN.test(name));
      if (valid.length !== envNames.length) {
        problems.push('envNames in config.json: ignoring entries that are not variable names');
      }
      config.envNames = valid;
    }
  }
  const mcp = raw['mcp'];
  if (isRecord(mcp) && mcp['passEnv'] !== undefined) {
    problems.push(
      'mcp.passEnv is not read, so nothing passes from it: the variables a caller may name at start ' +
        'are read from envNames, at the top level of config.json',
    );
  }

  return { config, problems };
}

/** Locate a JSON syntax error without using V8's message, which may quote config text. */
function jsonErrorLocation(raw: string): { line: number; column: number } {
  class InvalidJson extends Error {
    constructor(readonly offset: number) { super('invalid JSON'); }
  }
  let at = 0;
  const fail = (): never => { throw new InvalidJson(at); };
  const space = (): void => {
    while (at < raw.length && /[ \t\r\n]/.test(raw[at] ?? '')) at++;
  };
  const expectChar = (ch: string): void => {
    if (raw[at] !== ch) fail();
    at++;
  };
  const string = (): void => {
    expectChar('"');
    while (at < raw.length) {
      const ch = raw[at] ?? '';
      if (ch === '"') { at++; return; }
      if (ch.charCodeAt(0) < 0x20) fail();
      if (ch === '\\') {
        at++;
        const escaped = raw[at] ?? '';
        if (escaped === 'u') {
          at++;
          for (let n = 0; n < 4; n++, at++) {
            if (!/[0-9a-fA-F]/.test(raw[at] ?? '')) fail();
          }
          continue;
        }
        if (!/["\\/bfnrt]/.test(escaped)) fail();
      }
      at++;
    }
    fail();
  };
  const value = (depth: number): void => {
    if (depth > 256) fail();
    space();
    const ch = raw[at];
    if (ch === '"') { string(); return; }
    if (ch === '{') {
      at++;
      space();
      if (raw[at] === '}') { at++; return; }
      for (;;) {
        string();
        space();
        expectChar(':');
        value(depth + 1);
        space();
        if (raw[at] === '}') { at++; return; }
        expectChar(',');
        space();
      }
    }
    if (ch === '[') {
      at++;
      space();
      if (raw[at] === ']') { at++; return; }
      for (;;) {
        value(depth + 1);
        space();
        if (raw[at] === ']') { at++; return; }
        expectChar(',');
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (ch === literal[0]) {
        for (const expected of literal) expectChar(expected);
        return;
      }
    }
    if (ch === '-' || (ch !== undefined && /[0-9]/.test(ch))) {
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(raw.slice(at));
      if (number === null) return fail();
      at += number[0].length;
      return;
    }
    fail();
  };
  try {
    value(0);
    space();
    if (at < raw.length) fail();
  } catch (error) {
    if (!(error instanceof InvalidJson)) at = 0;
    else at = error.offset;
  }
  const lines = raw.slice(0, at).split(/\r\n|\r|\n/);
  return { line: lines.length, column: (lines.at(-1) ?? '').length + 1 };
}

/** Read and validate the config file. ENOENT ⇒ defaults; unreadable ⇒ fail closed. */
export function readDaemonConfig(home: string): ParsedDaemonConfig {
  let rawText: string;
  try {
    rawText = fs.readFileSync(configPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: {}, problems: [] };
    }
    return unknowableConfig(
      `config.json exists but could not be read (${String(error)}).`,
      `config.json could not be read (${String(error)}): refusing all commands`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch {
    const { line, column } = jsonErrorLocation(rawText);
    return unknowableConfig(
      `config.json is not valid JSON at line ${String(line)}, column ${String(column)}.`,
      `config.json is not valid JSON at line ${String(line)}, column ${String(column)}: refusing all commands`,
    );
  }
  return parseDaemonConfig(raw);
}
