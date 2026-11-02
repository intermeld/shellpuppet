import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonState } from '../../src/daemon/paths.js';
import { api, distDaemonEntry, eventually, makeTempHome, processAlive, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
const mcp = path.join(repoRoot, 'dist', 'mcp', 'index.js');
const wrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-wrapper.mjs');
const failureWrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-failure.mjs');
const recordWrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-record.mjs');
const parentWrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-parent.mjs');
const boundRunner = path.join(repoRoot, 'test', 'integration', 'fixtures', 'ensure-daemon-bound.mjs');
const markerEntry = path.join(repoRoot, 'test', 'integration', 'fixtures', 'daemon-entry-marker.mjs');
const socketHolder = path.join(repoRoot, 'test', 'integration', 'fixtures', 'start-socket-holder.mjs');
const homes: { home: string; pid?: number }[] = [];

function homeWithWrapper(delay = 0): { home: string; marker: string } {
  const home = makeTempHome('shellpuppet-wrapper-');
  homes.push({ home });
  const marker = path.join(home, 'wrapper-ran');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    viewer: { launchMode: 'no-window' },
    daemon: { startWith: [process.execPath, wrapper, marker, String(delay)] },
  }));
  return { home, marker };
}

function homeWithFailure(mode: 'hang' | 'exit'): { home: string; marker: string } {
  const home = makeTempHome('shellpuppet-wrapper-failure-');
  homes.push({ home });
  const marker = path.join(home, 'wrapper-pid');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    viewer: { launchMode: 'no-window' },
    daemon: { startWith: [process.execPath, failureWrapper, mode, marker] },
  }));
  return { home, marker };
}

async function runBound(home: string, bound: number): Promise<{ code: number | string; stderr: string; elapsedMs: number }> {
  const started = Date.now();
  try {
    const { stderr } = await execFileAsync(process.execPath, [boundRunner, String(bound)], {
      env: { ...process.env, SHELLPUPPET_HOME: home }, timeout: 45_000,
    });
    return { code: 0, stderr, elapsedMs: Date.now() - started };
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? '', elapsedMs: Date.now() - started };
  }
}

async function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{
  code: number; stdout: string; stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: home, ...extraEnv }, timeout: 140_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function recordPid(home: string): void {
  const entry = homes.find((item) => item.home === home);
  if (entry !== undefined) entry.pid = readDaemonState(home)?.pid;
}

function startEndpoint(home: string): string {
  if (process.platform !== 'win32') return path.join(home, 'daemon-start.sock');
  const hash = createHash('sha256').update(path.resolve(home)).update('\0').update(os.userInfo().username).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\shellpuppet-start-${hash}`;
}

async function listen(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.off('error', reject); resolve(); });
  });
}

afterEach(async () => {
  for (const { home, pid } of homes.splice(0)) {
    const state = readDaemonState(home);
    if (state !== null && state.pid === pid) {
      await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } }).catch(() => undefined);
    }
    removeTempHome(home);
  }
});

describe('configured daemon start wrapper', () => {
  it('runs one wrapper for two simultaneous wrapped starters', async () => {
    const { home, marker } = homeWithWrapper(1_200);
    const first = runCli(home, ['daemon', 'start', '--json']);
    await eventually(() => fs.existsSync(marker), 6_000);
    const second = runCli(home, ['daemon', 'start', '--json']);
    const [a, b] = await Promise.all([first, second]);
    recordPid(home);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
    expect((JSON.parse(a.stdout) as { port: number }).port).toBe((JSON.parse(b.stdout) as { port: number }).port);
    expect(readDaemonState(home)?.startedWrapped).toBe(true);
  });

  it('makes a direct starter wait for a pending wrapped start', async () => {
    const { home, marker } = homeWithWrapper(11_000);
    const wrapped = runCli(home, ['daemon', 'start', '--json']);
    await eventually(() => fs.existsSync(marker), 6_000);
    const direct = runCli(home, ['daemon', 'start', '--direct', '--json']);
    const [a, b] = await Promise.all([wrapped, direct]);
    recordPid(home);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect((JSON.parse(a.stdout) as { port: number }).port).toBe((JSON.parse(b.stdout) as { port: number }).port);
    expect(readDaemonState(home)?.startedWrapped).toBe(true);
  }, 140_000);

  it('takes over within two polls when the starting client dies', async () => {
    const { home, marker } = homeWithFailure('hang');
    const spawned = path.join(home, 'takeover-spawned');
    const waiterAbort = new AbortController();
    const holder = spawn(process.execPath, [cli, 'daemon', 'start'], { env: { ...process.env, SHELLPUPPET_HOME: home }, stdio: 'ignore', windowsHide: true });
    try {
      await eventually(() => fs.existsSync(marker), 6_000);
      const waiter = execFileAsync(process.execPath, [boundRunner, '120000', markerEntry], {
        env: { ...process.env, SHELLPUPPET_HOME: home, SP_TEST_SPAWN_MARKER: spawned }, timeout: 45_000, signal: waiterAbort.signal,
      }).then(() => 0, () => 1);
      await new Promise((resolve) => setTimeout(resolve, 450));
      const killedAt = Date.now();
      holder.kill('SIGKILL');
      // The marker is written by the new daemon, so this bound includes the
      // daemon's own start-up; the waiter's take-over itself is one poll.
      await eventually(() => fs.existsSync(spawned), 15_000, 50);
      expect(Date.now() - killedAt).toBeLessThan(15_000);
      expect(await waiter).toBe(0);
      recordPid(home);
      expect(readDaemonState(home)).not.toBeNull();
    } finally {
      waiterAbort.abort();
      recordPid(home);
      holder.kill('SIGKILL');
      if (fs.existsSync(marker)) {
        const pid = Number(fs.readFileSync(marker, 'utf8'));
        if (processAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  }, 20_000);

  it.runIf(process.platform !== 'win32')('reclaims a socket left by a crashed holder', async () => {
    const { home, marker } = homeWithWrapper();
    const ready = path.join(home, 'socket-ready');
    const holder = spawn(process.execPath, [socketHolder, startEndpoint(home), ready], { stdio: 'ignore' });
    try {
      await eventually(() => fs.existsSync(ready), 6_000);
      holder.kill('SIGKILL');
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
      expect(fs.lstatSync(startEndpoint(home)).isSocket()).toBe(true);
      const result = await runCli(home, ['daemon', 'start', '--json']);
      recordPid(home);
      expect(result.code).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.existsSync(startEndpoint(home))).toBe(false);
    } finally { holder.kill('SIGKILL'); }
  });

  it('does not spawn while another client holds the endpoint', async () => {
    const { home, marker } = homeWithWrapper();
    const server = net.createServer((socket) => socket.destroy());
    await listen(server, startEndpoint(home));
    try {
      const starting = runCli(home, ['daemon', 'start', '--json']);
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      expect(fs.existsSync(marker)).toBe(false);
      expect(readDaemonState(home)).toBeNull();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const result = await starting;
      recordPid(home);
      expect(result.code).toBe(0);
    } finally {
      recordPid(home);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stops a daemon whose wrapper is still starting', async () => {
    const { home, marker } = homeWithWrapper(1_200);
    const starting = runCli(home, ['daemon', 'start']);
    await eventually(() => fs.existsSync(marker), 6_000);
    const stopping = runCli(home, ['daemon', 'stop']);
    const [started, stopped] = await Promise.all([starting, stopping]);
    recordPid(home);
    expect(started.code).toBe(0);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain('stopped');
    await eventually(() => readDaemonState(home) === null, 6_000);
  });

  it('restarts only after the pending wrapper has started its daemon', async () => {
    const { home, marker } = homeWithWrapper(1_200);
    const starting = runCli(home, ['daemon', 'start', '--json']);
    await eventually(() => fs.existsSync(marker), 6_000);
    const restarting = runCli(home, ['daemon', 'restart', '--direct', '--json']);
    const [started, restarted] = await Promise.all([starting, restarting]);
    recordPid(home);
    expect(started.code).toBe(0);
    expect(restarted.code).toBe(0);
    expect((JSON.parse(started.stdout) as { port: number }).port).toBeGreaterThan(0);
    expect((JSON.parse(started.stdout) as { startedWrapped: boolean }).startedWrapped).toBe(true);
    expect(readDaemonState(home)?.startedWrapped).toBe(false);
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('keeps a healthy daemon when its wrapper omits the status marker', async () => {
    const { home } = homeWithWrapper();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ viewer: { launchMode: 'no-window' }, daemon: { startWith: [process.execPath, parentWrapper] } }));
    const result = await runCli(home, ['daemon', 'start', '--json']);
    recordPid(home);
    expect(result.code).toBe(0);
    const state = readDaemonState(home);
    expect(state?.startedWrapped).toBe(false);
    expect((await (await fetch(`http://127.0.0.1:${String(state?.port)}/health`)).json() as { ok: boolean }).ok).toBe(true);
  });

  it('refuses a Windows batch wrapper before any process starts', async () => {
    if (process.platform !== 'win32') return;
    const home = makeTempHome('shellpuppet-batch-wrapper-');
    homes.push({ home });
    const batch = path.join(home, 'wrapper.cmd');
    const marker = path.join(home, 'batch-ran');
    fs.writeFileSync(batch, `@echo off\r\n> "${marker}" echo ran\r\nexit /b 1\r\n`);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      viewer: { launchMode: 'no-window' }, daemon: { startWith: [batch, 'made-up-%^&"quoted"'] },
    }));
    const result = await runBound(home, 700);
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/daemon\.startWith.*program itself/);
    expect(readDaemonState(home)).toBeNull();
  });

  it('passes a spaced wrapper path and special argument literally', async () => {
    const home = makeTempHome('shellpuppet-wrapper-args-');
    homes.push({ home });
    const marker = path.join(home, 'recorded-args');
    const spacedWrapper = path.join(home, 'record wrapper with spaces.mjs');
    fs.copyFileSync(recordWrapper, spacedWrapper);
    const literal = 'made-up-%^&"quoted"';
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      viewer: { launchMode: 'no-window' },
      daemon: { startWith: [process.execPath, spacedWrapper, marker, literal] },
    }));
    const result = await runCli(home, ['daemon', 'start']);
    recordPid(home);
    expect(result.code).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(marker, 'utf8')) as { argv: string[] };
    expect(recorded.argv).toEqual([marker, literal, process.execPath, distDaemonEntry]);
  });

  it('ends a hung wrapper tree after the injected bound', async () => {
    const { home, marker } = homeWithFailure('hang');
    try {
      const result = await runBound(home, 700);
      const pid = Number(fs.readFileSync(marker, 'utf8'));
      await eventually(() => !processAlive(pid), 15_000);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('daemon.startWith');
      expect(readDaemonState(home)).toBeNull();
    } finally {
      if (fs.existsSync(marker)) {
        const pid = Number(fs.readFileSync(marker, 'utf8'));
        if (processAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  }, 90_000);

  it('reports an early wrapper exit promptly', async () => {
    const { home, marker } = homeWithFailure('exit');
    const result = await runBound(home, 120_000);
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).toBe(1);
    expect(result.elapsedMs).toBeLessThan(18_000);
    expect(result.stderr).toContain('daemon.startWith');
    expect(readDaemonState(home)).toBeNull();
  }, 90_000);

  it('starts directly and warns once for an oversized wrapper setting', async () => {
    const { home, marker } = homeWithWrapper();
    const configPath = path.join(home, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { daemon: Record<string, unknown> };
    config.daemon['startWith'] = [process.execPath, wrapper, marker, '0', ...Array.from({ length: 13 }, () => 'padding')];
    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await runCli(home, ['daemon', 'start']);
    recordPid(home);
    expect(result.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.stderr).toContain('daemon.startWith');
    expect(result.stderr).toContain('starting directly');
  });

  it('does not echo a malformed wrapper argument', async () => {
    const { home, marker } = homeWithWrapper();
    const fragment = 'made-up-null-argument';
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      viewer: { launchMode: 'no-window' },
      daemon: { startWith: [process.execPath, wrapper, marker, `\0${fragment}`] },
    }));
    const result = await runCli(home, ['daemon', 'start']);
    recordPid(home);
    expect(result.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.stderr).toContain('daemon.startWith');
    expect(result.stdout + result.stderr + fs.readFileSync(path.join(home, 'daemon.log'), 'utf8'))
      .not.toContain(fragment);
  });

  it('keeps malformed wrapper text out of config problems and the daemon log', async () => {
    const home = makeTempHome('shellpuppet-wrapper-json-');
    homes.push({ home });
    const fragment = 'fictional-wrapper-fragment';
    fs.writeFileSync(path.join(home, 'config.json'), `{\n"daemon":{"startWith":["op",${fragment}]}}`);
    const { readDaemonConfig } = await import('../../src/daemon/config.js');
    const parsed = readDaemonConfig(home);
    expect(parsed.problems.join(' ')).toMatch(/config\.json.*line \d+.*column \d+/);
    expect(parsed.problems.join(' ')).toContain('line 2');
    expect(parsed.problems.join(' ')).not.toContain(fragment);
    const result = await runCli(home, ['daemon', 'start']);
    recordPid(home);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8')).not.toContain(fragment);
  });
  it('wraps a start, records status, and skips the wrapper for an existing daemon', async () => {
    const { home, marker } = homeWithWrapper();
    const first = await runCli(home, ['daemon', 'start', '--json']);
    recordPid(home);
    expect(first.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect((JSON.parse(first.stdout) as { startedWrapped?: boolean }).startedWrapped).toBe(true);
    fs.unlinkSync(marker);
    const again = await runCli(home, ['daemon', 'start', '--json']);
    expect(again.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    const status = await runCli(home, ['daemon', 'status', '--json']);
    expect((JSON.parse(status.stdout) as { startedWrapped?: boolean }).startedWrapped).toBe(true);
  });

  it('applies the condition to the daemon environment and keeps values out of output', async () => {
    const { home, marker } = homeWithWrapper();
    const configPath = path.join(home, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { daemon: Record<string, unknown> };
    config.daemon['startWithOnlyIfEnvContains'] = 'op://';
    fs.writeFileSync(configPath, JSON.stringify(config));
    const absent = await runCli(home, ['daemon', 'start', '--json'], { SP_TEST_REFERENCE: 'ordinary-fake' });
    recordPid(home);
    expect(absent.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    await runCli(home, ['daemon', 'stop']);
    const present = await runCli(home, ['daemon', 'start', '--json'], { SP_TEST_REFERENCE: 'op://made-up-value' });
    recordPid(home);
    expect(present.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect(present.stdout + present.stderr + fs.readFileSync(path.join(home, 'daemon.log'), 'utf8'))
      .not.toContain('op://made-up-value');
  });

  it('bypasses the wrapper with the flag or environment override', async () => {
    const { home, marker } = homeWithWrapper();
    const direct = await runCli(home, ['daemon', 'start', '--direct', '--json']);
    recordPid(home);
    expect(direct.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readDaemonState(home)?.startedWrapped).toBe(false);
    await runCli(home, ['daemon', 'stop']);
    const byEnv = await runCli(home, ['daemon', 'start', '--json'], { SHELLPUPPET_DAEMON_DIRECT: '1' });
    recordPid(home);
    expect(byEnv.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('restarts directly and ignores an invalid override value by name', async () => {
    const { home, marker } = homeWithWrapper();
    const first = await runCli(home, ['daemon', 'start']);
    recordPid(home);
    expect(first.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);
    const restarted = await runCli(home, ['daemon', 'restart', '--direct', '--json']);
    recordPid(home);
    expect(restarted.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect((JSON.parse(restarted.stdout) as { startedWrapped?: boolean }).startedWrapped).toBe(false);
    await runCli(home, ['daemon', 'stop']);
    const invalid = await runCli(home, ['daemon', 'start'], { SHELLPUPPET_DAEMON_DIRECT: 'wrong-fake-value' });
    recordPid(home);
    expect(invalid.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect(invalid.stderr).toContain('SHELLPUPPET_DAEMON_DIRECT');
    expect(invalid.stderr).not.toContain('wrong-fake-value');
  });

  it('names a missing wrapper and leaves no daemon', async () => {
    const { home } = homeWithWrapper();
    const configPath = path.join(home, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { daemon: Record<string, unknown> };
    config.daemon['startWith'] = ['missing-wrapper-for-test'];
    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await runCli(home, ['daemon', 'start']);
    recordPid(home);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('daemon.startWith');
    expect(result.stderr).toContain('missing-wrapper-for-test');
    expect(readDaemonState(home)).toBeNull();
  });

  it('allows more than ten seconds for a wrapped start', async () => {
    const { home, marker } = homeWithWrapper(11_000);
    const startedAt = Date.now();
    const result = await runCli(home, ['daemon', 'start', '--json']);
    recordPid(home);
    expect(result.code).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10_000);
    expect(fs.existsSync(marker)).toBe(true);
  }, 140_000);

  it('uses the wrapper when the MCP server auto-starts', async () => {
    const { home, marker } = homeWithWrapper();
    const client = new Client({ name: 'wrapper-test', version: '0.0.0' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [mcp],
        env: { ...process.env, SHELLPUPPET_HOME: home }, stderr: 'pipe',
      }));
      await client.callTool({ name: 'terminal_list', arguments: {} });
      recordPid(home);
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('lets an MCP server bypass the wrapper through the environment', async () => {
    const { home, marker } = homeWithWrapper();
    const client = new Client({ name: 'direct-wrapper-test', version: '0.0.0' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [mcp],
        env: { ...process.env, SHELLPUPPET_HOME: home, SHELLPUPPET_DAEMON_DIRECT: '1' },
        stderr: 'pipe',
      }));
      await client.callTool({ name: 'terminal_list', arguments: {} });
      recordPid(home);
      expect(fs.existsSync(marker)).toBe(false);
      expect(readDaemonState(home)?.startedWrapped).toBe(false);
    } finally {
      await client.close();
    }
  });
});
