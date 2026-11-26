import * as fs from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { readDaemonState } from '../../src/daemon/paths.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { viewerCookie } from '../../src/daemon/auth.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { api, eventually, makeTempHome, removeTempHome, distDaemonEntry, repoRoot, startTestDaemon } from './helpers.js';

it('accepts one whole revision, preserves rejected and pending state, and redacts diagnostics', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  const log = join(home, 'daemon.log');
  const schedule = { name: 'job', session: 'desk', cron: '* * * * *', message: 'private-sentinel', whenBusy: 'skip' };
  const initial = { schedules: [schedule], launcher: { launchesPerMinute: 2 } };
  const save = (raw: unknown) => fs.writeFileSync(file, JSON.stringify(raw));
  save(initial);
  const td = await startTestDaemon({ home, logger: createFileLogger(log), audit: createAuditor(home) });
  const status = async () => (await api(td.port, td.token, '/environment')).body['configReload'] as
    { revision: number; outcome: string; reason?: string; needsDaemonRestart: string[] };
  const audits = () => fs.readFileSync(join(home, 'audit.log'), 'utf8').split('\n')
    .filter(l => l.includes('"config-reload"')).map(l => JSON.parse(l) as { meta: unknown });
  const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath,
    [join(repoRoot, 'dist/cli/index.js'), 'daemon', 'status', ...args], { env: { ...process.env, SHELLPUPPET_HOME: home } })).stdout;
  try {
    const original = td.daemon['schedules'].get('job');
    expect(original).toBeDefined();
    const changed = { launcher: { launchesPerMinute: 3 }, schedules: [], viewer: { browserPath: 'private-sentinel' } };
    for (const invalid of [
      { messaging: { enabled: true, allow: [{ group: 'work', members: ['!!private-sentinel'] }] } },
      { mcp: { untrustedFraming: 3 } }, { policy: { deny: ['[private-sentinel'] } },
      { launcher: { profiles: [{ command: 'private-sentinel' }] } }, { audit: { 'private-sentinel': true } },
      { schedules: [schedule, schedule] }, { launcher: { launchesPerMinute: 0 } },
    ]) {
      save({ ...changed, ...invalid });
      await eventually(async () => (await status())?.outcome === 'rejected', 8000, 100, Object.keys(invalid).join(', '), () => td.daemon['reload']?.status);
      expect(td.daemon['schedules'].get('job')).toBe(original);
      expect(td.daemon['launchesPerMinute']).toBe(2);
      expect((await status()).revision).toBe(1);
      save(initial);
      await eventually(async () => (await status()).outcome === 'unchanged', 3000);
    }
    expect(audits()).toHaveLength(0);
    save(changed);
    await eventually(async () => (await status()).revision === 2, 3000);
    expect(td.daemon['launchesPerMinute']).toBe(3);
    expect(td.daemon['schedules'].read()).toEqual([]);
    expect((await status()).needsDaemonRestart).toEqual(['viewer.browserPath']);
    expect(audits()).toEqual([expect.objectContaining({ meta: { sections: ['launcher', 'schedules', 'viewer'] } })]);
    fs.writeFileSync(file, '{');
    await eventually(async () => (await status()).outcome === 'rejected', 3000);
    const plain = await cli();
    const json = JSON.parse(await cli('--json')) as { configReload: unknown };
    expect(plain).toMatch(/invalid JSON/i);
    expect(plain).toMatch(/needs daemon restart.*viewer.browserPath/i);
    expect(json.configReload).toMatchObject({ outcome: 'rejected', revision: 2, needsDaemonRestart: ['viewer.browserPath'] });
    expect((await api(td.port, null, '/environment')).status).toBe(401);
    const tokens = td.daemon['tokens'];
    const viewer = tokens.redeemViewerGrant(tokens.mintViewerGrant('sample'))!;
    const cookie = viewerCookie(viewer.sessionId, viewer.streamToken).split(';')[0]!;
    expect((await api(td.port, null, '/environment', { headers: { cookie } })).status).toBe(401);
    expect((await api(td.port, null, '/health')).body).not.toHaveProperty('configReload');
    fs.unlinkSync(file);
    await eventually(async () => (await status()).reason?.includes('missing') === true, 3000);
    expect((await status()).revision).toBe(2);
    save({});
    await eventually(async () => (await status()).revision === 3, 3000);
    expect((await status()).needsDaemonRestart).toEqual([]);
    expect(td.daemon['launchesPerMinute']).toBe(8);
    expect([plain, JSON.stringify(json), fs.readFileSync(log, 'utf8'), JSON.stringify(audits())].join('')).not.toContain('private-sentinel');
  } finally { await td.stop(); }
}, 60_000);

it('retries a required audit failure and retains schedule identity across an unrelated save', async () => {
  const home = makeTempHome();
  const schedule = { name: 'job', session: 'desk', cron: '* * * * *', message: 'work', whenBusy: 'queue' };
  const file = join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ schedules: [schedule] }));
  const audit = createAuditor(home);
  let fail = true;
  const td = await startTestDaemon({ home, audit: { ...audit, recordRequired(...args) {
    if (args[1] === 'config-reload' && fail) throw new Error('private-sentinel');
    audit.recordRequired!(...args);
  } } });
  const status = async () => (await api(td.port, td.token, '/environment')).body['configReload'] as
    { outcome: string; reason?: string; revision: number };
  try {
    const original = td.daemon['schedules'].get('job');
    fs.writeFileSync(file, JSON.stringify({ schedules: [schedule], launcher: { launchesPerMinute: 4 } }));
    await eventually(async () => (await status())?.outcome === 'rejected', 3000);
    expect(await status()).toMatchObject({ revision: 1 });
    expect((await status()).reason).toMatch(/audit/i);
    expect(td.daemon['launchesPerMinute']).toBe(8);
    fail = false;
    await eventually(async () => (await status()).revision === 2, 4000);
    expect(td.daemon['schedules'].get('job')).toBe(original);
    expect(td.daemon['launchesPerMinute']).toBe(4);
  } finally { await td.stop(); }
}, 20_000);

it('tracks pending-only edits and their reversals without adopting the new launch authority', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  fs.writeFileSync(file, '{}');
  const td = await startTestDaemon({ home, audit: createAuditor(home) });
  const status = async () => (await api(td.port, td.token, '/environment')).body['configReload'] as
    { revision: number; needsDaemonRestart: string[] };
  try {
    const candidate = { launcher: { profiles: [{ name: 'job', command: process.execPath }], sessionLaunch: ['desk'] },
      daemon: { startWith: ['node'] }, policy: { mode: 'denylist' }, sessionEnv: 'passthrough',
      envNames: ['LOCAL_MARK'], agents: { signatures: [{ name: 'desk-reader', composer: { text: 'Input' },
        answer: { start: { text: 'Answer' } } }], passEnv: { 'desk-reader': ['LOCAL_MARK'] } },
      prompts: { dialogs: [{ name: 'local', title: 'Title', choices: 'Choice' }] },
      viewer: { profileDir: 'local' }, dashboard: { fontSize: 18 }, idleMinutes: 1,
      audit: { captureContent: true }, mcp: { untrustedFraming: false } };
    fs.writeFileSync(file, JSON.stringify(candidate));
    await eventually(async () => (await status())?.needsDaemonRestart.length > 0, 8000, 100, 'pending fields', () => td.daemon['reload']?.status);
    expect((await status()).needsDaemonRestart.sort()).toEqual([
      'agents.passEnv', 'agents.signatures', 'audit.captureContent', 'daemon.startWith', 'dashboard.fontSize', 'envNames',
      'idleMinutes', 'launcher.profiles', 'launcher.sessionLaunch', 'mcp.untrustedFraming', 'policy.mode',
      'prompts.dialogs', 'sessionEnv', 'viewer.profileDir',
    ]);
    expect(td.daemon['launchProfiles'].profiles).toEqual([]);
    expect((await api(td.port, td.token, '/environment')).body['mode']).toBe('clean');
    const before = await status();
    fs.writeFileSync(file, JSON.stringify({ ...candidate, port: 123 }));
    await eventually(async () => ((await api(td.port, td.token, '/environment')).body['configReload'] as
      { outcome: string }).outcome === 'rejected', 3000);
    expect((await status()).needsDaemonRestart).toEqual(before.needsDaemonRestart);
    fs.writeFileSync(file, '{}');
    await eventually(async () => (await status()).needsDaemonRestart.length === 0, 3000);
  } finally { await td.stop(); }
}, 20_000);

it.skipIf(process.platform !== 'win32')('rechecks Windows file permissions on identical bytes and accepts an inherited private replacement', async () => {
  const home = makeTempHome();
  const td = await startTestDaemon({ home });
  const file = join(home, 'config.json');
  const icacls = join(process.env['SystemRoot']!, 'System32', 'icacls.exe');
  const status = () => td.daemon['reload']!.status;
  try {
    const before = status().revision;
    await promisify(execFile)(icacls, [file, '/grant', '*S-1-5-32-544:R', '/Q'], { windowsHide: true });
    await eventually(() => status().outcome === 'rejected', 8000);
    expect(status().reason).toMatch(/permission/i);
    expect(status().revision).toBe(before);
    fs.writeFileSync(file + '.new', fs.readFileSync(file));
    fs.renameSync(file + '.new', file);
    await eventually(() => status().outcome === 'unchanged', 8000);
    expect(status().revision).toBe(before);
  } finally { await td.stop(); }
}, 30_000);

it('keeps configured names and regex text out of startup diagnostics and subsequent reloads', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  const log = join(home, 'daemon.log');
  const viewer = { launchMode: 'no-window' };
  const pattern = '[private-pattern-sentinel';
  const schedules = [{ name: 'private-schedule-sentinel', session: 'desk', cron: 'invalid', message: 'private-message-sentinel' }];
  const prompts = { dialogs: [{ name: 'private-dialog-sentinel', title: pattern, choices: 'Choice' }] };
  const agents = { signatures: [{ name: 'private-agent-sentinel', composer: { text: pattern }, answer: { start: { text: 'Answer' } } }] };
  fs.writeFileSync(file, JSON.stringify({ viewer, schedules, prompts, agents }));
  const child = spawn(process.execPath, [distDaemonEntry], {
    env: { ...process.env, SHELLPUPPET_HOME: home }, windowsHide: true, stdio: 'ignore',
  });
  const ended = once(child, 'exit');
  try {
    const logs = () => fs.readFileSync(log, 'utf8');
    const locations = ['schedules[0]', 'prompts.dialogs[0]', 'agents.signatures[0]'];
    await eventually(() => fs.existsSync(log) && locations.every(location => logs().includes(location)), 15_000);
    const state = readDaemonState(home)!;
    const status = async () => (await api(state.port, state.token, '/environment')).body['configReload'] as
      { outcome: string; reason?: string };
    expect(logs()).not.toContain('-sentinel');
    expect(logs()).toContain('CONFIG PROBLEM');
    expect(await status()).toMatchObject({ outcome: 'degraded startup' });
    for (const [section, invalid] of [['prompts.dialogs[0]', { prompts }], ['agents.signatures[0]', { agents }],
      ['schedules[0]', { schedules }]] as const) {
      fs.writeFileSync(file, JSON.stringify({ viewer, ...invalid }));
      await eventually(async () => (await status()).reason?.includes(section) === true, 5000);
      expect(JSON.stringify(await status())).not.toContain('-sentinel');
    }
    expect(logs()).not.toContain('-sentinel');
  } finally {
    const state = readDaemonState(home);
    try {
      if (state) await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } });
      else child.kill();
    } catch { child.kill(); }
    await ended;
    removeTempHome(home);
  }
}, 45_000);
