import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
import { Daemon } from '../../src/daemon/server.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { ensureHome, readDaemonState, writePrivateRecord } from '../../src/daemon/paths.js';
import { buildSessionEnv } from '../../src/core/session.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import { copyDaemonEnv } from '../../src/daemon/launchProfiles.js';
import { api, eventually, makeTempHome, removeTempHome, repoRoot, startTestDaemon } from './helpers.js';

const cli = join(repoRoot, 'dist', 'cli', 'index.js');
const program = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false };

it('keeps free-form participant names outside the protected namespace', async () => {
  const td = await startTestDaemon({
    launchProfiles: { sessionLaunch: ['supervisor'], profiles: [], problems: [] },
    messaging: { enabled: false, allow: [{ group: 'chairs', members: ['outside-chair'] }] },
  });
  try {
    for (const label of ['supervisor', 'outside-chair', 'ordinary']) {
      const started = await api(td.port, td.token, '/sessions', { body: { ...program, label, openViewer: false } });
      expect(started.status).toBe(200);
      const listed = await api(td.port, td.token, '/sessions');
      expect(listed.body['sessions']).toContainEqual(expect.objectContaining({
        id: started.body['id'], name: label === 'ordinary' ? label : started.body['id'],
      }));
    }
  } finally { await td.stop(); }
});

it('keeps claim credentials out of passthrough, passed variables and all-profile copies', () => {
  const env = { SHELLPUPPET_CLAIM: 'sentinel', ShellPuppet_Claim_Secret: 'sentinel', EXAMPLE: 'keep' };
  for (const platform of ['win32', 'linux'] as const) {
    const child = buildSessionEnv('passthrough', platform, env, env);
    expect(Object.values(child)).not.toContain('sentinel');
    expect(child['EXAMPLE']).toBe('keep');
  }
  expect(copyDaemonEnv('all', env).env).toEqual({ EXAMPLE: 'keep' });
});

it('starts the replacement daemon without caller claim credentials and reports a snapshot failure', async () => {
  const home = makeTempHome();
  const wrapper = join(home, 'wrapper.mjs');
  const observed = join(home, 'observed.json');
  writeFileSync(wrapper, `import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(Object.keys(process.env)
      .filter(key => /^SHELLPUPPET_CLAIM(_SECRET)?$/i.test(key))));
    await import(pathToFileURL(process.argv[3]).href);`);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { startWith: [process.execPath, wrapper] },
    viewer: { launchMode: 'no-window' } }));
  const env = { ...process.env, SHELLPUPPET_HOME: home, SHELLPUPPET_CLAIM: 'sentinel', SHELLPUPPET_CLAIM_SECRET: 'sentinel' };
  delete (env as NodeJS.ProcessEnv)['SHELLPUPPET_DAEMON_DIRECT'];
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, 'daemon', ...args], { env, timeout: 60_000 });
  try {
    await run('start');
    expect.soft(JSON.parse(readFileSync(observed, 'utf8'))).toEqual([]);
    writeFileSync(observed, 'null');
    mkdirSync(join(home, 'previous-sessions.json'));
    const previous = readDaemonState(home)!;
    const { stdout } = await run('restart', '--json');
    expect(readDaemonState(home)?.instanceId).not.toBe(previous.instanceId);
    expect.soft(JSON.parse(stdout)).toMatchObject({ running: true, warnings: [expect.stringContaining('previous-sessions.json')] });
    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual([]);
  } finally {
    if (readDaemonState(home)) await run('stop', '--force');
    removeTempHome(home);
  }
}, 150_000);

it.runIf(process.platform === 'win32')('repairs existing home and file ACLs and publishes explicitly private records', () => {
  const home = makeTempHome();
  const files = ['daemon.json', 'launcher-claims.json', 'previous-sessions.json'];
  try {
    for (const file of files) writeFileSync(join(home, file), '{}');
    // An explicit ACE on an old record survives changes to its parent directory.
    execFileSync('icacls.exe', [join(home, 'launcher-claims.json'), '/grant', '*S-1-5-32-545:R'], { windowsHide: true });
    ensureHome(home);
    writePrivateRecord(join(home, 'previous-sessions.json'), {});
    const check = `$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach ($item in @($env:TEST_ACL_HOME) + @(Get-ChildItem -LiteralPath $env:TEST_ACL_HOME | ForEach-Object FullName)) {
        $entry = if ([IO.Directory]::Exists($item)) { [IO.DirectoryInfo]::new($item) } else { [IO.FileInfo]::new($item) }
        $acl = $entry.GetAccessControl()
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if (!$acl.AreAccessRulesProtected -or $acl.GetOwner($sid.GetType()) -ne $sid -or $rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference -ne $sid -or
          $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { exit 1 }
      }`;
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check],
      { windowsHide: true, env: { ...process.env, TEST_ACL_HOME: home } })).not.toThrow();
    const target = join(home, 'previous-sessions.json');
    vi.stubEnv('SystemRoot', join(home, 'missing-system-tools'));
    try {
      expect(() => writePrivateRecord(target, { replacement: true })).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('{}');
    } finally { vi.unstubAllEnvs(); }
  } finally { removeTempHome(home); }
});

it('rejects embedded resume placeholders even alongside a whole placeholder', () => {
  for (const resume of [['--resume={id}'], ['{id}', 'prefix{id}']]) {
    const { config, problems } = parseDaemonConfig({ launcher: { profiles: [{ name: 'worker', ...program, resume }] } });
    expect(config.launcher?.profiles).toEqual([]);
    expect(problems.join(' ')).toContain('whole argument');
  }
});

it('reports each failed shutdown record and finishes the requested stop', async () => {
  const warn = vi.fn();
  const td = await startTestDaemon({ logger: { ...NULL_LOGGER, warn },
    launchProfiles: { profiles: [], problems: [], sessionLaunch: ['supervisor'] } });
  try {
    for (const file of ['launcher-claims.json', 'previous-sessions.json']) mkdirSync(join(td.home, file));
    const result = await api(td.port, td.token, '/daemon/shutdown', { body: { restart: true } });
    expect(result.status).toBe(200);
    expect(result.body['warnings']).toEqual(expect.arrayContaining([
      expect.stringContaining('launcher-claims.json'), expect.stringContaining('previous-sessions.json'),
    ]));
    expect(warn).toHaveBeenCalledTimes(2);
    await eventually(() => readDaemonState(td.home) === null);
  } finally { await td.stop(); }
});

it('uses the profile name for untitled CLI and MCP launches and records a replayable system name', async () => {
  const profiles = ['worker', 's999'].map(name => ({ name, label: name === 'worker' ? 'desk' : 's999', ...program }));
  const { config } = parseDaemonConfig({ launcher: { sessionLaunch: ['supervisor'], profiles } });
  const options = { home: makeTempHome(), launchProfiles: config.launcher, messaging: { enabled: true, allow: [] } };
  let td = await startTestDaemon(options);
  const client = new Client({ name: 'test', version: '1' });
  try {
    const claim = (await api(td.port, td.token, '/messages/claims', { body: { name: 'supervisor' } })).body;
    const env = { ...process.env, SHELLPUPPET_HOME: td.home, SHELLPUPPET_CLAIM: String(claim['claimId']) + ':' + String(claim['secret']) };
    for (const key of ['SHELLPUPPET_SESSION', 'SHELLPUPPET_SESSION_TOKEN', 'SHELLPUPPET_DAEMON_INSTANCE']) delete (env as NodeJS.ProcessEnv)[key];
    await promisify(execFile)(process.execPath, [cli, 'launch', 'worker'], { env });
    const sessions = async () => (await api(td.port, td.token, '/sessions')).body['sessions'] as { id: string; name: string }[];
    const first = (await sessions())[0]!;
    expect.soft(first.name).toBe('worker');
    await api(td.port, td.token, '/sessions/' + first.id, { method: 'DELETE' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
    for (const profile of ['worker', 's999']) {
      const result = await client.callTool({ name: 'terminal_start', arguments: { profile } });
      expect(result.isError).not.toBe(true);
    }
    expect.soft(await sessions()).toContainEqual(expect.objectContaining({ name: 'worker' }));
    await client.close();
    const response = await api(td.port, td.token, '/daemon/shutdown', { body: { restart: true, force: true } });
    expect(response.status).toBe(200);
    const record = JSON.parse(readFileSync(join(td.home, 'previous-sessions.json'), 'utf8')) as { sessions: unknown[] };
    expect(record.sessions).toContainEqual(expect.objectContaining({ profile: 's999', name: null }));
    await td.daemon.stop();
    td = await startTestDaemon(options);
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'previous', '--json'], { env });
    const saved = JSON.parse(stdout) as { sessions: { profile: string; name: string | null }[] };
    const generated = saved.sessions.find(row => row.name === null)!;
    await promisify(execFile)(process.execPath, [cli, 'launch', generated.profile], { env });
    const [replayed] = await sessions();
    expect(replayed?.name).toBe(replayed?.id);
    expect(replayed?.name).toMatch(/^s[0-9]+$/);
  } finally { await client.close(); await td.stop(); }
}, 120_000);

it('documents the durable claim record and the dashboard resume field', () => {
  const read = (file: string) => readFileSync(join(repoRoot, 'docs', file), 'utf8');
  expect.soft(read('reference/security-model.md').includes('launcher-claims.json')).toBe(true);
  const contract = read('architecture/design.md').split('`POST /dashboard/launch` accepts JSON')[1]!.split('\n\n')[0];
  expect(contract).toContain('`resumeId`');
});

it('preserves the incumbent discovery record and durable claim when a contender stops before acquiring the home', async () => {
  const options = { home: makeTempHome(), launchProfiles: { sessionLaunch: ['chair'], profiles: [], problems: [] },
    messaging: { enabled: true, allow: [] }, logger: NULL_LOGGER };
  let td = await startTestDaemon(options);
  try {
    const claim = (await api(td.port, td.token, '/messages/claims', { body: { name: 'chair' } })).body;
    const file = join(td.home, 'launcher-claims.json');
    const saved = readFileSync(file, 'utf8');
    const contender = new Daemon(options);
    const start = expect(contender.start()).rejects.toThrow(/running/i);
    await contender.stop();
    await start;
    expect.soft(readFileSync(file, 'utf8') === saved).toBe(true);
    expect.soft(readDaemonState(td.home)?.port).toBe(td.port);
    // Simulate the incumbent leaving without another orderly save.
    await td.daemon.stop({ removeState: false });
    td = await startTestDaemon(options);
    expect((await api(td.port, td.token, '/launcher/previous', { headers: {
      'x-shellpuppet-claim': String(claim['claimId']), 'x-shellpuppet-claim-secret': String(claim['secret']),
    } })).status).toBe(200);
  } finally { await td.stop(); }
});

async function preventSnapshotReplacement(snapshot: string): Promise<() => void | Promise<void>> {
  if (process.platform === 'win32') {
    // A real Windows read handle that denies delete sharing blocks the atomic rename.
    const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open($env:SP_TEST_SNAPSHOT, 'Open', 'Read', 'Read'); [Console]::WriteLine('ready'); [void][Console]::ReadLine(); $f.Dispose()"],
    { windowsHide: true, env: { ...process.env, SP_TEST_SNAPSHOT: snapshot }, stdio: 'pipe' });
    const exit = once(reader, 'exit');
    try {
      const ready = await Promise.race([once(reader.stdout, 'data'), exit]);
      expect(String(ready[0]).trim()).toBe('ready');
    } catch (error) { reader.kill(); await exit; throw error; }
    return async () => { reader.stdin.end(); await exit; };
  }
  // POSIX permits replacing an open file. Keep the same complete bytes and
  // obstruct the destination until the outgoing daemon has attempted its write.
  const backup = snapshot + '.saved';
  renameSync(snapshot, backup);
  mkdirSync(snapshot);
  return () => { rmdirSync(snapshot); renameSync(backup, snapshot); };
}

it('refuses a complete but stale snapshot after the next restart cannot replace it', async () => {
  const { config } = parseDaemonConfig({ launcher: { sessionLaunch: ['chair'], profiles: [{ name: 'worker', ...program }] } });
  const options = { home: makeTempHome(), launchProfiles: config.launcher, messaging: { enabled: true, allow: [] } };
  let td = await startTestDaemon(options);
  const client = new Client({ name: 'reader', version: '1' });
  try {
    const claim = (await api(td.port, td.token, '/messages/claims', { body: { name: 'chair' } })).body;
    const headers = { 'x-shellpuppet-claim': String(claim['claimId']), 'x-shellpuppet-claim-secret': String(claim['secret']) };
    const env = { ...process.env, SHELLPUPPET_HOME: td.home, SHELLPUPPET_CLAIM: headers['x-shellpuppet-claim'] + ':' + headers['x-shellpuppet-claim-secret'] };
    for (const key of ['SHELLPUPPET_SESSION', 'SHELLPUPPET_SESSION_TOKEN', 'SHELLPUPPET_DAEMON_INSTANCE']) delete (env as NodeJS.ProcessEnv)[key];
    expect((await api(td.port, td.token, '/launcher/launch', { headers, body: { profile: 'worker', name: 'old-run' } })).status).toBe(200);
    const owner = readDaemonState(td.home)!.instanceId;
    await td.daemon.stop({ restart: true });
    td = await startTestDaemon(options);
    const snapshot = join(td.home, 'previous-sessions.json');
    const old = readFileSync(snapshot, 'utf8');
    const current = await api(td.port, td.token, '/launcher/previous', { headers });
    expect(current.status).toBe(200);
    expect(current.body['sessions']).toContainEqual(expect.objectContaining({ name: 'old-run' }));
    expect.soft(current.body['outgoingInstanceId']).toBe(owner);
    const unlock = await preventSnapshotReplacement(snapshot);
    try {
      const stop = await api(td.port, td.token, '/daemon/shutdown', { body: { restart: true } });
      expect(stop.body['warnings']).toContainEqual(expect.stringContaining('previous-sessions.json'));
      await td.daemon.stop();
    } finally { await unlock(); }
    td = await startTestDaemon(options);
    expect(readFileSync(snapshot, 'utf8')).toBe(old);
    expect.soft((await api(td.port, td.token, '/launcher/previous', { headers })).status).toBe(409);
    await expect.soft(promisify(execFile)(process.execPath, [cli, 'previous', '--json'], { env })).rejects.toThrow(/snapshot/i);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
    const result = await client.callTool({ name: 'terminal_list', arguments: { previous: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/snapshot/i);
  } finally { await client.close(); await td.stop(); }
}, 90_000);
