import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { NULL_LOGGER } from '../../src/core/types.js';
import * as lookup from '../../src/daemon/liveResumeIds.js';
import * as records from '../../src/daemon/paths.js';
import { windowsLiveMetadata } from '../../src/core/windowsLiveMetadata.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('records the conversation selected after the Claude child reported its launch id', async () => {
  const home = makeTempHome();
  const configDir = join(home, 'claude-config');
  mkdirSync(join(configDir, 'sessions'), { recursive: true });
  const packageDir = join(home, '@anthropic-ai', 'claude-code');
  mkdirSync(packageDir, { recursive: true });
  const script = join(packageDir, 'cli.js');
  const wrapper = join(home, 'wrapper.cjs');
  const native = join(home, process.platform === 'win32' ? 'claude.exe' : 'claude-code');
  copyFileSync(process.execPath, native);
  writeFileSync(wrapper, `
    require('node:child_process').spawn(${JSON.stringify(native)}, [${JSON.stringify(script)}], { stdio: 'inherit' });
  `);
  writeFileSync(script, `
    const { execFileSync } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const marker = process.argv[2] || 'worker';
    execFileSync(process.execPath, [process.env.SHELLPUPPET_CLI, 'list', '--json'], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: marker + '-reported' }
    });
    writeFileSync(join(${JSON.stringify(home)}, marker + '-pid'), String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const claude = { agent: 'claude', command: process.execPath, shell: false, cwd: home, envFromDaemon: ['CLAUDE_CONFIG_DIR'] };
  const { config } = parseDaemonConfig({ launcher: { sessionLaunch: ['chair'], profiles: [
    { ...claude, name: 'worker', args: [wrapper] },
    { ...claude, name: 'other', command: native, args: [script, 'other'], resume: ['{id}'] },
    { ...claude, name: 'node', args: [script, 'node'], resume: ['{id}'] },
  ] } });
  const info = vi.fn();
  const td = await startTestDaemon({ home, launchProfiles: config.launcher,
    daemonEnv: { CLAUDE_CONFIG_DIR: configDir }, messaging: { enabled: true, allow: [] }, logger: { ...NULL_LOGGER, info } });
  try {
    const claim = (await api(td.port, td.token, '/messages/claims', { body: { name: 'chair' } })).body;
    const headers = { 'x-shellpuppet-claim': String(claim['claimId']), 'x-shellpuppet-claim-secret': String(claim['secret']) };
    expect((await api(td.port, td.token, '/launcher/launch', { headers, body: { profile: 'worker' } })).status).toBe(200);
    expect((await api(td.port, td.token, '/launcher/launch', { headers, body: { profile: 'other', resumeId: 'other-id' } })).status).toBe(200);
    expect((await api(td.port, td.token, '/launcher/launch', { headers, body: { profile: 'node', resumeId: 'node-id' } })).status).toBe(200);
    const profiles = ['worker', 'other', 'node'];
    await eventually(() => profiles.every(name => existsSync(join(home, name + '-pid'))), 30_000);
    const pidOf = (name: string) => readFileSync(join(home, name + '-pid'), 'utf8');
    const stale = join(configDir, 'sessions', pidOf('other') + '.json');
    writeFileSync(stale, '{"sessionId":"stale-file"}');
    utimesSync(stale, 1, 1);
    writeFileSync(join(configDir, 'sessions', pidOf('node') + '.json'), '{"sessionId":"node-file"}');
    const pid = pidOf('worker');
    if (process.platform === 'win32') {
      await windowsLiveMetadata().request(['images'], AbortSignal.timeout(30_000));
    }
    writeFileSync(join(configDir, 'sessions', pid + '.json'), JSON.stringify({ sessionId: 'after-resume' }));
    const stopped = await api(td.port, td.token, '/daemon/shutdown', { body: { restart: true, force: true } });
    expect(stopped.status).toBe(200);
    const record = JSON.parse(readFileSync(join(home, 'previous-sessions.json'), 'utf8')) as {
      sessions: { profile: string; resumeId: string }[];
    };
    expect(Object.fromEntries(record.sessions.map(s => [s.profile, s.resumeId]))).toEqual({
      worker: 'after-resume', other: 'other-reported', node: 'node-reported',
    });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/after-resume|other-id|node-id|worker-reported/);
  } finally { await td.stop(); }
}, 120_000);

it('includes claim activity accepted during lookup and publishes the outgoing restart source last', async () => {
  const home = makeTempHome();
  let now = Date.now();
  const td = await startTestDaemon({ home, now: () => now,
    launchProfiles: { profiles: [], problems: [], sessionLaunch: ['chair'] },
    messaging: { enabled: true, allow: [] } });
  const source = join(home, 'restart-source.json');
  const snapshot = join(home, 'previous-sessions.json');
  const predecessor = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const state = td.daemon['publishedState']!;
  state.restartCandidates = [predecessor];
  state.restartSourcePending = true;
  writeFileSync(snapshot, JSON.stringify({ version: 1, sessions: [], outgoingInstanceId: predecessor }));
  let entered!: () => void;
  const lookupStarted = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void;
  const continueLookup = new Promise<void>(resolve => { resume = resolve; });
  const spy = vi.spyOn(lookup, 'recordLiveResumeIds').mockImplementation(async () => {
    entered();
    await continueLookup;
    return new Map();
  });
  try {
    const claim = (await api(td.port, td.token, '/messages/claims', { body: { name: 'chair' } })).body;
    const headers = { 'x-shellpuppet-claim': String(claim['claimId']), 'x-shellpuppet-claim-secret': String(claim['secret']) };
    const stop = api(td.port, td.token, '/daemon/shutdown', { body: { restart: true } });
    await lookupStarted;
    now += 1000;
    expect((await api(td.port, td.token, '/messages/inbox', { headers })).status).toBe(200);
    expect((await api(td.port, td.token, '/launcher/previous', { headers })).status).toBe(200);
    resume();
    expect((await stop).status).toBe(200);
    const savedClaims = JSON.parse(readFileSync(join(home, 'launcher-claims.json'), 'utf8')) as { lastActivity: number }[];
    expect.soft(savedClaims[0]?.lastActivity).toBe(now);
    expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual({ restartFrom: state.instanceId });
  } finally { resume(); spy.mockRestore(); await td.stop(); }
});

it('bounds the delay a stalled lookup adds to the HTTP reply and listener closure', async () => {
  const td = await startTestDaemon();
  const record = lookup.recordLiveResumeIds;
  const stalled = new Promise<never>(() => {});
  const source = { matchesProcess: () => true, read: () => stalled };
  const sessions = [1, 2, 3].map(pid => ({ pid, programEnded: false, liveResumeId: source }));
  let started = 0;
  const lookupSpy = vi.spyOn(lookup, 'recordLiveResumeIds').mockImplementation(async () => {
    started = performance.now();
    await record(sessions, () => stalled);
    return new Map();
  });
  // Measure the lookup's contribution independently of the host's private-file ACL tools.
  const writes = vi.spyOn(records, 'writePrivateRecord').mockImplementation(() => {});
  try {
    const response = await api(td.port, td.token, '/daemon/shutdown', { body: { restart: true } });
    const elapsed = performance.now() - started;
    expect(response.status).toBe(200);
    expect(td.daemon['server'].listening).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(550);
  } finally { lookupSpy.mockRestore(); writes.mockRestore(); await td.stop(); }
});

it('records a live agent conversation before restart and relaunches it from the saved folder choice', async () => {
  const home = makeTempHome();
  const file = join(home, 'child.cjs');
  writeFileSync(file, `
    const {execFile} = require('node:child_process');
    const fs = require('node:fs');
    if (process.env.CODEX_THREAD_ID !== 'parent-thread') throw new Error('Missing inherited marker');
    process.env.CODEX_SESSION_ID = 'thread-42';
    execFile(process.execPath, [process.env.SHELLPUPPET_CLI, 'list', '--json'], error => {
      fs.writeFileSync('observed.json', JSON.stringify({success: !error, args: process.argv.slice(2)}));
    });
    setInterval(() => {}, 1000);
  `);
  const config = parseDaemonConfig({ launcher: { sessionLaunch: ['outside'], profiles: [
    { name: 'worker', command: process.execPath, args: [file], shell: false, cwd: 'ask',
      folders: [{ name: 'repo', path: home }], agent: 'codex', envFromDaemon: ['CODEX_THREAD_ID'], resume: ['--resume', '{id}'] }
  ] } }).config;
  const opts = { home, daemonEnv: { CODEX_THREAD_ID: 'parent-thread' }, launchProfiles: config.launcher, messaging: { enabled: true, allow: [] } };
  let td = await startTestDaemon(opts);
  const cli = join(repoRoot, 'dist', 'cli', 'index.js');
  let client: Client | undefined;
  try {
    expect((await api(td.port, td.token, '/launcher/previous')).status).toBe(403);
    const claim = (await api(td.port, td.token, '/messages/claims', { body: { name: 'outside' } })).body;
    const env = { ...process.env, SHELLPUPPET_HOME: home, SHELLPUPPET_CLAIM: String(claim['claimId']) + ':' + String(claim['secret']) };
    for (const key of ['SHELLPUPPET_SESSION', 'SHELLPUPPET_SESSION_TOKEN', 'SHELLPUPPET_DAEMON_INSTANCE']) delete (env as NodeJS.ProcessEnv)[key];
    const runCli = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 45000 });
    await runCli('launch', 'worker', '--folder', 'repo', '--name', 'my-worker');
    const observed = join(home, 'observed.json');
    await eventually(() => existsSync(observed), 30000);
    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({ success: true, args: [] });
    const record = join(home, 'previous-sessions.json');
    expect((await api(td.port, td.token, '/daemon/shutdown', { body: { restart: true } })).status).toBe(409);
    expect(existsSync(record)).toBe(false);
    expect((await api(td.port, td.token, '/daemon/shutdown', { body: { restart: true, force: true } })).status).toBe(200);
    await td.daemon.stop();
    if (process.platform !== 'win32') expect(statSync(record).mode & 0o777).toBe(0o600);
    td = await startTestDaemon(opts);
    const complete = readFileSync(record, 'utf8');
    const { stdout } = await runCli('previous', '--json');
    const saved = JSON.parse(stdout) as { sessions: { profile: string; name: string; resumeId: string; endedAt: string; folderChoice: object }[] };
    expect(saved.sessions).toEqual([expect.objectContaining({ profile: 'worker', name: 'my-worker', agent: 'codex',
      folder: home, folderChoice: { folder: 'repo' }, resumeId: 'thread-42' })]);
    expect(Number.isFinite(Date.parse(saved.sessions[0]!.endedAt))).toBe(true);
    try {
      writeFileSync(record, JSON.stringify({ version: 1, sessions: [{ profile: 'worker', name: 's12' }] }));
      await expect(runCli('previous', '--json')).rejects.toThrow(/snapshot/i);
    } finally { writeFileSync(record, complete); }
    client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
    expect((await client.listTools()).tools).toHaveLength(12);
    const previous = await client.callTool({ name: 'terminal_list', arguments: { previous: true } });
    expect(JSON.stringify(previous.content)).toContain('thread-42');
    const entry = saved.sessions[0]!;
    const started = await client.callTool({ name: 'terminal_start', arguments: { profile: entry.profile,
      name: entry.name, resumeId: entry.resumeId, ...entry.folderChoice } });
    expect(started.isError).not.toBe(true);
    await eventually(() => readFileSync(observed, 'utf8').includes('--resume'), 30000);
    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({ success: true, args: ['--resume', 'thread-42'] });
  } finally { try { await client?.close(); } finally { await td.stop(); } }
}, 120000);
