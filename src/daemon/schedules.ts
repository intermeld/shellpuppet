import { parseCron } from '../core/cron.js';
import type { Cron } from '../core/cron.js';
import { NAME_PATTERN } from '../core/mailbox.js';

export interface Schedule {
  readonly name: string;
  readonly session: string;
  readonly cron: string;
  readonly message: string;
  readonly whenBusy: 'skip' | 'queue';
  readonly enabled: boolean;
}

interface Entry {
  readonly config: Schedule;
  readonly expression: Cron;
}

interface ScheduleChanges {
  problems: string[];
  /** Fixed schema paths and validator reasons, safe to show on reload. */
  diagnostics: string[];
  added: string[];
  changed: string[];
  removed: string[];
}

const keys = new Set(['name', 'session', 'cron', 'message', 'whenBusy', 'enabled']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(raw: unknown, duplicates: Set<string>): Entry | string {
  if (!isRecord(raw)) return 'must be an object';
  const { name, session, cron, message, whenBusy, enabled = true } = raw;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) return 'name must be kebab-case';
  if (duplicates.has(name)) return 'name must be unique';
  if (Object.keys(raw).some(key => !keys.has(key))) return 'contains an unknown key';
  if (typeof session !== 'string' || !NAME_PATTERN.test(session)) return 'session must be a valid session name';
  const expression = typeof cron === 'string' ? parseCron(cron) : null;
  if (typeof cron !== 'string' || !expression) return 'cron must contain five valid numeric cron fields';
  if (typeof message !== 'string' || !message.length || Array.from(message).length > 2000 ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(message)) return 'message must be one line of 1 to 2000 characters without controls';
  if (whenBusy !== 'skip' && whenBusy !== 'queue') return 'whenBusy must be skip or queue';
  if (typeof enabled !== 'boolean') return 'enabled must be a boolean';
  return { config: Object.freeze({ name, session, cron, message, whenBusy, enabled }), expression };
}

/** Replacing the section preserves the identity of unchanged schedules during delivery. */
export class ScheduleStore {
  private entries = new Map<string, Entry>();

  read(): readonly Schedule[] { return [...this.entries.values()].map(entry => entry.config); }
  get(name: string): Entry | undefined { return this.entries.get(name); }

  withSchedules(section: readonly Schedule[]): ScheduleStore {
    const next = new ScheduleStore();
    next.entries = this.entries;
    next.replace(section);
    return next;
  }

  replace(section: unknown): ScheduleChanges {
    const changes: ScheduleChanges = { problems: [], diagnostics: [], added: [], changed: [], removed: [] };
    if (section === undefined) section = [];
    if (!Array.isArray(section)) {
      changes.diagnostics.push('schedules must be an array');
      changes.problems.push('schedules must be an array');
      return changes;
    }
    const names = new Set<string>();
    const duplicates = new Set<string>();
    for (const raw of section as unknown[]) {
      if (isRecord(raw) && typeof raw['name'] === 'string') {
        if (names.has(raw['name'])) duplicates.add(raw['name']);
        names.add(raw['name']);
      }
    }
    const next = new Map<string, Entry>();
    for (const [index, raw] of (section as unknown[]).entries()) {
      const entry = validate(raw, duplicates);
      if (typeof entry === 'string') {
        changes.diagnostics.push(`schedules[${String(index)}] invalid: ${entry}.`);
        const name = isRecord(raw) && typeof raw['name'] === 'string' ? JSON.stringify(raw['name']) : String(index);
        changes.problems.push(`schedules[${name}] ${entry}`);
        continue;
      }
      const name = entry.config.name;
      const old = this.entries.get(name);
      if (old && JSON.stringify(old.config) === JSON.stringify(entry.config)) next.set(name, old);
      else {
        (old ? changes.changed : changes.added).push(name);
        next.set(name, entry);
      }
    }
    changes.removed = [...this.entries.keys()].filter(name => !next.has(name));
    this.entries = next;
    return changes;
  }
}

export interface ScheduleOutcome {
  outcome: 'sent' | 'queued' | 'skipped' | 'aborted';
  reason?: string;
  sessionId?: string;
}

type LastOutcome = Pick<ScheduleOutcome, 'outcome' | 'reason'> & { at: string };
export interface ListedSchedule extends Omit<Schedule, 'message'> {
  nextRunUtc: string | null;
  lastOutcome: LastOutcome | null;
}

export class PromptScheduler {
  private timer?: NodeJS.Timeout;
  private lastMinute = -Infinity;
  private readonly running = new Set<string>();
  private readonly last = new WeakMap<Schedule, LastOutcome>();

  private get store(): ScheduleStore {
    return typeof this.source === 'function' ? this.source() : this.source;
  }

  constructor(private readonly source: ScheduleStore | (() => ScheduleStore), private readonly now: () => number,
    private readonly deliver: (schedule: Schedule, current: () => boolean) => Promise<ScheduleOutcome>,
    private readonly audit: (schedule: Schedule, result: ScheduleOutcome) => void) {}

  start(): void {
    this.lastMinute = Math.floor(this.now() / 60_000);
    const arm = (): void => {
      this.timer = setTimeout(() => { arm(); void this.tick(); }, 60_000 - this.now() % 60_000);
      this.timer.unref();
    };
    arm();
  }

  stop(): void { clearTimeout(this.timer); this.timer = undefined; }

  async tick(): Promise<void> {
    const time = new Date(this.now());
    const minute = Math.floor(time.getTime() / 60_000);
    if (this.timer === undefined || minute <= this.lastMinute) return;
    this.lastMinute = minute;
    await Promise.all(this.store.read().map(async schedule => {
      if (!schedule.enabled || !this.store.get(schedule.name)!.expression.matches(time)) return;
      let result: ScheduleOutcome;
      if (this.running.has(schedule.name)) result = { outcome: 'skipped', reason: 'pending' };
      else {
        this.running.add(schedule.name);
        const current = () => this.timer !== undefined && Math.floor(this.now() / 60_000) === minute &&
          this.store.get(schedule.name)?.config === schedule;
        try { result = await this.deliver(schedule, current); }
        catch { result = { outcome: 'aborted', reason: 'delivery-failed' }; }
        finally { this.running.delete(schedule.name); }
      }
      const { outcome, reason } = result;
      const at = time.toISOString();
      if ((this.last.get(schedule)?.at ?? '') <= at) this.last.set(schedule, { at, outcome, reason });
      this.audit(schedule, result);
    }));
  }

  list(): ListedSchedule[] {
    const now = new Date(this.now());
    return this.store.read().map(schedule => {
      const { name, session, cron, whenBusy, enabled } = schedule;
      return { name, session, cron, whenBusy, enabled, lastOutcome: this.last.get(schedule) ?? null,
        nextRunUtc: enabled ? this.store.get(name)!.expression.next(now)?.toISOString() ?? null : null };
    });
  }
}
