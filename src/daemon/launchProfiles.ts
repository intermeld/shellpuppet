/**
 * Dashboard launch profiles (`launcher.profiles`, design §4.3 and §5.1).
 *
 * A profile is the only way the dashboard may start a process: the page names
 * a profile and, when the profile offers them, a folder. It never supplies a
 * command, an argument, a path or an environment value. So this module turns
 * the configuration's entries into the small, fixed set of starts the launch
 * route is allowed to perform, and leaves out any entry it cannot read whole.
 *
 * The rules are fail-closed in the same way as `config.ts`: an entry that
 * cannot be parsed is omitted and named in `daemon.log`, and its siblings
 * still load. A broken launcher section never installs a deny-all policy,
 * because profiles are an addition to policy rather than the policy itself.
 *
 * `parseLauncher` is pure. `copyDaemonEnv` is pure apart from reading the
 * environment it is handed, which keeps the values out of every caller that
 * only needs the names. `resolveLaunchCommand` reads the file system to find
 * the file a launch will start, and nothing else.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV_NAME_PATTERN, RESERVED_FEATURE_CREDENTIALS } from '../core/types.js';
import { compilePolicy } from '../core/policy.js';
import type { CompiledPolicy } from '../core/policy.js';

export { RESERVED_FEATURE_CREDENTIALS };

/** The name pattern a profile and each of its folders must match. */
export const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const LAUNCH_OPEN_MODES = ['grid', 'focus', 'window'] as const;
export type LaunchOpen = (typeof LAUNCH_OPEN_MODES)[number];

export interface LaunchFolder {
  name: string;
  /** The configured path, resolved from the user's home when it is relative. */
  path: string;
}

export interface LaunchProfilePolicy {
  allow?: string[];
  deny?: string[];
}

export interface LaunchProfile {
  name: string;
  command: string;
  args: string[];
  shell?: boolean;
  /** A fixed working directory, or absent when `askCwd` is true. */
  cwd?: string;
  /** True when the profile asks the page to choose one of `folders`. */
  askCwd: boolean;
  folders: LaunchFolder[];
  agent?: string;
  /** Names only: the values are read from the daemon at launch. */
  envFromDaemon: string[];
  readyText?: string;
  readyQuiet?: number;
  label?: string;
  purpose?: string;
  policy?: LaunchProfilePolicy;
  open: LaunchOpen;
}

export interface LauncherConfig {
  profiles: LaunchProfile[];
  /** Sentences naming each entry that did not load. Logged at daemon start. */
  problems: string[];
}

const PROFILE_KEYS = new Set([
  'name',
  'command',
  'args',
  'shell',
  'cwd',
  'folders',
  'agent',
  'envFromDaemon',
  'readyText',
  'readyQuiet',
  'label',
  'purpose',
  'policy',
  'open',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function entryLabel(index: number, raw: unknown): string {
  const name = isRecord(raw) ? raw['name'] : undefined;
  return isNonEmptyString(name)
    ? `launcher.profiles[${String(index)}] ("${name}")`
    : `launcher.profiles[${String(index)}]`;
}

/** A sentence naming the entry and why it did not load. */
function leftOut(index: number, raw: unknown, reason: string): string {
  return `${entryLabel(index, raw)} was left out: ${reason}`;
}

/**
 * The policy a profile's own `allow` and `deny` lists compile to. A deny rule
 * may refuse a line the global mode allowed; an `allow` list, when present,
 * must also match. There is no `mode` and no `maxSessions` here: a profile
 * cannot widen either.
 */
export function compileProfilePolicy(policy: LaunchProfilePolicy): CompiledPolicy {
  return compilePolicy({
    mode: policy.allow !== undefined ? 'allowlist' : 'denylist',
    ...(policy.allow !== undefined ? { allow: policy.allow } : {}),
    ...(policy.deny !== undefined ? { deny: policy.deny } : {}),
  });
}

/** Why a policy object is unusable, or null. */
function profilePolicyProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return 'policy must be an object with allow and deny lists';
  for (const key of Object.keys(raw)) {
    if (key !== 'allow' && key !== 'deny') {
      return `policy has an unknown key "${key}"; a profile cannot set mode or maxSessions`;
    }
  }
  for (const listName of ['allow', 'deny'] as const) {
    const list = raw[listName];
    if (list === undefined) continue;
    if (!isStringArray(list)) return `policy.${listName} must be an array of regex strings`;
    for (const source of list) {
      try {
        new RegExp(source, 'i');
      } catch {
        return `policy.${listName} has an invalid pattern "${source}"`;
      }
    }
  }
  return null;
}

function parseFolders(raw: unknown): { folders: LaunchFolder[] } | { problem: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { problem: 'cwd is "ask", so folders must be a non-empty array of { name, path }' };
  }
  const folders: LaunchFolder[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return { problem: `folders[${String(index)}] must be an object with name and path` };
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'name' && key !== 'path') {
        return { problem: `folders[${String(index)}] has an unknown key "${key}"` };
      }
    }
    const name = entry['name'];
    const folderPath = entry['path'];
    if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
      return {
        problem: `folders[${String(index)}].name must match ${PROFILE_NAME_PATTERN.source}`,
      };
    }
    if (seen.has(name)) {
      return { problem: `folders[${String(index)}].name "${name}" is used twice` };
    }
    seen.add(name);
    if (!isNonEmptyString(folderPath)) {
      return { problem: `folders[${String(index)}].path must be a non-empty string` };
    }
    folders.push({ name, path: folderPath });
  }
  return { folders };
}

/** Parse one entry. Returns the profile, or the sentence naming why not. */
export function parseLaunchProfile(
  raw: unknown,
  knownAgents: ReadonlySet<string>,
): { profile: LaunchProfile } | { problem: string } {
  if (!isRecord(raw)) return { problem: 'the entry must be an object' };

  for (const key of Object.keys(raw)) {
    if (PROFILE_KEYS.has(key)) continue;
    if (key === 'envNames' || key === 'passEnv') {
      return {
        problem:
          `"${key}" is not a profile key; the variables a caller may name at start are listed in ` +
          'config "envNames", and "agents.passEnv" lists the variables an agent\'s sessions receive',
      };
    }
    return { problem: `it has an unknown key "${key}"` };
  }

  const name = raw['name'];
  if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
    return { problem: `name must match ${PROFILE_NAME_PATTERN.source}` };
  }

  const command = raw['command'];
  if (!isNonEmptyString(command)) {
    return { problem: 'command must be a non-empty string' };
  }

  const args = raw['args'];
  if (args !== undefined && !isStringArray(args)) {
    return { problem: 'args must be an array of strings' };
  }

  const shell = raw['shell'];
  if (shell !== undefined && typeof shell !== 'boolean') {
    return { problem: 'shell must be true or false' };
  }

  const cwd = raw['cwd'];
  let askCwd = false;
  if (cwd !== undefined) {
    if (!isNonEmptyString(cwd)) return { problem: 'cwd must be a non-empty path or "ask"' };
    askCwd = cwd === 'ask';
  }

  let folders: LaunchFolder[] = [];
  if (askCwd) {
    const parsed = parseFolders(raw['folders']);
    if ('problem' in parsed) return parsed;
    folders = parsed.folders;
  } else if (raw['folders'] !== undefined) {
    return { problem: 'folders is only allowed when cwd is "ask"' };
  }

  const agent = raw['agent'];
  if (agent !== undefined) {
    if (typeof agent !== 'string' || !knownAgents.has(agent)) {
      return { problem: 'agent must be a built-in or configured signature name' };
    }
  }

  let envFromDaemon: string[] = [];
  const envNames = raw['envFromDaemon'];
  if (envNames !== undefined) {
    if (!isStringArray(envNames)) {
      return { problem: 'envFromDaemon must be an array of variable names' };
    }
    envFromDaemon = envNames.filter((entry) => ENV_NAME_PATTERN.test(entry));
  }

  const readyText = raw['readyText'];
  if (readyText !== undefined && !isNonEmptyString(readyText)) {
    return { problem: 'readyText must be a non-empty literal substring' };
  }
  const readyQuiet = raw['readyQuiet'];
  if (
    readyQuiet !== undefined &&
    (typeof readyQuiet !== 'number' || !Number.isFinite(readyQuiet) || readyQuiet < 0)
  ) {
    return { problem: 'readyQuiet must be a non-negative number of milliseconds' };
  }
  if (readyText !== undefined && readyQuiet !== undefined) {
    return { problem: 'readyText and readyQuiet cannot both be set' };
  }

  for (const key of ['label', 'purpose'] as const) {
    const value = raw[key];
    if (value !== undefined && !isNonEmptyString(value)) {
      return { problem: `${key} must be a non-empty string` };
    }
  }

  let policy: LaunchProfilePolicy | undefined;
  if (raw['policy'] !== undefined) {
    const problem = profilePolicyProblem(raw['policy']);
    if (problem !== null) return { problem };
    const source = raw['policy'] as Record<string, unknown>;
    policy = {
      ...(source['allow'] !== undefined ? { allow: source['allow'] as string[] } : {}),
      ...(source['deny'] !== undefined ? { deny: source['deny'] as string[] } : {}),
    };
  }

  const open = raw['open'] ?? 'grid';
  if (typeof open !== 'string' || !LAUNCH_OPEN_MODES.includes(open as LaunchOpen)) {
    return { problem: `open must be one of ${LAUNCH_OPEN_MODES.join(' | ')}` };
  }

  return {
    profile: {
      name,
      command,
      args: args ?? [],
      ...(typeof shell === 'boolean' ? { shell } : {}),
      ...(askCwd ? { askCwd: true } : { askCwd: false }),
      ...(askCwd || cwd === undefined ? {} : { cwd }),
      folders,
      ...(typeof agent === 'string' ? { agent } : {}),
      envFromDaemon,
      ...(typeof readyText === 'string' ? { readyText } : {}),
      ...(typeof readyQuiet === 'number' ? { readyQuiet } : {}),
      ...(typeof raw['label'] === 'string' ? { label: raw['label'] } : {}),
      ...(typeof raw['purpose'] === 'string' ? { purpose: raw['purpose'] } : {}),
      ...(policy !== undefined ? { policy } : {}),
      open: open as LaunchOpen,
    },
  };
}

/**
 * Read `launcher`. Every entry that fails is named in `problems` and left
 * out; the rest load. A launcher section that is not an object has no
 * profiles and says so, but does not touch policy.
 */
export function parseLauncher(
  raw: unknown,
  knownAgents: ReadonlySet<string>,
): { launcher: LauncherConfig; problems: string[] } {
  const problems: string[] = [];
  const profiles: LaunchProfile[] = [];

  if (!isRecord(raw)) {
    problems.push(
      'launcher must be an object with profiles (an array): no dashboard launch profiles are loaded',
    );
    return { launcher: { profiles, problems }, problems };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'profiles') {
      problems.push(`launcher has an unknown key "${key}": ignored (typo?)`);
    }
  }
  const entries = raw['profiles'];
  if (entries === undefined) {
    problems.push(
      'launcher has no profiles list: no dashboard launch profiles are loaded (an empty list is fine)',
    );
    return { launcher: { profiles, problems }, problems };
  }
  if (!Array.isArray(entries)) {
    problems.push(
      'launcher.profiles must be an array: no dashboard launch profiles are loaded',
    );
    return { launcher: { profiles, problems }, problems };
  }

  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const parsed = parseLaunchProfile(entry, knownAgents);
    if ('problem' in parsed) {
      problems.push(leftOut(index, entry, parsed.problem));
      continue;
    }
    const profile = parsed.profile;
    if (names.has(profile.name)) {
      problems.push(
        leftOut(index, entry, `the name "${profile.name}" is already used by an earlier profile`),
      );
      continue;
    }
    names.add(profile.name);

    const configured = isRecord(entry) ? entry['envFromDaemon'] : undefined;
    if (Array.isArray(configured)) {
      const dropped = configured.filter(
        (name): name is string => typeof name === 'string' && !ENV_NAME_PATTERN.test(name),
      );
      if (dropped.length > 0) {
        problems.push(
          `launcher.profiles[${String(index)}] ("${profile.name}"): ignoring envFromDaemon ` +
            `entries that are not variable names: ${dropped.map((name) => `"${name}"`).join(', ')}`,
        );
      }
    }
    profiles.push(profile);
  }

  return { launcher: { profiles, problems }, problems };
}

/**
 * The values a profile's `envFromDaemon` names take from the daemon's own
 * environment. Unset names are skipped: they do not refuse the start. A name
 * reserved for a connected feature's credential is skipped too, whatever
 * `sessionEnv` says. Only a name the source object owns, with a string value,
 * is copied: `constructor` and `toString` are inherited from
 * `Object.prototype` and are functions, not variables. The caller gets the
 * values to set and the names it copied; neither is logged by this function.
 */
export function copyDaemonEnv(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
  reserved: ReadonlySet<string> = RESERVED_FEATURE_CREDENTIALS,
): { env: Record<string, string>; copied: string[] } {
  const env: Record<string, string> = {};
  const copied: string[] = [];
  for (const name of names) {
    if (reserved.has(name)) continue;
    if (!Object.hasOwn(source, name)) continue;
    const value = source[name];
    if (typeof value !== 'string') continue;
    env[name] = value;
    copied.push(name);
  }
  return { env, copied };
}

/**
 * A profile's label or purpose with `{name}` and `{folder}` replaced. Only
 * those two are placeholders; any other braces stay as written. `folder` is
 * the selected folder's name, or empty when the profile uses a fixed
 * directory.
 */
export function expandProfileText(
  text: string,
  name: string,
  folder: string | undefined,
): string {
  return text.split('{name}').join(name).split('{folder}').join(folder ?? '');
}

/**
 * The same text for the profiles list, where `{folder}` depends on a click
 * that has not happened: `{name}` is filled in and `{folder}` is left for the
 * page to show.
 */
export function describeProfileText(text: string, name: string): string {
  return text.split('{name}').join(name);
}

/**
 * Resolve a profile's `command` to the absolute executable that will be
 * spawned, so that the file policy judged is the file that runs.
 *
 * A bare name is looked for on `PATH` only. The session's folder is never
 * searched, although `cmd.exe` — the Windows default shell — does search it:
 * a program planted in a configured folder would otherwise run in place of
 * the configured one while policy and the audit still saw the bare name. A
 * relative path that names a path (`bin\tool`, `.\tool`) is taken from the
 * profile's resolved folder, which is the directory the session starts in. A
 * quoted command (`"C:\Program Files\...\tool.exe"`) is resolved unquoted.
 *
 * On Windows the search follows `PATHEXT`, so an npm `.cmd` shim still
 * resolves. What is found is not required to be a program there: the shell
 * wrap can run a batch file, and `shell: false` refuses one later with its
 * own message. On POSIX the file must be executable.
 *
 * Returns the absolute path, or the sentence a refusal should carry.
 */
export function resolveLaunchCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string } | { error: string } {
  const isWindows = platform === 'win32';
  const pathApi = isWindows ? path.win32 : path.posix;
  const quoted = command.length >= 2 && command.startsWith('"') && command.endsWith('"');
  const written = quoted ? command.slice(1, -1) : command;
  if (written === '') return { error: 'the command is empty' };

  const usable = (candidate: string): boolean => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const extensions = isWindows
    ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
    : [];
  const candidatesFor = (base: string): string[] => {
    if (!isWindows) return [base];
    const alreadyExtended = extensions.some((entry) =>
      base.toLowerCase().endsWith(entry.toLowerCase()),
    );
    return alreadyExtended
      ? [base, ...extensions.map((entry) => base + entry)]
      : [...extensions.map((entry) => base + entry), base];
  };

  const explicitPath = /[\\/]/.test(written) || (isWindows && /^[a-z]:/i.test(written));
  if (explicitPath) {
    const rooted = pathApi.isAbsolute(written) ? written : pathApi.resolve(cwd, written);
    for (const candidate of candidatesFor(rooted)) {
      if (usable(candidate)) return { file: pathApi.resolve(candidate) };
    }
    return {
      error:
        `Not an executable file: ${written}${rooted === written ? '' : ` (${rooted})`}. ` +
        'Give an absolute path, or a name on PATH.',
    };
  }

  const searchDirs = (env['PATH'] ?? '')
    .split(isWindows ? ';' : ':')
    .filter((dir) => dir !== '');
  for (const dir of searchDirs) {
    for (const candidate of candidatesFor(pathApi.join(dir, written))) {
      if (usable(candidate)) return { file: pathApi.resolve(candidate) };
    }
  }
  return {
    error:
      `Command not found on PATH: ${written}. The session's folder is not searched; ` +
      'give an absolute path, or put the program on PATH.',
  };
}
