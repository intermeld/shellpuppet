/**
 * `daemon status` and `daemon stop` ask about a daemon; they must never start
 * one (design §2.3). A daemon that goes between being found and being asked,
 * as one that is stopping does, would otherwise be replaced by a fresh one
 * from whatever build is on disk at that moment: in the middle of a stop, a
 * rebuild and a start, a daemon from the old build, holding its files.
 *
 * A stand-in answers `/health` and then, on the next request, stops listening
 * while its process lives on, as a stopping daemon does. Every other verb
 * keeps auto-start (design §2.2), which the last case pins.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonLogPath, daemonStatePath, readDaemonState } from '../../src/daemon/paths.js';
import { api, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const STAND_IN = path.join(repoRoot, 'test', 'integration', 'fixtures', 'slow-health.mjs');

const children: ChildProcess[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    // A daemon a verb started, when one did, is stopped by its own record.
    const state = readDaemonState(home);
    if (state !== null && !children.some((child) => child.pid === state.pid)) {
      await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } }).catch(
        () => undefined,
      );
    }
    removeTempHome(home);
  }
  for (const child of children.splice(0)) child.kill();
});

/** A home whose daemon.json names a stand-in that vanishes on its second request. */
async function homeWithVanishingDaemon(mode = 'vanish'): Promise<{ home: string; pid: number }> {
  const home = makeTempHome('shellpuppet-verbs-');
  homes.push(home);
  const child = spawn(process.execPath, [STAND_IN, '0', mode], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
  });
  const { port, pid } = JSON.parse(line) as { port: number; pid: number };
  fs.writeFileSync(
    daemonStatePath(home),
    JSON.stringify({
      port,
      token: 'stand-in-token',
      pid,
      version: '0.0.0-stand-in',
      ...(mode.startsWith('standalone-') || mode === 'embedded-stop' ? { instanceId: 'stand-in-instance' } : {}),
      startedAt: new Date().toISOString(),
    }),
  );
  return { home, pid };
}

async function cli(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string; elapsed: number }> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: home },
      timeout: 80_000,
    });
    return { code: 0, stdout, stderr, elapsed: Date.now() - started };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '', elapsed: Date.now() - started };
  }
}

/** No daemon was started: the record still names the stand-in, and no daemon wrote a log. */
function expectNoDaemonStarted(home: string, standIn: number): void {
  expect(readDaemonState(home)?.pid).toBe(standIn);
  expect(fs.existsSync(daemonLogPath(home))).toBe(false);
}

describe('daemon verbs on a daemon that goes as it is asked', () => {
  it('treats a standalone exit between preflight and handle acquisition as stopped', async () => {
    const { home, pid } = await homeWithVanishingDaemon('standalone-preflight-exit');
    const result = await cli(home, 'daemon', 'stop', '--json');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ running: false, stopped: true });
    expect(children.find((child) => child.pid === pid)?.exitCode).toBe(0);
    expect(readDaemonState(home)).toBeNull();
    expect(fs.existsSync(daemonLogPath(home))).toBe(false);
  }, 30_000);

  it('waits for the accepted standalone process exit and retains warnings', async () => {
    const { home } = await homeWithVanishingDaemon('standalone-exit');
    const result = await cli(home, 'daemon', 'stop', '--force', '--json');
    expect(result.code, result.stderr).toBe(0);
    expect(result.elapsed).toBeGreaterThanOrEqual(1_000);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopped: true, warnings: ['snapshot warning'] });
  }, 20_000);

  it('reports a surviving standalone process and keeps a requested hold', async () => {
    const { home, pid } = await homeWithVanishingDaemon('standalone-survive');
    const result = await cli(home, 'daemon', 'stop', '--force', '--hold', '1', '--json');
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('"stopped":true');
    expect(JSON.parse(result.stdout)).toMatchObject({ stopped: false, warnings: ['snapshot warning'] });
    expect(result.stderr).toContain(`pid ${String(pid)}`);
    expect(result.stderr).toContain('stand-in-instance');
    expect(fs.existsSync(path.join(home, 'restart-hold.json'))).toBe(true);
  }, 80_000);

  it('waits for exit when an accepted shutdown loses its response', async () => {
    const { home } = await homeWithVanishingDaemon('standalone-lost-exit');
    const result = await cli(home, 'daemon', 'stop', '--force', '--hold', '1', '--json');
    expect(result.code, result.stderr).toBe(0);
    expect(result.elapsed).toBeGreaterThanOrEqual(7_000);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopped: true, holdRemainingSeconds: 1 });
    expect(fs.existsSync(path.join(home, 'restart-hold.json'))).toBe(true);
  }, 30_000);

  it('reports in-progress without a hold when the response is lost and the process survives', async () => {
    const { home, pid } = await homeWithVanishingDaemon('standalone-lost-survive');
    const result = await cli(home, 'daemon', 'stop', '--force', '--hold', '1', '--json');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopped: false, instanceId: 'stand-in-instance' });
    expect(result.stderr).toContain(`pid ${String(pid)}`);
    expect(fs.existsSync(path.join(home, 'restart-hold.json'))).toBe(false);
  }, 100_000);

  it('keeps the legacy completion rule after stop-info returns 404', async () => {
    const { home, pid } = await homeWithVanishingDaemon();
    const result = await cli(home, 'daemon', 'stop', '--force', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ running: false, stopped: true });
    expect(children.find((child) => child.pid === pid)?.exitCode).toBeNull();
  }, 30_000);

  it('keeps the legacy completion rule when stop-info has no capability', async () => {
    const { home, pid } = await homeWithVanishingDaemon('legacy-no-cap');
    const result = await cli(home, 'daemon', 'stop', '--force', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ running: false, stopped: true });
    expect(children.find((child) => child.pid === pid)?.exitCode).toBeNull();
  }, 30_000);

  it('completes an embedded stop while its host remains alive', async () => {
    const { home, pid } = await homeWithVanishingDaemon('embedded-stop');
    const result = await cli(home, 'daemon', 'stop', '--force', '--json');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopped: true, warnings: ['snapshot warning'] });
    expect(children.find((child) => child.pid === pid)?.exitCode).toBeNull();
  }, 30_000);

  it('refuses a shutdown response naming a different instance', async () => {
    const { home } = await homeWithVanishingDaemon('standalone-mismatch');
    const result = await cli(home, 'daemon', 'stop', '--force', '--hold', '1', '--json');
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('"stopped":true');
    expect(result.stderr).toContain('daemon changed');
    expect(fs.existsSync(path.join(home, 'restart-hold.json'))).toBe(false);
  }, 30_000);

  it('status reports not running, and starts nothing', async () => {
    const { home, pid } = await homeWithVanishingDaemon();
    const result = await cli(home, 'daemon', 'status');
    expect(result.stdout.trim()).toBe('not running');
    expect(result.code).toBe(0);
    expectNoDaemonStarted(home, pid);
  }, 60_000);

  it('status --json reports running: false, and starts nothing', async () => {
    const { home, pid } = await homeWithVanishingDaemon();
    const result = await cli(home, 'daemon', 'status', '--json');
    expect(JSON.parse(result.stdout)).toEqual({ running: false });
    expectNoDaemonStarted(home, pid);
  }, 60_000);

  it('stop reports not running, and starts nothing to stop', async () => {
    const { home, pid } = await homeWithVanishingDaemon();
    const result = await cli(home, 'daemon', 'stop', '--force');
    expect(result.stdout.trim()).toBe('not running');
    expect(result.code).toBe(0);
    expectNoDaemonStarted(home, pid);

    const { home: second, pid: secondPid } = await homeWithVanishingDaemon();
    const json = await cli(second, 'daemon', 'stop', '--force', '--json');
    expect(JSON.parse(json.stdout)).toEqual({ running: false, stopped: true });
    expectNoDaemonStarted(second, secondPid);
  }, 60_000);

  it('an ordinary verb still starts a daemon in place of one that went', async () => {
    const { home, pid } = await homeWithVanishingDaemon();
    const result = await cli(home, 'list', '--json');
    expect(result.code).toBe(0);
    const state = readDaemonState(home);
    expect(state).not.toBeNull();
    expect(state?.pid).not.toBe(pid);
  }, 60_000);
});
