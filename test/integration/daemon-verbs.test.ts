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
async function homeWithVanishingDaemon(): Promise<{ home: string; pid: number }> {
  const home = makeTempHome('shellpuppet-verbs-');
  homes.push(home);
  const child = spawn(process.execPath, [STAND_IN, '0', 'vanish'], {
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
      startedAt: new Date().toISOString(),
    }),
  );
  return { home, pid };
}

async function cli(home: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: home },
      timeout: 60_000,
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '' };
  }
}

/** No daemon was started: the record still names the stand-in, and no daemon wrote a log. */
function expectNoDaemonStarted(home: string, standIn: number): void {
  expect(readDaemonState(home)?.pid).toBe(standIn);
  expect(fs.existsSync(daemonLogPath(home))).toBe(false);
}

describe('daemon verbs on a daemon that goes as it is asked', () => {
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
