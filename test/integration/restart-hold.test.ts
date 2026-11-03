import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDaemon, waitForPendingDaemon } from '../../src/client/http.js';
import { daemonLogPath, daemonStatePath, readDaemonState } from '../../src/daemon/paths.js';
import { readRestartHold, restartHoldPath } from '../../src/daemon/restartHold.js';
import type { Logger } from '../../src/core/types.js';
import { api, distDaemonEntry, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const markerEntry = path.join(repoRoot, 'test', 'integration', 'fixtures', 'daemon-entry-marker.mjs');
const homes: string[] = [];
const started = new Map<string, number>();

async function cli(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: home }, timeout: 35_000,
    });
    const pid = readDaemonState(home)?.pid;
    if (pid !== undefined) started.set(home, pid);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function home(): string {
  const value = makeTempHome('shellpuppet-hold-');
  homes.push(value);
  return value;
}

async function startEndpointOccupied(homePath: string): Promise<boolean> {
  const endpoint = process.platform === 'win32' ?
    `\\\\.\\pipe\\shellpuppet-start-${createHash('sha256').update(path.resolve(homePath)).update('\0')
      .update(os.userInfo().username).digest('hex').slice(0, 32)}` :
    path.join(homePath, 'daemon-start.sock');
  return new Promise<boolean>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(true);
      else reject(error);
    });
    probe.listen(endpoint, () => probe.close(() => resolve(false)));
  });
}

afterEach(async () => {
  for (const value of homes.splice(0)) {
    const state = readDaemonState(value);
    if (state !== null && state.pid === started.get(value)) {
      await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } }).catch(() => undefined);
    }
    removeTempHome(value);
    started.delete(value);
  }
});

describe('planned daemon restart hold', () => {
  it('keeps a peer behind restart from the stop through the new healthy daemon', async () => {
    const value = home();
    const marker = path.join(value, 'peer-started');
    let signalStopping: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => { signalStopping = resolve; });
    let finishStop: () => void = () => undefined;
    const stopCanFinish = new Promise<void>((resolve) => { finishStop = resolve; });
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, version: '0.0.0-stand-in', pid: process.pid }));
      } else if (request.url === '/daemon/shutdown') {
        signalStopping();
        void stopCanFinish.then(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
          response.once('finish', () => { server.close(); });
        });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing stand-in port');
    fs.writeFileSync(daemonStatePath(value), JSON.stringify({ port: address.port, token: 'stand-in-token',
      pid: process.pid, version: '0.0.0-stand-in', startedAt: new Date().toISOString() }));
    const closed = new Promise<void>((resolve) => server.once('close', resolve));
    const restart = cli(value, 'daemon', 'restart');
    await stopping;
    const occupied = await startEndpointOccupied(value).finally(() => finishStop());
    await closed;
    const previous = process.env['SP_TEST_SPAWN_MARKER'];
    process.env['SP_TEST_SPAWN_MARKER'] = marker;
    try {
      const peer = await ensureDaemon({ home: value, daemonEntry: markerEntry });
      started.set(value, peer.pid);
      const result = await restart;
      expect(result.code).toBe(0);
      expect(occupied).toBe(true);
      expect(peer.pid).toBe(readDaemonState(value)?.pid);
      expect(fs.existsSync(marker)).toBe(false);
      const log = fs.readFileSync(daemonLogPath(value), 'utf8');
      expect(log.split('\n').filter((line) => line.includes('"message":"daemon started"'))).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env['SP_TEST_SPAWN_MARKER'];
      else process.env['SP_TEST_SPAWN_MARKER'] = previous;
    }
  }, 60_000);

  it('prevents auto-start within the health bound, then expires', async () => {
    const value = home();
    const stop = await cli(value, 'daemon', 'stop', '--hold', '5');
    expect(stop.code).toBe(0);
    expect(fs.existsSync(restartHoldPath(value))).toBe(true);
    const began = Date.now();
    const attempt = await cli(value, 'list');
    expect(attempt.code).toBe(1);
    expect(attempt.stderr).toContain('stopped for a restart');
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(readDaemonState(value)).toBeNull();
    const connection = await ensureDaemon({ home: value, daemonEntry: distDaemonEntry });
    started.set(value, connection.pid);
    expect(connection.pid).toBeGreaterThan(0);
    expect(fs.existsSync(restartHoldPath(value))).toBe(false);
  }, 45_000);

  it('explicit start ends the hold and a waiting peer connects', async () => {
    const value = home();
    expect((await cli(value, 'daemon', 'stop', '--hold', '30')).code).toBe(0);
    const marker = path.join(value, 'peer-started');
    const previous = process.env['SP_TEST_SPAWN_MARKER'];
    process.env['SP_TEST_SPAWN_MARKER'] = marker;
    try {
      const peer = ensureDaemon({ home: value, daemonEntry: markerEntry }).then(
        (connection) => ({ connection }), (error: unknown) => ({ error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const start = await cli(value, 'daemon', 'start');
      expect(start.code).toBe(0);
      expect(start.stdout).toContain('started on port');
      expect(fs.existsSync(restartHoldPath(value))).toBe(false);
      const result = await peer;
      if ('error' in result) throw result.error;
      const connection = result.connection;
      started.set(value, connection.pid);
      expect(connection.pid).toBe(readDaemonState(value)?.pid);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['SP_TEST_SPAWN_MARKER'];
      else process.env['SP_TEST_SPAWN_MARKER'] = previous;
    }
  }, 45_000);

  it('ignores malformed and over-long records with one warning', async () => {
    const value = home();
    const warnings: string[] = [];
    const logger: Logger = { debug: () => undefined, info: () => undefined, warn: (message) => { warnings.push(message); }, error: () => undefined };
    for (const raw of ['{', JSON.stringify({ expiresAt: Date.now() + 700_000, pid: process.pid })]) {
      fs.writeFileSync(restartHoldPath(value), raw);
      const connection = await ensureDaemon({ home: value, logger, daemonEntry: distDaemonEntry });
      started.set(value, connection.pid);
      expect(warnings.filter((warning) => warning.includes('restart hold record'))).toHaveLength(raw === '{' ? 1 : 2);
      expect(readRestartHold(value, logger)).toBeNull();
      expect(warnings.filter((warning) => warning.includes('restart hold record'))).toHaveLength(raw === '{' ? 1 : 2);
      await api(connection.port, connection.token, '/daemon/shutdown', { body: { force: true } });
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }, 45_000);

  it('rejects invalid durations', async () => {
    const value = home();
    for (const duration of ['0', '601', 'x']) {
      const result = await cli(value, 'daemon', 'stop', '--hold', duration);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('1 to 600');
    }
  }, 45_000);

  it('reports the default hold in text and JSON', async () => {
    const value = home();
    expect((await cli(value, 'daemon', 'stop', '--force', '--hold')).code).toBe(0);
    expect((await cli(value, 'daemon', 'status')).stdout).toContain('restart hold ends in');
    const status = await cli(value, 'daemon', 'status', '--json');
    const body = JSON.parse(status.stdout) as { running: boolean; holdRemainingSeconds: number };
    expect(body.running).toBe(false);
    expect(body.holdRemainingSeconds).toBeGreaterThan(110);
    expect(body.holdRemainingSeconds).toBeLessThanOrEqual(120);
  }, 45_000);

  it('makes a pending-start waiter honour the hold', async () => {
    const value = home();
    expect((await cli(value, 'daemon', 'stop', '--hold', '30')).code).toBe(0);
    await expect(waitForPendingDaemon({ home: value })).rejects.toThrow('stopped for a restart');
    expect(readDaemonState(value)).toBeNull();
  }, 20_000);
});
