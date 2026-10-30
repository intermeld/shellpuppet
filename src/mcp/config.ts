/**
 * The MCP adapter's own section of `config.json` (the daemon parses the
 * rest, the variable lists included): the framing toggle at launch. Also the
 * rules by which the MCP server and the CLI apply those lists at every start.
 * Problems are reported through the logger, which the adapter points at
 * stderr: stdout belongs to the MCP protocol.
 */

import * as fs from 'node:fs';
import { configPath } from '../daemon/paths.js';
import type { Logger } from '../core/types.js';

export interface McpConfig {
  /** §4.4 framing toggle: `{ "mcp": { "untrustedFraming": false } }` disables. */
  untrustedFraming: boolean;
}

const DEFAULTS: McpConfig = { untrustedFraming: true };

/** The `mcp` section of a parsed config, with defaults for what is absent. */
export function parseMcpConfig(parsed: unknown): McpConfig {
  const mcp =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { mcp?: { untrustedFraming?: unknown } }).mcp
      : undefined;
  if (mcp === undefined || mcp === null) return { ...DEFAULTS };
  return { untrustedFraming: mcp.untrustedFraming !== false };
}

/**
 * Resolve requested variable names against the human's list (§4.6), for the
 * MCP server's `envNames` and the CLI's `--env-name` alike. Names off the
 * list refuse the start; listed names not set in `environment` are reported,
 * by name, and not passed. On Windows names compare in any case, as Windows
 * reads them.
 */
export function resolvePassedEnv(
  requested: readonly string[],
  allowed: readonly string[],
  environment: NodeJS.ProcessEnv,
): { env: Record<string, string>; absent: string[]; refused: string[] } {
  const fold = (name: string): string => (process.platform === 'win32' ? name.toUpperCase() : name);
  const allowedSet = new Set(allowed.map(fold));
  const lookup = new Map<string, string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) lookup.set(fold(name), value);
  }
  const env: Record<string, string> = {};
  const absent: string[] = [];
  const refused: string[] = [];
  for (const name of requested) {
    if (!allowedSet.has(fold(name))) refused.push(name);
    else if (lookup.has(fold(name))) env[name] = lookup.get(fold(name))!;
    else absent.push(name);
  }
  return { env, absent, refused };
}

/**
 * The variables a start passes for the agent its session runs as
 * (`agents.passEnv`, §4.6), with what a caller may add by name. For an agent
 * session the agent's list is the whole answer: its names pass without being
 * asked for, and a requested name off that list refuses the start. A session
 * that runs as no agent passes only requested names on `adHoc`
 * (config `envNames`). Names, never values, go into the notes and the refusal.
 */
export function planPassedEnv(input: {
  agent: string | null;
  requested: readonly string[];
  agentLists: Readonly<Record<string, readonly string[]>>;
  adHoc: readonly string[];
  environment: NodeJS.ProcessEnv;
  /** Where the values come from, for the notes: "this MCP server's environment". */
  source: string;
}): { env: Record<string, string>; notes: string[]; refusedForAgent: string[]; refused: string[] } {
  const { agent, requested, environment, source } = input;
  if (agent === null) {
    const { env, absent, refused } = resolvePassedEnv(requested, input.adHoc, environment);
    const notes: string[] = [];
    if (Object.keys(env).length > 0) notes.push(`Passed from ${source}: ${Object.keys(env).join(', ')}.`);
    if (absent.length > 0) notes.push(`Not set in ${source}, so not passed: ${absent.join(', ')}.`);
    return { env, notes, refusedForAgent: [], refused };
  }
  // An own entry only: an agent named `constructor` or `__proto__` has no list.
  const list = Object.prototype.hasOwnProperty.call(input.agentLists, agent) ? (input.agentLists[agent] ?? []) : [];
  const refusedForAgent = resolvePassedEnv(requested, list, environment).refused;
  const { env, absent } = resolvePassedEnv(list, list, environment);
  const notes: string[] = [];
  if (Object.keys(env).length > 0) notes.push(`Passed for ${agent} from ${source}: ${Object.keys(env).join(', ')}.`);
  if (absent.length > 0) notes.push(`Listed for ${agent} but not set in ${source}, so not passed: ${absent.join(', ')}.`);
  return { env, notes, refusedForAgent, refused: [] };
}

/** Read the `mcp` section of `<home>/config.json`; no file or no section means the defaults. */
export function readMcpConfig(home: string, logger: Logger): McpConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(home), 'utf8');
  } catch {
    return { ...DEFAULTS };
  }
  try {
    return parseMcpConfig(JSON.parse(raw));
  } catch {
    logger.warn('config.json could not be parsed: using the MCP defaults');
    return { ...DEFAULTS };
  }
}
