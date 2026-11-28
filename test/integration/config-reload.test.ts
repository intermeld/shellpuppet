import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readDaemonState } from '../../src/daemon/paths.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseConfigCandidate } from '../../src/daemon/configReload.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { Daemon } from '../../src/daemon/server.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import { expect, it, vi } from 'vitest';
import { viewerCookie } from '../../src/daemon/auth.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { ConfigPermissions } from '../../src/daemon/configWatcher.js';
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
  const status = async () => (await api(td.port, td.token, '/environment?include=config')).body['configReload'] as
    { revision: number; outcome: string; reason?: string; needsDaemonRestart: string[] };
  const audits = () => {
    let log: string;
    try { log = fs.readFileSync(join(home, 'audit.log'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return log.split('\n').filter(l => l.includes('"config-reload"')).map(l => JSON.parse(l) as { meta: unknown });
  };
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
    expect((await api(td.port, null, '/environment?include=config')).status).toBe(401);
    const tokens = td.daemon['tokens'];
    const viewer = tokens.redeemViewerGrant(tokens.mintViewerGrant('sample'))!;
    const cookie = viewerCookie(viewer.sessionId, viewer.streamToken).split(';')[0]!;
    expect((await api(td.port, null, '/environment?include=config', { headers: { cookie } })).status).toBe(401);
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
  const status = async () => (await api(td.port, td.token, '/environment?include=config')).body['configReload'] as
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
  const status = async () => (await api(td.port, td.token, '/environment?include=config')).body['configReload'] as
    { revision: number; needsDaemonRestart: string[] };
  try {
    const candidate = { launcher: { profiles: [{ name: 'job', command: process.execPath }], sessionLaunch: ['desk'] },
      messaging: { enabled: true, allow: [{ group: 'team', members: ['desk'] }] },
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
      'idleMinutes', 'launcher.profiles', 'launcher.sessionLaunch', 'mcp.untrustedFraming', 'messaging', 'policy.mode',
      'prompts.dialogs', 'sessionEnv', 'viewer.profileDir',
    ]);
    expect(td.daemon['launchProfiles'].profiles).toEqual([]);
    expect((await api(td.port, td.token, '/environment?include=config')).body).toMatchObject({
      mode: 'clean', messagingEnabled: false,
    });
    expect((await api(td.port, td.token, '/environment')).body).toEqual({ mode: 'clean', exposed: [] });
    expect(await api(td.port, td.token, '/messages/claims', { body: { name: 'desk' } }))
      .toEqual({ status: 403, body: { error: 'Messaging is off.' } });
    const before = await status();
    fs.writeFileSync(file, JSON.stringify({ ...candidate, port: 123 }));
    await eventually(async () => ((await api(td.port, td.token, '/environment?include=config')).body['configReload'] as
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

it.skipIf(process.platform !== 'win32')('a replacement Windows reader rejects a newly shared configuration file', async () => {
  const home = makeTempHome();
  const reader = new ConfigPermissions(home);
  try {
    await reader.secureHome();
    await reader.read();
    reader.close();
    const icacls = join(process.env['SystemRoot']!, 'System32', 'icacls.exe');
    await promisify(execFile)(icacls, [join(home, 'config.json'), '/grant', '*S-1-5-32-544:R', '/Q'], { windowsHide: true });
    await expect(reader.read()).rejects.toThrow(/permission/i);
  } finally { reader.close(); removeTempHome(home); }
});

it('keeps configured names and regex text out of startup diagnostics and subsequent reloads', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  const log = join(home, 'daemon.log');
  const viewer = { launchMode: 'no-window' };
  const pattern = '[private-pattern-sentinel';
  const schedules = [{ name: 'private-schedule-sentinel', session: 'desk', cron: 'invalid', message: 'private-message-sentinel' }];
  const prompts = { dialogs: [{ name: 'private-dialog-sentinel', title: pattern, choices: 'Choice' }] };
  const agents = { signatures: [{ name: 'private-agent-sentinel', composer: { text: pattern }, answer: { start: { text: 'Answer' } } }] };
  fs.writeFileSync(file, JSON.stringify({ viewer, schedules, prompts, agents,
    mcp: { untrustedFraming: 0 }, policy: { deny: [pattern] } }));
  const child = spawn(process.execPath, [distDaemonEntry], {
    env: { ...process.env, SHELLPUPPET_HOME: home }, windowsHide: true, stdio: 'ignore',
  });
  const ended = once(child, 'exit');
  try {
    const logs = () => fs.readFileSync(log, 'utf8');
    const locations = ['schedules[0]', 'prompts.dialogs[0]', 'agents.signatures[0]', 'mcp.untrustedFraming', 'policy.deny[0]'];
    await eventually(() => readDaemonState(home) !== null, 15_000);
    for (const location of locations) expect(logs()).toContain(location);
    const state = readDaemonState(home)!;
    const status = async () => (await api(state.port, state.token, '/environment?include=config')).body['configReload'] as
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

it('reads its own boot configuration even when given obsolete prepared settings', async () => {
  const home = makeTempHome();
  const other = makeTempHome();
  const permissions = new ConfigPermissions(home);
  fs.unlinkSync(join(home, 'config.json'));
  fs.writeFileSync(join(other, 'config.json'), JSON.stringify({ launcher: { launchesPerMinute: 2 } }));
  const candidate = parseConfigCandidate(fs.readFileSync(join(other, 'config.json'), 'utf8'));
  try {
    await permissions.secureHome();
    const daemon = new Daemon({ home, logger: NULL_LOGGER,
      // @ts-expect-error Old JavaScript callers can still pass this removed option.
      bootConfig: { permissions, candidate } });
    try {
      await daemon.start();
      expect(daemon['launchesPerMinute']).toBe(8);
      expect(daemon['reload']!.status.outcome).toBe('unchanged');
    } finally { await daemon.stop(); }
  } finally { permissions.close(); removeTempHome(home); removeTempHome(other); }
}, 30_000);

it('records every startup diagnostic before publishing embedded discovery', async () => {
  const home = makeTempHome();
  const log = join(home, 'daemon.log');
  const envNames = ['SP_VALID_NAME', 'malformed-private-marker', 'SHELLPUPPET_SESSION_TOKEN'];
  fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ envNames, launcher: { launchesPerMinute: 0 },
    viewer: { browserPath: 1, profileDir: 2 },
    mcp: { unknown: true, untrustedFraming: 'invalid' }, audit: { unknown: false },
    policy: { maxSessions: 0, allow: ['[private-marker'], deny: ['valid', '[private-marker'] },
    agents: { signatures: [{ name: 'example', composer: { text: '[private-marker' }, answer: { start: { text: 'yes' } } }] } }));
  let publishedLog = '';
  const td = await startTestDaemon({ home, logger: createFileLogger(log),
    afterPublish: () => { publishedLog = fs.readFileSync(log, 'utf8'); return Promise.resolve(); } });
  try {
    expect(publishedLog).toContain('CONFIG PROBLEM');
    expect(publishedLog).toContain('agents.signatures[0]');
    expect(publishedLog).toContain('launcher.launchesPerMinute');
    for (const location of ['mcp contains an unsupported key', 'mcp.untrustedFraming', 'audit contains an unsupported key',
      'policy.allow[0]', 'policy.deny[1]', 'viewer.browserPath', 'viewer.profileDir']) expect.soft(publishedLog).toContain(location);
    const entries = publishedLog.trim().split('\n').map(line =>
      JSON.parse(line) as { message: string; meta?: { problem?: string } });
    const envProblems = entries.filter(entry => entry.message === 'CONFIG PROBLEM')
      .map(entry => entry.meta?.problem).filter(problem => problem?.startsWith('envNames'));
    expect(envProblems.sort()).toEqual([
      'envNames[1] is not a valid variable name.',
      'envNames[2] is reserved for the daemon.',
    ]);
    for (const name of envNames) expect(publishedLog).not.toContain(name);
    expect(publishedLog).not.toContain('private-marker');
  } finally { await td.stop(); }
}, 25_000);

it.each(['listen', 'ownership', 'publication'])('rechecks home identity immediately after %s', async phase => {
  const home = makeTempHome();
  const refuse = () => {
    const permissions = daemon['configPermissions']!;
    const verify = permissions.verifiedHome.bind(permissions);
    vi.spyOn(permissions, 'verifiedHome').mockImplementation(() => {
      if (phase === 'ownership' && !daemon['homeOwner']) return verify();
      if (phase === 'listen') expect(fs.existsSync(join(home, 'daemon-owner'))).toBe(false);
      throw new Error('Test home identity unavailable');
    });
  };
  const daemon = new Daemon({ home, logger: NULL_LOGGER,
    afterPublish: () => { if (phase === 'publication') refuse(); return Promise.resolve(); } });
  const incumbent = vi.fn(() => Promise.resolve(false));
  if (phase === 'ownership') {
    // The initial discovery check sees a stale fixture. Liveness performs no network I/O.
    fs.writeFileSync(join(home, 'daemon.json'), JSON.stringify({ pid: 1, port: 1, token: 'test' }));
    daemon['incumbentRunning'] = incumbent;
  }
  if (phase !== 'publication') daemon['server'].once('listening', refuse);
  try {
    await expect(daemon.start().then(() => undefined)).rejects.toThrow('Test home identity unavailable');
    if (phase === 'ownership') expect(incumbent).toHaveBeenCalledTimes(1);
    expect(daemon['claimsRestored']).toBe(false);
    expect(daemon['server'].listening).toBe(false);
  } finally { vi.restoreAllMocks(); await daemon.stop(); removeTempHome(home); }
});

function daemonWithHomeAlias() {
  const root = makeTempHome();
  const alias = join(root, 'alias');
  const home = join(alias, 'home');
  const pointAliasAt = (name: string) => {
    const parent = join(root, name);
    fs.mkdirSync(join(parent, 'home'), { recursive: true });
    fs.rmSync(alias, { force: true });
    fs.symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  };
  pointAliasAt('original');
  return { root, home, pointAliasAt, daemon: new Daemon({ home, logger: NULL_LOGGER }) };
}

it('gives a child session the caller\'s spelling of the home alias', async () => {
  const { root, home, daemon } = daemonWithHomeAlias();
  const output = join(root, 'child-home');
  try {
    const { port, token } = await daemon.start();
    const response = await api(port, token, '/sessions', { body: { command: process.execPath, shell: false, openViewer: false,
      args: ['-e', "require('node:fs').writeFileSync(process.argv[1], process.env.SHELLPUPPET_HOME)", output] } });
    expect(response.status).toBe(200);
    await eventually(() => fs.existsSync(output), 5_000);
    expect(fs.readFileSync(output, 'utf8')).toBe(home);
  } finally { await daemon.stop(); removeTempHome(root); }
}, 30_000);

it('refuses a session before PTY spawn when the home alias is retargeted after startup', async () => {
  const { root, pointAliasAt, daemon } = daemonWithHomeAlias();
  const spawnPty = vi.fn(() => { throw new Error('Reached PTY spawn after the home alias changed'); });
  daemon['manager']['sessionDeps'].spawn = spawnPty;
  try {
    const { port, token } = await daemon.start();
    pointAliasAt('other');
    const response = await api(port, token, '/sessions', { body: { command: process.execPath, args: ['-v'], shell: false, openViewer: false } });
    expect(spawnPty.mock.calls.length).toBe(0);
    expect(response.status).toBe(500);
    expect(response.body['error']).toMatch(/cannot verify owner-only permissions/i);
  } finally {
    pointAliasAt('original');
    await daemon.stop();
    removeTempHome(root);
  }
}, 30_000);

it('reports the schema locations of malformed agent and launch profile expressions', () => {
  const expression = '[sample-pattern';
  const { config, problems } = parseDaemonConfig({
    launcher: { profiles: [{ name: 'sample-profile', command: 'sample', policy: { deny: [expression] } }] },
    agents: { signatures: [{ name: 'sample-agent', composer: { text: expression }, answer: { start: { text: 'Answer' } } }] },
  });
  expect(config.launcher?.problems).toEqual(['launcher.profiles[0].policy.deny[0] does not compile']);
  expect(problems.join(' ')).toContain('agents.signatures[0] (sample-agent).composer.text does not compile');
  expect(problems.join(' ')).not.toMatch(/sample-(?:pattern|profile)/);
});

it('reads the saved lists at each CLI and MCP start, including a save the daemon rejected', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  const env = { ...process.env, SHELLPUPPET_HOME: home, SP_SAMPLE_NAME: 'sample' } as Record<string, string>;
  const td = await startTestDaemon({ home });
  const client = new Client({ name: 'sample-client', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'dist/mcp/index.js')], env, stderr: 'pipe' });
  const cli = () => promisify(execFile)(process.execPath, [join(repoRoot, 'dist/cli/index.js'), 'start', '--env-name',
    'SP_SAMPLE_NAME', '--no-viewer', '--no-shell', process.execPath, '-v'], { env, windowsHide: true });
  const mcp = () => client.callTool({ name: 'terminal_start', arguments: { command: process.execPath, args: ['-v'],
    shell: false, envNames: ['SP_SAMPLE_NAME'] } });
  try {
    const requests: string[] = [];
    td.daemon['server'].on('request', (request) => { requests.push(request.url ?? ''); });
    await client.connect(transport);
    await client.listTools();
    expect.soft(requests).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ envNames: ['SP_SAMPLE_NAME'], launcher: { launchesPerMinute: 0 } }));
    await eventually(() => td.daemon['reload']?.status.outcome === 'rejected', 5_000);
    const started = await Promise.allSettled([cli(), mcp()]);
    expect.soft(started[0]).toMatchObject({ status: 'fulfilled', value: { stderr: expect.stringContaining('SP_SAMPLE_NAME') as string } });
    expect.soft(started[1]).toMatchObject({ status: 'fulfilled', value: { content: [
      expect.objectContaining({ text: expect.stringMatching(/Session s\d+ started[\s\S]*SP_SAMPLE_NAME/) as string })] } });
    expect.soft(td.daemon['manager'].size()).toBe(2);
    fs.writeFileSync(file, JSON.stringify({ envNames: [], launcher: { launchesPerMinute: 0 } }));
    const reason = 'Not started: SP_SAMPLE_NAME is not listed in envNames in ~/.shellpuppet/config.json';
    await expect(cli()).rejects.toMatchObject({ code: 2, stderr: reason +
      ', the variables you allow to be passed into a session. Add it to that list, or start without it.\n' });
    expect(td.daemon['manager'].size()).toBe(2);
    expect(await mcp()).toMatchObject({ isError: true, content: [{ type: 'text', text: reason +
      ', the variables the human allows this server to pass. Ask them to add it to that list, which this server reads at every start, or start without it.' }] });
    expect(td.daemon['manager'].size()).toBe(2);
    expect(requests).not.toContain('/environment?include=client');
    expect((await api(td.port, td.token, '/environment?include=client')).body).toEqual({ mode: 'clean', exposed: [] });
    const ordinaryStart = await api(td.port, td.token, '/sessions', { body: { command: process.execPath, args: ['-v'], openViewer: false },
      headers: { 'x-shellpuppet-config-revision': '0' } });
    expect(ordinaryStart.status).toBe(200);
  } finally { await client.close(); await td.stop(); }
}, 80_000);

it('lists messaging tools offline from a first-use home and uses quiet defaults for an absent home', async () => {
  const root = makeTempHome();
  try {
    for (const exists of [true, false]) {
      const home = exists ? root : join(root, 'absent');
      if (exists) fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ messaging: { enabled: true } }));
      const client = new Client({ name: 'sample-client', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'dist/mcp/index.js')],
        env: { ...process.env, SHELLPUPPET_HOME: home }, stderr: 'pipe' });
      let diagnostics = '';
      transport.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
      try {
        await client.connect(transport);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        expect.soft(names.includes('session_send')).toBe(exists);
        expect.soft(diagnostics).not.toMatch(/could not verify/i);
        expect(readDaemonState(home)).toBeNull();
        expect(fs.existsSync(home)).toBe(exists);
      } finally { await client.close(); }
    }
  } finally { removeTempHome(root); }
});

it('holds settings while discovery is uncertain and accepts edits after the owner republishes', async () => {
  const home = makeTempHome();
  const config = join(home, 'config.json');
  const save = (rate: number) => fs.writeFileSync(config, JSON.stringify({ launcher: { launchesPerMinute: rate } }));
  save(3);
  const td = await startTestDaemon({ home, statePublishCheckMs: 60_000 });
  try {
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const original = readDaemonState(home)!;
    fs.unlinkSync(join(home, 'daemon.json'));
    save(4);
    await td.daemon['configWatcher']!.request();
    expect(td.daemon['launchesPerMinute']).toBe(3);
    fs.writeFileSync(join(home, 'daemon.json'), JSON.stringify({ ...original, instanceId: randomUUID(), pid: 2147483647 }));
    await td.daemon['configWatcher']!.request();
    expect(td.daemon['launchesPerMinute']).toBe(3);
    await td.daemon['keepStatePublished']();
    expect(readDaemonState(home)?.instanceId).toBe(original.instanceId);
    save(5);
    await eventually(() => td.daemon['launchesPerMinute'] === 5, 5_000);
    expect(td.daemon['reload']!.status.watcher).toBe('watching');
  } finally { await td.stop(); }
}, 30_000);
