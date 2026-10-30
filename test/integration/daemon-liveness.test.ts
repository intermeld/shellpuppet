/**
 * A daemon that is alive but slow to answer is busy, not gone (design §2.3).
 * Clearing its state file, or starting a second daemon beside it, would leave
 * every session in the first unreachable for any new client, while the first
 * kept running. These pin that a client and a starting daemon both tell a busy
 * daemon from a dead one, that a client never moves to another daemon while
 * the one it holds is alive and that a running daemon publishes its state
 * file again when the file goes missing, holds no record or names a daemon
 * that has gone.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverDaemon, ensureDaemon, request, type DaemonConnection } from '../../src/client/http.js';
import {
  daemonStatePath,
  inspectDaemonState,
  readDaemonState,
  removeDaemonStateIf,
  removeDaemonStateIfNotARecord,
} from '../../src/daemon/paths.js';
import { AlreadyRunningError, Daemon } from '../../src/daemon/server.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import { eventually, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const fixtures = path.join(repoRoot, 'test', 'integration', 'fixtures');
const STAND_IN = path.join(fixtures, 'slow-health.mjs');
const RECORD_SPAWN = path.join(fixtures, 'record-spawn.mjs');

const children: ChildProcess[] = [];
const daemons: Daemon[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  for (const child of children.splice(0)) child.kill();
  for (const home of homes.splice(0)) removeTempHome(home);
});

function tempHome(): string {
  const home = makeTempHome('shellpuppet-liveness-');
  homes.push(home);
  return home;
}

/** Start a stand-in daemon and wait for the port it listens on. */
async function standIn(
  delay: number | 'never',
  other: 'destroy' | 'answer' = 'destroy',
): Promise<{ port: number; pid: number; child: ChildProcess }> {
  const child = spawn(process.execPath, [STAND_IN, String(delay), other], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
  });
  const { port, pid } = JSON.parse(line) as { port: number; pid: number };
  return { port, pid, child };
}

function writeState(home: string, port: number, pid: number): void {
  fs.writeFileSync(
    daemonStatePath(home),
    JSON.stringify({
      port,
      token: 'incumbent-token',
      pid,
      version: '0.0.0-stand-in',
      startedAt: new Date().toISOString(),
    }),
  );
}

const spawnedMarker = (home: string): string => path.join(home, 'spawned');

/**
 * Make a file unreadable but still removable: on Windows by denying its data to
 * Everyone (by SID, so no account name has to resolve), elsewhere by mode 000.
 * Reports whether this process can no longer read it (root still can).
 */
function denyRead(file: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [file, '/deny', '*S-1-1-0:(RD)'], { windowsHide: true, stdio: 'ignore' });
    } else {
      fs.chmodSync(file, 0o000);
    }
    fs.readFileSync(file);
    return false;
  } catch {
    return true;
  }
}

function allowRead(file: string): void {
  if (!fs.existsSync(file)) return;
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/remove:d', '*S-1-1-0'], { windowsHide: true, stdio: 'ignore' });
  } else {
    fs.chmodSync(file, 0o600);
  }
}

describe('a client meeting a daemon that is slow to answer', () => {
  it('waits for it rather than clearing its state or starting a second daemon', async () => {
    const home = tempHome();
    const incumbent = await standIn(2_500);
    writeState(home, incumbent.port, incumbent.pid);

    const connection = await ensureDaemon({ home, daemonEntry: RECORD_SPAWN });

    expect(connection.port).toBe(incumbent.port);
    expect(readDaemonState(home)?.pid).toBe(incumbent.pid);
    expect(fs.existsSync(spawnedMarker(home))).toBe(false);
  }, 30_000);

  it('reports a live daemon that never answers as busy, and still leaves it alone', async () => {
    const home = tempHome();
    const incumbent = await standIn('never');
    writeState(home, incumbent.port, incumbent.pid);

    await expect(ensureDaemon({ home, daemonEntry: RECORD_SPAWN })).rejects.toThrow(
      /did not answer/,
    );

    expect(readDaemonState(home)?.pid).toBe(incumbent.pid);
    expect(fs.existsSync(spawnedMarker(home))).toBe(false);
  }, 40_000);

  it('clears a daemon that goes while it is given longer to answer, rather than reporting it busy', async () => {
    const home = tempHome();
    const incumbent = await standIn('never');
    writeState(home, incumbent.port, incumbent.pid);
    // After the first health check and the liveness probe (about 1.5 s), during
    // the longer waits.
    const killer = setTimeout(() => incumbent.child.kill(), 2_500);
    try {
      expect(await discoverDaemon({ home })).toBeNull();
    } finally {
      clearTimeout(killer);
    }
    expect(fs.existsSync(daemonStatePath(home))).toBe(false);
  }, 40_000);

  it('clears a record whose pid is alive but whose port refuses (a pid reused after a reboot)', async () => {
    const home = tempHome();
    const closed = await standIn(0);
    closed.child.kill();
    await eventually(() => closed.child.exitCode !== null || closed.child.signalCode !== null);
    // This test's own process stands in for whatever now owns the old pid.
    writeState(home, closed.port, process.pid);

    expect(await discoverDaemon({ home })).toBeNull();
    expect(fs.existsSync(daemonStatePath(home))).toBe(false);
  }, 30_000);

  it('clears a record whose port accepts but whose pid has gone (a reused port)', async () => {
    const home = tempHome();
    const gone = await standIn(0);
    gone.child.kill();
    await eventually(() => gone.child.exitCode !== null || gone.child.signalCode !== null);
    // Something else listens on a port, but never answers as a daemon would.
    const squatter = await standIn('never');
    writeState(home, squatter.port, gone.pid);

    expect(await discoverDaemon({ home })).toBeNull();
    expect(fs.existsSync(daemonStatePath(home))).toBe(false);
  }, 30_000);

  it('still clears the state of a daemon that has gone', async () => {
    const home = tempHome();
    const gone = await standIn(0);
    gone.child.kill();
    await eventually(() => gone.child.exitCode !== null || gone.child.signalCode !== null);
    writeState(home, gone.port, gone.pid);

    expect(await discoverDaemon({ home })).toBeNull();
    expect(fs.existsSync(daemonStatePath(home))).toBe(false);
  }, 30_000);
});

describe('clearing a stale record', () => {
  it('removes the state file only while it still names the daemon being cleared', () => {
    const home = tempHome();
    writeState(home, 4_242, 4_242);

    removeDaemonStateIf(home, { pid: 4_243, port: 4_242 });
    removeDaemonStateIf(home, { pid: 4_242, port: 4_243 });
    expect(readDaemonState(home)?.pid).toBe(4_242);

    removeDaemonStateIf(home, { pid: 4_242, port: 4_242 });
    expect(fs.existsSync(daemonStatePath(home))).toBe(false);
  });

  it('tells a record, a file that holds none, a missing file and a failed read apart', () => {
    const home = tempHome();
    expect(inspectDaemonState(home).kind).toBe('missing');

    fs.writeFileSync(daemonStatePath(home), '');
    expect(inspectDaemonState(home)).toEqual({ kind: 'not-a-record', raw: '' });
    fs.writeFileSync(daemonStatePath(home), JSON.stringify({ port: '1', token: 't', pid: 1 }));
    expect(inspectDaemonState(home).kind).toBe('not-a-record');

    writeState(home, 4_242, 4_242);
    expect(inspectDaemonState(home).kind).toBe('record');

    // A read that fails says nothing about what the file holds.
    fs.rmSync(daemonStatePath(home));
    fs.mkdirSync(daemonStatePath(home));
    expect(inspectDaemonState(home).kind).toBe('unreadable');
  });

  it('removes a file that holds no record only while it still holds the same content', () => {
    const home = tempHome();
    fs.writeFileSync(daemonStatePath(home), 'not a record');

    removeDaemonStateIfNotARecord(home, 'other content');
    expect(fs.readFileSync(daemonStatePath(home), 'utf8')).toBe('not a record');

    // A record claimed in its place in the meantime stays.
    writeState(home, 4_242, 4_242);
    removeDaemonStateIfNotARecord(home, 'not a record');
    expect(readDaemonState(home)?.pid).toBe(4_242);

    fs.writeFileSync(daemonStatePath(home), 'not a record');
    removeDaemonStateIfNotARecord(home, 'not a record');
    expect(fs.existsSync(daemonStatePath(home))).toBe(false);
  });
});

describe('a daemon starting beside one that is slow to answer', () => {
  it('defers to the live incumbent and leaves its state alone', async () => {
    const home = tempHome();
    const incumbent = await standIn('never');
    writeState(home, incumbent.port, incumbent.pid);

    const rival = new Daemon({ home, logger: NULL_LOGGER });
    daemons.push(rival);
    await expect(rival.start()).rejects.toBeInstanceOf(AlreadyRunningError);

    expect(readDaemonState(home)?.pid).toBe(incumbent.pid);
  }, 40_000);
});

describe('a daemon starting beside a file that holds no record', () => {
  it('clears the file and claims it', async () => {
    const home = tempHome();
    fs.writeFileSync(daemonStatePath(home), '{"port":');

    const daemon = new Daemon({ home, logger: NULL_LOGGER });
    daemons.push(daemon);
    await daemon.start();

    expect(readDaemonState(home)?.pid).toBe(process.pid);
  }, 30_000);
});

describe('a client holding a connection to a live daemon', () => {
  it('does not move to the daemon the state file names when a request fails', async () => {
    const home = tempHome();
    const held = await standIn(0, 'destroy');
    const other = await standIn(0, 'answer');
    writeState(home, other.port, other.pid);

    const connection: DaemonConnection = {
      port: held.port,
      pid: held.pid,
      token: 'held-token',
      version: '0.0.0-stand-in',
      warnings: [],
    };
    await expect(request(connection, 'GET', '/sessions', undefined, { home })).rejects.toThrow();

    expect(connection.port).toBe(held.port);
    expect(connection.pid).toBe(held.pid);
  }, 30_000);
});

describe('a running daemon and its state file', () => {
  it('publishes the file again when it goes missing', async () => {
    const home = tempHome();
    const daemon = new Daemon({ home, logger: NULL_LOGGER, statePublishCheckMs: 100 });
    daemons.push(daemon);
    await daemon.start();

    fs.rmSync(daemonStatePath(home));
    await eventually(() => readDaemonState(home)?.pid === process.pid, 10_000);
  }, 30_000);

  it('leaves a file it cannot read in place when it stops', async (context) => {
    const home = tempHome();
    const daemon = new Daemon({ home, logger: NULL_LOGGER, statePublishCheckMs: 60_000 });
    daemons.push(daemon);
    await daemon.start();

    // Another daemon's record, which this one cannot read.
    fs.rmSync(daemonStatePath(home));
    writeState(home, 4_242, 4_242);
    if (!denyRead(daemonStatePath(home))) context.skip();
    try {
      await daemon.stop();
      expect(fs.existsSync(daemonStatePath(home))).toBe(true);
    } finally {
      allowRead(daemonStatePath(home));
    }
  }, 30_000);

  it('replaces a file that holds no daemon record', async () => {
    const home = tempHome();
    const daemon = new Daemon({ home, logger: NULL_LOGGER, statePublishCheckMs: 100 });
    daemons.push(daemon);
    await daemon.start();

    fs.writeFileSync(daemonStatePath(home), '');
    await eventually(() => readDaemonState(home)?.pid === process.pid, 10_000);
  }, 30_000);

  it('takes the file back from a daemon that has gone', async () => {
    const home = tempHome();
    const daemon = new Daemon({ home, logger: NULL_LOGGER, statePublishCheckMs: 100 });
    daemons.push(daemon);
    await daemon.start();

    const gone = await standIn(0);
    gone.child.kill();
    await eventually(() => gone.child.exitCode !== null || gone.child.signalCode !== null);
    fs.rmSync(daemonStatePath(home));
    writeState(home, gone.port, gone.pid);

    await eventually(() => readDaemonState(home)?.pid === process.pid, 10_000);
  }, 30_000);

  it('leaves the file alone while it names another daemon that is alive, and says so once', async () => {
    const home = tempHome();
    const warnings: string[] = [];
    const logger = { ...NULL_LOGGER, warn: (message: string) => void warnings.push(message) };
    const daemon = new Daemon({ home, logger, statePublishCheckMs: 100 });
    daemons.push(daemon);
    await daemon.start();

    const other = await standIn(0, 'answer');
    fs.rmSync(daemonStatePath(home));
    writeState(home, other.port, other.pid);

    // Fifteen checks or so.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(readDaemonState(home)?.pid).toBe(other.pid);
    expect(warnings.filter((message) => message.includes('names another running daemon'))).toHaveLength(1);
  }, 30_000);
});
