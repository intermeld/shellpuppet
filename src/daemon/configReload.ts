import { isDeepStrictEqual } from 'node:util';
import { compilePolicy } from '../core/policy.js';
import { ENV_NAME_PATTERN } from '../core/types.js';
import { DEFAULT_NUDGE_INTERVAL_MS, DEFAULT_NUDGES_PER_MINUTE, DEFAULT_VIEWER_LAUNCH_MODE,
  parseDaemonConfig, jsonErrorLocation, unknowableConfig } from './config.js';
import type { DaemonConfig, MessagingConfig } from './config.js';
import { DEFAULT_LAUNCHES_PER_MINUTE } from './launchProfiles.js';
import { ScheduleStore } from './schedules.js';
import type { ViewerLaunchMode } from './viewerLauncher.js';
import type { WatchHealth, ConfigRead } from './configWatcher.js';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface ConfigCandidate {
  text?: string;
  config: DaemonConfig;
  framing: boolean;
  problems: string[];
  reason?: string;
}

function safeProblem(problem: string): string {
  // Only schema literals and parser-generated array indices can reach reload diagnostics.
  const location = /^(messaging\.allow\[\d+\](?:\.(?:members|group|roles))?|launcher\.profiles\[\d+\]|agents\.signatures\[\d+\]|prompts\.dialogs\[\d+\]|launcher\.(?:launchesPerMinute|sessionLaunch|profiles)|agents\.passEnv|sessionEnv|envNames|idleMinutes|viewer|dashboard|policy|audit|daemon|launcher|messaging|schedules|prompts|agents|mcp)/.exec(problem)?.[1] ?? 'config.json';
  if (problem.startsWith('mcp.passEnv is not read')) return 'mcp.passEnv is unsupported. Use envNames or agents.passEnv.';
  if (location === 'launcher.launchesPerMinute') return 'launcher.launchesPerMinute must be an integer from 1 to 60.';
  if (location.startsWith('messaging.allow[') && problem.includes('ignoring members')) {
    return location + '.members contains an invalid participant name.';
  }
  if (problem.includes('unknown key')) return location + ' contains an unsupported key.';
  return location + ' contains an invalid value.';
}

function extraProblem(raw: Record<string, unknown>, config: DaemonConfig): string | undefined {
  const mcp = raw['mcp'];
  if (mcp !== undefined) {
    if (!record(mcp)) return 'mcp must be an object.';
    if (Object.keys(mcp).some(k => k !== 'untrustedFraming')) return 'mcp contains an unsupported key.';
    if (mcp['untrustedFraming'] !== undefined && typeof mcp['untrustedFraming'] !== 'boolean') return 'mcp.untrustedFraming must be a boolean.';
  }
  if (record(raw['audit']) && Object.keys(raw['audit']).some(k => k !== 'captureContent')) return 'audit contains an unsupported key.';
  const launcher = raw['launcher'];
  if (record(launcher) && Array.isArray(launcher['sessionLaunch']) &&
      new Set(launcher['sessionLaunch']).size !== launcher['sessionLaunch'].length) return 'launcher.sessionLaunch contains a duplicate name.';
  if (compilePolicy(config.policy).invalidPatterns.length) return 'policy contains an invalid regular expression.';
  if (Array.isArray(config.sessionEnv) && config.sessionEnv.some(n => !ENV_NAME_PATTERN.test(n))) return 'sessionEnv contains an invalid variable name.';
  const dialogs = record(raw['prompts']) ? raw['prompts']['dialogs'] : undefined;
  if (Array.isArray(dialogs) && dialogs.some(d => record(d) && Object.keys(d).some(k =>
    !['name', 'title', 'choices', 'within', 'below'].includes(k)))) return 'prompts.dialogs contains an unsupported key.';
  const signatures = record(raw['agents']) ? raw['agents']['signatures'] : undefined;
  if (Array.isArray(signatures) && signatures.some(s => record(s) && s['measured'] !== undefined &&
    typeof s['measured'] !== 'string')) return 'agents.signatures contains an invalid measured field.';
  // No configuration field takes a literal null. Some startup parsers use ?? for defaults.
  const values: unknown[] = [raw];
  while (values.length) {
    const value = values.pop();
    if (value === null) return 'config.json contains an invalid null value.';
    if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) values.push(child);
  }
  return undefined;
}

export function parseConfigCandidate(text?: string): ConfigCandidate {
  let raw: unknown;
  if (text !== undefined) {
    try { raw = JSON.parse(text) as unknown; }
    catch {
      const { line, column } = jsonErrorLocation(text);
      const reason = 'Invalid JSON at line ' + String(line) + ', column ' + String(column) + '.';
      return { ...unavailableConfig(reason), text };
    }
  }
  const parsed = parseDaemonConfig(raw);
  const mcp = record(raw) ? raw['mcp'] : undefined;
  const framing = !record(mcp) || mcp['untrustedFraming'] !== false;
  const problem = parsed.problems.find(p =>
    p !== 'messaging is enabled without allow rules: no participants may message each other' &&
    !p.startsWith('messaging member "') &&
    p !== 'launcher has no profiles list: no dashboard launch profiles are loaded (an empty list is fine)');
  const reason = parsed.scheduleRejection ?? (problem ? safeProblem(problem) : record(raw) ? extraProblem(raw, parsed.config) : undefined);
  return { ...parsed, framing, text, reason };
}

export function unavailableConfig(reason: string): ConfigCandidate {
  return { ...unknowableConfig(reason, reason + ' Refusing all commands.'), reason, framing: true };
}

function fields(candidate: ConfigCandidate, defaultViewer: ViewerLaunchMode) {
  const c = candidate.config;
  return {
    'agents.passEnv': c.agentPassEnv ?? {}, 'agents.signatures': c.agentSignatures ?? [],
    'audit.captureContent': c.audit?.captureContent ?? false, 'daemon.startWith': c.daemon?.startWith,
    'daemon.startWithOnlyIfEnvContains': c.daemon?.startWithOnlyIfEnvContains,
    'dashboard.fontSize': c.dashboard?.fontSize, envNames: c.envNames ?? [], idleMinutes: c.idleMinutes ?? 30,
    'launcher.profiles': c.launcher?.profiles ?? [], 'launcher.sessionLaunch': c.launcher?.sessionLaunch ?? [],
    'mcp.untrustedFraming': candidate.framing, 'policy.mode': c.policy?.mode ?? 'allow-all',
    'policy.allow': c.policy?.allow ?? [], 'policy.deny': c.policy?.deny ?? [],
    'policy.maxSessions': c.policy?.maxSessions, 'prompts.dialogs': c.dialogs ?? [], sessionEnv: c.sessionEnv ?? 'clean',
    'viewer.browserPath': c.viewer?.browserPath, 'viewer.profileDir': c.viewer?.profileDir,
    'viewer.launchMode': c.viewer?.launchMode ?? defaultViewer,
    'launcher.launchesPerMinute': c.launcher?.launchesPerMinute ?? DEFAULT_LAUNCHES_PER_MINUTE,
    schedules: c.schedules ?? [], messaging: {
      enabled: false, allow: [], nudgeIntervalMs: DEFAULT_NUDGE_INTERVAL_MS, nudgesPerMinute: DEFAULT_NUDGES_PER_MINUTE,
      claimIdleMinutes: 30, ...c.messaging,
    } satisfies MessagingConfig,
  };
}

type Fields = ReturnType<typeof fields>;
const live = new Set(['launcher.launchesPerMinute', 'schedules']);

function differences(a: Fields, b: Fields): (keyof Fields)[] {
  return (Object.keys(a) as (keyof Fields)[]).filter(key => !isDeepStrictEqual(a[key], b[key]));
}

export interface ConfigReloadStatus {
  revision: number;
  outcome: 'applied' | 'pending' | 'unchanged' | 'rejected' | 'degraded startup';
  lastAttempt: string;
  lastAccepted: string | null;
  watcher: WatchHealth;
  reason?: string;
  needsDaemonRestart: string[];
}

/** Only the daemon owning the home constructs and publishes this snapshot. */
export class ConfigReload {
  private readonly boot: Fields;
  private desired: Fields;
  private previousText?: string;
  private hadFile: boolean;
  private readFailed = false;
  state: { schedules: ScheduleStore; launchesPerMinute: number; messaging: MessagingConfig };
  status: ConfigReloadStatus;

  constructor(candidate: ConfigCandidate, private readonly hooks: {
    audit(action: string, sections: string[]): void;
    log(message: string, reason?: string): void;
    ownsHome(): boolean;
    changed(sections: string[]): void;
  }, private readonly defaultViewer: ViewerLaunchMode = DEFAULT_VIEWER_LAUNCH_MODE) {
    this.desired = this.boot = fields(candidate, this.defaultViewer);
    this.previousText = candidate.text;
    this.hadFile = candidate.text !== undefined || candidate.reason !== undefined;
    const schedules = new ScheduleStore();
    schedules.replace(candidate.config.schedules);
    this.state = { schedules, launchesPerMinute: this.boot['launcher.launchesPerMinute'], messaging: this.boot.messaging };
    const now = new Date().toISOString();
    this.status = { revision: candidate.reason ? 0 : 1, outcome: candidate.reason ? 'degraded startup' : 'unchanged',
      reason: candidate.reason, lastAttempt: now, lastAccepted: candidate.reason ? null : now,
      watcher: 'stopped', needsDaemonRestart: [] };
  }

  reject(reason: string): void {
    this.readFailed = true;
    if (this.status.reason !== reason) this.hooks.log('Config rejected', reason);
    this.status = { ...this.status, outcome: 'rejected', lastAttempt: new Date().toISOString(), reason };
  }

  reconcile(read: ConfigRead): void {
    if (!this.hooks.ownsHome()) return;
    if (read.text === undefined && this.hadFile) { this.reject('config.json missing, previous settings active.'); return; }
    if (read.text === this.previousText && !this.readFailed) return;
    const candidate = parseConfigCandidate(read.text);
    if (candidate.reason) {
      this.reject(candidate.reason);
      this.previousText = read.text;
      this.readFailed = false;
      return;
    }
    const desired = fields(candidate, this.defaultViewer);
    const changed = differences(this.desired, desired);
    const pending = differences(this.boot, desired).filter(k => !live.has(k)).sort();
    const applied = changed.some(k => live.has(k));
    const sections = [...new Set(changed.map(k => k.split('.')[0]!))].sort();
    const state = { ...this.state,
      launchesPerMinute: desired['launcher.launchesPerMinute'],
      schedules: changed.includes('schedules') ? this.state.schedules.withSchedules(desired.schedules) : this.state.schedules };
    const now = new Date().toISOString();
    const status: ConfigReloadStatus = { revision: Math.max(1, this.status.revision + Number(applied)),
      lastAttempt: now, lastAccepted: now, watcher: this.status.watcher, needsDaemonRestart: pending,
      outcome: applied ? 'applied' : sections.length ? 'pending' : 'unchanged' };
    if (!this.hooks.ownsHome() || !read.current()) return;
    if (sections.length) {
      try { this.hooks.audit(applied ? 'config-reload' : 'config-pending', sections); }
      catch { this.reject('Could not append the required configuration audit record.'); return; }
    }
    this.state = state;
    this.desired = desired;
    this.status = status;
    this.hadFile ||= read.text !== undefined;
    this.previousText = read.text;
    this.readFailed = false;
    if (sections.length) {
      this.hooks.log(applied ? 'Configuration applied' : 'Configuration needs daemon restart');
      try { this.hooks.changed(sections); }
      catch { this.hooks.log('Could not notify every configuration subscriber.'); }
    }
  }
}
