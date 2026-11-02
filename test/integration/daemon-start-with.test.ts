import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonState } from '../../src/daemon/paths.js';
import * as clientHttp from '../../src/client/http.js';
import { api, distDaemonEntry, eventually, makeTempHome, processAlive, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
const mcp = path.join(repoRoot, 'dist', 'mcp', 'index.js');
const wrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-wrapper.mjs');
const failureWrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-failure.mjs');
const recordWrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-record.mjs');
const boundRunner = path.join(repoRoot, 'test', 'integration', 'fixtures', 'ensure-daemon-bound.mjs');
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
  it('refuses a Windows batch wrapper before any process starts', async () => {
    if (process.platform !== 'win32') return;
    const home = makeTempHome('shellpuppet-batch-wrapper-');
    homes.push({ home });
    const batch = path.join(home, 'wrapper.cmd');
    const marker = path.join(home, 'batch-ran');
    fs.writeFileSync(batch, '@echo off\r\n');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      viewer: { launchMode: 'no-window' }, daemon: { startWith: [batch] },
    }));
    const planner = (clientHttp as { planDaemonStart?: (wrapper: string[], entry: string, cwd: string, env: NodeJS.ProcessEnv) => unknown }).planDaemonStart;
    expect(planner).toBeTypeOf('function');
    expect(() => planner?.([batch], 'entry', home, process.env)).toThrow(/daemon\.startWith.*program itself/);
    const result = await runCli(home, ['daemon', 'start']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/daemon\.startWith.*program itself/);
    expect(fs.existsSync(marker)).toBe(false);
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
    const planner = (clientHttp as { planDaemonStart?: (wrapper: string[], entry: string, cwd: string, env: NodeJS.ProcessEnv) => { args: string[] } }).planDaemonStart;
    expect(planner).toBeTypeOf('function');
    expect(planner?.([process.execPath, spacedWrapper, marker, literal], 'entry', home, process.env).args[2]).toBe(literal);
    const result = await runCli(home, ['daemon', 'start']);
    recordPid(home);
    expect(result.code).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(marker, 'utf8')) as { argv: string[] };
    expect(recorded.argv).toEqual([marker, literal, process.execPath, distDaemonEntry]);
  });

  it('ends a hung wrapper tree after the injected bound', async () => {
    expect(clientHttp.WRAPPED_START_TIMEOUT_MS).toBe(120_000);
    const { home, marker } = homeWithFailure('hang');
    try {
      const result = await runBound(home, 700);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('daemon.startWith');
      const pid = Number(fs.readFileSync(marker, 'utf8'));
      await eventually(() => !processAlive(pid), 15_000);
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

  it('lets a direct starter win a race with one wrapped starter', async () => {
    const { home, marker } = homeWithFailure('hang');
    try {
      const wrapped = clientHttp.ensureDaemon({ home, daemonEntry: distDaemonEntry });
      await eventually(() => fs.existsSync(marker), 6_000);
      const direct = clientHttp.ensureDaemon({ home, daemonEntry: distDaemonEntry, direct: true });
      const [wrappedConnection, directConnection] = await Promise.all([wrapped, direct]);
      recordPid(home);
      expect(wrappedConnection.pid).toBe(directConnection.pid);
      const state = readDaemonState(home);
      expect(state?.pid).toBe(directConnection.pid);
      expect(state?.startedWrapped).toBe(false);
      expect((await (await fetch(`http://127.0.0.1:${String(state?.port)}/health`)).json() as { ok: boolean }).ok).toBe(true);
      const wrapperPid = Number(fs.readFileSync(marker, 'utf8'));
      await eventually(() => !processAlive(wrapperPid), 10_000);
    } finally {
      recordPid(home);
      if (fs.existsSync(marker)) {
        const pid = Number(fs.readFileSync(marker, 'utf8'));
        if (processAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
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
