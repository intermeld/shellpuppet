import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ConfigPermissions, ConfigWatcher } from '../../src/daemon/configWatcher.js';
import { makeTempHome, removeTempHome } from '../integration/helpers.js';
import { ConfigReload, parseConfigCandidate } from '../../src/daemon/configReload.js';

it.each([
  { launcher: { launchesPerMinute: 4, sessionLaunch: [42] } }, { mcp: null }, { mcp: { unknown: true } },
  { audit: { unknown: true } }, { policy: { mode: 'allow-all', deny: ['['] } },
  { sessionEnv: ['bad name'] }, { launcher: { profiles: [{ name: 'desk', command: 'node', envFromDaemon: [42] }] } },
  { agents: { signatures: [{ name: 'desk', measured: 42, answer: { start: { text: 'x' } }, composer: { text: '>' } }] } },
  { prompts: { dialogs: [{ name: 'x', title: 'x', choices: 'x', unknown: true }] } },
  { daemon: { startWithOnlyIfEnvContains: false } },
])('rejects a malformed field even when its section is inactive', raw => {
  expect(parseConfigCandidate(JSON.stringify(raw)).reason).toBeDefined();
});

it.each([
  { launcher: { launchesPerMinute: 4 } }, { messaging: { enabled: true } },
  { viewer: { launchMode: 'none' } },
  { launcher: { profiles: [{ name: 'desk', command: 'node' }] },
    messaging: { enabled: true, allow: [{ group: 'work', members: ['desk'] }] } },
])('accepts defaults, aliases and valid advisory cases', raw => {
  expect(parseConfigCandidate(JSON.stringify(raw)).reason).toBeUndefined();
});

it('retains independent diagnostics when invalid settings get safe defaults', () => {
  const policy = { maxSessions: 0, allow: [false, '[example'], deny: ['valid', '[example'] };
  const candidate = parseConfigCandidate(JSON.stringify({ policy, sessionEnv: [false, 'invalid name'] }));
  expect(candidate.config.policy?.configError).toBeDefined();
  expect(candidate.config.sessionEnv).toBe('clean');
  expect(candidate.diagnostics).toEqual(expect.arrayContaining([
    'policy.allow contains an invalid value.', 'policy.maxSessions contains an invalid value.',
    'policy.allow[1] does not compile.', 'policy.deny[1] does not compile.',
    'sessionEnv contains an invalid variable name.',
  ]));
  expect(candidate.diagnostics.join(' ')).not.toMatch(/example|invalid name/);
});

it('coalesces rename bursts, retries a failed watch, notices lost events and cancels outstanding reads', async () => {
  vi.useFakeTimers();
  let changed!: (name: string | null) => void;
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  let registrations = 0;
  let value = 'one';
  let release: (() => void) | undefined;
  const seen: string[] = [];
  const health: string[] = [];
  const reader = new ConfigWatcher({
    watch: callback => {
      changed = callback;
      if (++registrations === 1) throw new Error('unavailable');
      return watcher;
    },
    read: async () => {
      const text = value;
      if (value === 'slow') await new Promise<void>(resolve => { release = resolve; });
      return { text, current: () => value === text };
    },
    receive: candidate => { seen.push(candidate.text!); },
    fail: () => undefined,
    health: state => { health.push(state); },
  });
  try {
    await reader.start();
    expect(seen).toEqual(['one']);
    expect(health).toContain('polling');
    value = 'two';
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.at(-1)).toBe('two');
    expect(health.at(-1)).toBe('watching');
    value = 'three';
    changed('other');
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.at(-1)).toBe('two');
    changed(null);
    await vi.advanceTimersByTimeAsync(50);
    changed('config.json');
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.at(-1)).toBe('three');
    value = 'slow';
    changed('config.json');
    await vi.advanceTimersByTimeAsync(100);
    value = 'latest';
    changed('config.json');
    release!();
    await vi.advanceTimersByTimeAsync(101);
    expect(seen).not.toContain('slow');
    expect(seen.at(-1)).toBe('latest');
    value = 'slow';
    changed(null);
    await vi.advanceTimersByTimeAsync(100);
    reader.stop();
    release!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen.at(-1)).toBe('latest');
  } finally { reader.stop(); vi.useRealTimers(); }
});

it.skipIf(process.platform === 'win32')('rejects links and permission-only changes and detects replacement before publication', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  const reader = new ConfigPermissions(home);
  try {
    await reader.secureHome();
    const original = await reader.read();
    expect(original.current()).toBe(true);
    fs.renameSync(file, file + '.old');
    fs.symlinkSync(file + '.old', file);
    expect(original.current()).toBe(false);
    await expect(reader.read()).rejects.toThrow(/permission/i);
    fs.unlinkSync(file);
    fs.renameSync(file + '.old', file);
    fs.chmodSync(file, 0o666);
    await expect(reader.read()).rejects.toThrow(/permission/i);
  } finally { reader.close(); removeTempHome(home); }
});

it.skipIf(process.platform === 'win32')('hardens and reads a home selected through a final symlink', async () => {
  const root = makeTempHome();
  const directory = join(root, 'directory');
  const alias = join(root, 'selected');
  fs.mkdirSync(directory);
  fs.writeFileSync(join(directory, 'config.json'), '{}', { mode: 0o600 });
  // The owner can repair a directory even when its current mode prevents listing it.
  fs.chmodSync(directory, 0o300);
  fs.symlinkSync(directory, alias);
  const reader = new ConfigPermissions(alias);
  try {
    expect(await reader.secureHome()).toBe(fs.realpathSync.native(directory));
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect((await reader.read()).text).toBe('{}');
  } finally { reader.close(); removeTempHome(root); }
});

it.skipIf(process.platform === 'win32')('hardens and reads the filesystem destination of parent traversal', async () => {
  const root = makeTempHome();
  const target = join(root, 'real', 'home');
  const lexical = join(root, 'home');
  fs.mkdirSync(join(root, 'real', 'child'), { recursive: true });
  fs.symlinkSync(join(root, 'real', 'child'), join(root, 'alias'));
  for (const dir of [target, lexical]) {
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(join(dir, 'config.json'), JSON.stringify({ directory: dir }));
  }
  // Preserve ".." for the filesystem to resolve after following the intermediate link.
  const reader = new ConfigPermissions(root + '/alias/../home');
  try {
    expect(await reader.secureHome()).toBe(fs.realpathSync.native(target));
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(fs.statSync(lexical).mode & 0o777).toBe(0o755);
    expect((await reader.read()).text).toBe(fs.readFileSync(join(target, 'config.json'), 'utf8'));
    fs.renameSync(target, target + '-old');
    fs.mkdirSync(target, { mode: 0o700 });
    await expect(reader.read()).rejects.toThrow(/permission/i);
  } finally { reader.close(); removeTempHome(root); }
});

it('holds an in-flight schedule through invalid siblings and invalidates it on accepted removal', async () => {
  const { PromptScheduler } = await import('../../src/daemon/schedules.js');
  const entry = { name: 'waiting', session: 'worker', cron: '* * * * *', message: 'work', whenBusy: 'queue' };
  let owns = true;
  const audit = vi.fn();
  const reload = new ConfigReload(parseConfigCandidate(JSON.stringify({ schedules: [entry] })),
    { ownsHome: () => owns, audit, changed: () => undefined, log: () => undefined });
  const save = (raw: unknown) => reload.reconcile({ text: JSON.stringify(raw), current: () => true });
  let now = 0;
  let current!: () => boolean;
  let finish!: () => void;
  const scheduler = new PromptScheduler(() => reload.state.schedules, () => now, async (_schedule, valid) => {
    current = valid;
    await new Promise<void>(resolve => { finish = resolve; });
    return { outcome: 'aborted' };
  }, () => undefined);
  scheduler.start();
  try {
    now = 60_000;
    const tick = scheduler.tick();
    save({ schedules: [entry, { ...entry, name: 'bad', cron: 'invalid' }] });
    expect(current()).toBe(true);
    expect(reload.status.outcome).toBe('rejected');
    save({ schedules: [entry], launcher: { launchesPerMinute: 9 } });
    expect(current()).toBe(true);
    owns = false;
    save({});
    expect(current()).toBe(true);
    owns = true;
    save({});
    expect(current()).toBe(false);
    expect(audit).toHaveBeenCalledTimes(2);
    finish();
    await tick;
  } finally { scheduler.stop(); }
});

it('keeps degraded startup distinct from a successful repair', () => {
  const initial = JSON.stringify({ schedules: [], messaging: { enabled: true, allow: 7 }, policy: { allow: 3 } });
  const reload = new ConfigReload(parseConfigCandidate(initial),
    { ownsHome: () => true, audit: vi.fn(), changed: () => undefined, log: () => undefined });
  reload.reconcile({ text: initial, current: () => true });
  expect(reload.status).toMatchObject({ revision: 0, outcome: 'degraded startup', lastAccepted: null });
  const repaired = { messaging: { enabled: true }, launcher: { launchesPerMinute: 7 } };
  reload.reconcile({ text: JSON.stringify(repaired), current: () => true });
  expect(reload.state.launchesPerMinute).toBe(7);
  expect(reload.state.messaging.enabled).toBe(false);
  expect(reload.status.lastAccepted).toBeTypeOf('string');
  expect(reload.status).toMatchObject({ revision: 1, outcome: 'applied',
    needsDaemonRestart: ['messaging', 'policy.mode'] });
});
