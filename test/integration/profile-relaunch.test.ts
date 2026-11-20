import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('records a live agent conversation before restart and relaunches it from the saved folder choice', async () => {
  const home = makeTempHome();
  const file = join(home, 'child.cjs');
  writeFileSync(file, `
    const {execFile} = require('node:child_process');
    const fs = require('node:fs');
    process.env.CODEX_THREAD_ID = 'thread-42';
    execFile(process.execPath, [process.env.SHELLPUPPET_CLI, 'list', '--json'], error => {
      fs.writeFileSync('observed.json', JSON.stringify({success: !error, args: process.argv.slice(2)}));
    });
    setInterval(() => {}, 1000);
  `);
  const config = parseDaemonConfig({ launcher: { sessionLaunch: ['outside'], profiles: [
    { name: 'worker', command: process.execPath, args: [file], shell: false, cwd: 'ask',
      folders: [{ name: 'repo', path: home }], agent: 'codex', resume: ['--resume', '{id}'] }
  ] } }).config;
  const opts = { home, launchProfiles: config.launcher, messaging: { enabled: true, allow: [] } };
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
    try {
      writeFileSync(record, JSON.stringify({ version: 1, sessions: [{ profile: 'worker', name: 's12' }] }));
      const legacy = await runCli('previous', '--json');
      expect(JSON.parse(legacy.stdout)).toMatchObject({ sessions: [{ name: null }] });
    } finally { writeFileSync(record, complete); }
    const { stdout } = await runCli('previous', '--json');
    const saved = JSON.parse(stdout) as { sessions: { profile: string; name: string; resumeId: string; endedAt: string; folderChoice: object }[] };
    expect(saved.sessions).toEqual([expect.objectContaining({ profile: 'worker', name: 'my-worker', agent: 'codex',
      folder: home, folderChoice: { folder: 'repo' }, resumeId: 'thread-42' })]);
    expect(Number.isFinite(Date.parse(saved.sessions[0]!.endedAt))).toBe(true);
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
