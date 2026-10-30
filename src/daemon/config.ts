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

export interface DaemonConfig {
  policy?: PolicyConfig;
  /** Idle self-shutdown threshold in minutes; fractions allowed (design §2.3). */
  idleMinutes?: number;
  /** Session environment hygiene (design §4.6). */
  sessionEnv?: SessionEnvMode;
  /** Audit options (design §4.5). */
  audit?: { captureContent?: boolean };
  /** How the viewer window is opened. */
  viewer?: ViewerLaunchConfig;
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
}

export interface ParsedDaemonConfig {
  config: DaemonConfig;
  /** Human-readable problems. The daemon logs each one loudly at startup. */
  problems: string[];
}

const POLICY_MODES: readonly PolicyMode[] = ['allow-all', 'allowlist', 'denylist'];
const POLICY_KEYS = new Set(['mode', 'allow', 'deny', 'maxSessions']);
/** `mcp` is the MCP adapter's section, known here so it is not flagged. */
const TOP_LEVEL_KEYS = new Set([
  'policy',
  'idleMinutes',
  'sessionEnv',
  'audit',
  'mcp',
  'viewer',
  'prompts',
  'agents',
]);
const VIEWER_KEYS = new Set(['launchMode', 'browserPath', 'profileDir']);
const VIEWER_LAUNCH_MODES: readonly ViewerLaunchMode[] = [
  'isolated-app',
  'default-browser',
  'none',
];

/**
 * Viewer launch options. An invalid value falls back to "none", NOT to the
 * launching default: config the daemon cannot read must not cause it to start
 * spawning browser windows on someone's desktop, and a viewer that did not
 * open is visibly wrong in a way the operator can act on.
 */
function parseViewer(raw: unknown, problems: string[]): ViewerLaunchConfig {
  if (!isRecord(raw)) {
    problems.push('viewer must be an object: not opening the viewer automatically');
    return { launchMode: 'none' };
  }
  for (const key of Object.keys(raw)) {
    if (!VIEWER_KEYS.has(key)) {
      problems.push(`viewer has an unknown key "${key}": ignored (typo?)`);
    }
  }
  const config: ViewerLaunchConfig = {};
  const launchMode = raw['launchMode'];
  if (launchMode !== undefined) {
    if (
      typeof launchMode === 'string' &&
      VIEWER_LAUNCH_MODES.includes(launchMode as ViewerLaunchMode)
    ) {
      config.launchMode = launchMode as ViewerLaunchMode;
    } else {
      config.launchMode = 'none';
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

  return { config, problems };
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
  try {
    return parseDaemonConfig(JSON.parse(rawText));
  } catch (error) {
    return unknowableConfig(
      `config.json is not valid JSON (${String(error)}).`,
      `config.json is not valid JSON (${String(error)}): refusing all commands`,
    );
  }
}
