import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDaemon, waitForPendingDaemon, withDaemonStartLock } from '../../src/client/http.js';
import { daemonLogPath, daemonStatePath, readDaemonState } from '../../src/daemon/paths.js';
import { readRestartHold, restartHoldPath, writeRestartHold } from '../../src/daemon/restartHold.js';
import type { Logger } from '../../src/core/types.js';
import { api, distDaemonEntry, makeTempHome, processAlive, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const markerEntry = path.join(repoRoot, 'test', 'integration', 'fixtures', 'daemon-entry-marker.mjs');
const failureWrapper = path.join(repoRoot, 'test', 'fixtures', 'daemon-start-failure.mjs');
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

function replacementHold(homePath: string, instanceId: string, oldPid: number, startedAt: string): void {
  fs.writeFileSync(restartHoldPath(homePath), JSON.stringify({ expiresAt: Date.now() + 30_000,
    pid: process.pid, replacing: { instanceId, startMode: 'direct', pid: oldPid, port: 1, startedAt } }));
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
  it('uses the health response identity when the record changes during discovery', async () => {
    const value = home();
    const oldId = 'old-instance';
    const newId = 'new-instance';
    const oldServer = http.createServer((request, response) => {
      if (request.url !== '/health') return;
      const address = newServer.address();
      if (address === null || typeof address === 'string') throw new Error('missing new port');
      fs.writeFileSync(daemonStatePath(value), JSON.stringify({ port: address.port, token: 'new-token',
        pid: process.pid + 1, version: 'new', startedAt: new Date().toISOString(), instanceId: newId }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, version: 'old', pid: process.pid, instanceId: oldId }));
    });
    const newServer = http.createServer((request, response) => {
      if (request.url !== '/health') return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, version: 'new', pid: process.pid + 1, instanceId: newId }));
    });
    try {
      await new Promise<void>((resolve) => oldServer.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve) => newServer.listen(0, '127.0.0.1', resolve));
      const address = oldServer.address();
      if (address === null || typeof address === 'string') throw new Error('missing old port');
      const startedAt = new Date().toISOString();
      fs.writeFileSync(daemonStatePath(value), JSON.stringify({ port: address.port, token: 'old-token',
        pid: process.pid, version: 'old', startedAt, instanceId: oldId }));
      replacementHold(value, oldId, process.pid, startedAt);
      const connection = await ensureDaemon({ home: value });
      expect(connection.instanceId).toBe(newId);
      expect(connection.version).toBe('new');
    } finally {
      await new Promise<void>((resolve) => oldServer.close(() => resolve()));
      await new Promise<void>((resolve) => newServer.close(() => resolve()));
    }
  }, 30_000);

  it('accepts a replacement with a reused pid and start timestamp', async () => {
    const value = home();
    const server = http.createServer((request, response) => {
      if (request.url !== '/health') return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, version: 'new', pid: process.pid, instanceId: 'new-instance' }));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing port');
      fs.writeFileSync(daemonStatePath(value), JSON.stringify({ port: address.port, token: 'token',
        pid: process.pid, version: 'new', startedAt: 'same-time', instanceId: 'new-instance' }));
      replacementHold(value, 'old-instance', process.pid, 'same-time');
      const connection = await ensureDaemon({ home: value });
      expect(connection.instanceId).toBe('new-instance');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('starts immediately when the process that wrote the hold has gone', async () => {
    const value = home();
    fs.writeFileSync(restartHoldPath(value), JSON.stringify({ expiresAt: Date.now() + 120_000,
      pid: 99_999_999, replacing: { instanceId: 'old-instance', startMode: 'direct',
        pid: process.pid, port: 1, startedAt: 'same-time' } }));
    const startedAt = Date.now();
    const connection = await ensureDaemon({ home: value, daemonEntry: distDaemonEntry });
    started.set(value, connection.pid);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 25_000);

  it('keeps one deadline when a restart hold is rewritten', async () => {
    const value = home();
    const write = (): void => replacementHold(value, 'old-instance', process.pid, 'same-time');
    write();
    const timer = setInterval(write, 250);
    try {
      const result = await Promise.race([
        waitForPendingDaemon({ home: value }).then(() => 'settled', () => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('overran'), 23_000)),
      ]);
      expect(result).toBe('settled');
    } finally { clearInterval(timer); }
  }, 27_000);

  it('refuses restart when the daemon record is unreadable', async () => {
    const value = home();
    fs.writeFileSync(daemonStatePath(value), '{');
    const result = await cli(value, 'daemon', 'restart');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Wait about 15 seconds');
    expect(result.stderr).toContain('daemon restart');
    expect(result.stderr).toContain('daemon start');
    expect(result.stderr).toContain('usually');
    expect(result.stderr).toContain('check that no ShellPuppet daemon process is running');
    expect(result.stderr).not.toContain('daemon stop');
    expect(readDaemonState(value)).toBeNull();
  }, 20_000);

  it('refuses restart when the daemon record is missing', async () => {
    const value = home();
    const result = await cli(value, 'daemon', 'restart');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Wait about 15 seconds');
    expect(result.stderr).toContain('daemon restart');
    expect(result.stderr).toContain('daemon start');
    expect(result.stderr).toContain('usually');
    expect(result.stderr).toContain('check that no ShellPuppet daemon process is running');
    expect(result.stderr).not.toContain('daemon stop');
    expect(readDaemonState(value)).toBeNull();
  }, 20_000);
  it.each([true, false])('keeps a peer behind restart from the stop through the new healthy daemon (old id: %s)', async (oldHasId) => {
    const value = home();
    const marker = path.join(value, 'peer-started');
    let signalStopping: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => { signalStopping = resolve; });
    let finishStop: () => void = () => undefined;
    const stopCanFinish = new Promise<void>((resolve) => { finishStop = resolve; });
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, version: '0.0.0-stand-in', pid: process.pid,
          ...(oldHasId ? { instanceId: 'old-instance' } : {}) }));
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
      pid: process.pid, version: '0.0.0-stand-in', startedAt: new Date().toISOString(),
      ...(oldHasId ? { instanceId: 'old-instance' } : {}) }));
    fs.writeFileSync(path.join(value, 'config.json'), JSON.stringify({ daemon: { startWith: [process.execPath] } }));
    const closed = new Promise<void>((resolve) => server.once('close', resolve));
    const restart = cli(value, 'daemon', 'restart', '--direct');
    const reachedStop = await Promise.race([stopping.then(() => true), restart.then(() => false)]);
    if (!reachedStop) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(reachedStop).toBe(true);
      return;
    }
    expect(readRestartHold(value, { debug: () => undefined, info: () => undefined,
      warn: () => undefined, error: () => undefined })?.replacing?.startMode).toBe('direct');
    const replaced = readRestartHold(value, { debug: () => undefined, info: () => undefined,
      warn: () => undefined, error: () => undefined })?.replacing;
    expect(replaced?.instanceId).toBe(oldHasId ? 'old-instance' : undefined);
    expect(replaced?.pid).toBe(process.pid);
    expect(replaced?.port).toBe(address.port);
    const previous = process.env['SP_TEST_SPAWN_MARKER'];
    process.env['SP_TEST_SPAWN_MARKER'] = marker;
    try {
      const occupied = await startEndpointOccupied(value);
      const peerPromise = ensureDaemon({ home: value, daemonEntry: markerEntry });
      let settled = false;
      void peerPromise.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(settled).toBe(false);
      finishStop();
      await closed;
      const peer = await peerPromise;
      started.set(value, peer.pid);
      const result = await restart;
      expect(result.code).toBe(0);
      expect(occupied).toBe(true);
      expect(peer.pid).toBe(readDaemonState(value)?.pid);
      expect(fs.existsSync(marker)).toBe(false);
      const log = fs.readFileSync(daemonLogPath(value), 'utf8');
      expect(log.split('\n').filter((line) => line.includes('"message":"daemon started"'))).toHaveLength(1);
    } finally {
      finishStop();
      await restart;
      const state = readDaemonState(value);
      if (state !== null) started.set(value, state.pid);
      if (previous === undefined) delete process.env['SP_TEST_SPAWN_MARKER'];
      else process.env['SP_TEST_SPAWN_MARKER'] = previous;
    }
  }, 60_000);

  it('starts in the same call when a one-second hold expires', async () => {
    const value = home();
    writeRestartHold(value, 1);
    const connection = await ensureDaemon({ home: value, daemonEntry: distDaemonEntry });
    started.set(value, connection.pid);
    expect(connection.pid).toBe(readDaemonState(value)?.pid);
    expect(fs.existsSync(restartHoldPath(value))).toBe(false);
  }, 20_000);

  it('keeps the start poll inside the deadline after an eight-second hold', async () => {
    const value = home();
    writeRestartHold(value, 8);
    const began = Date.now();
    await expect(ensureDaemon({ home: value, daemonEntry: path.join(value, 'missing-daemon.mjs') }))
      .rejects.toThrow('did not settle within its health bound');
    expect(Date.now() - began).toBeLessThan(12_000);
    expect(readDaemonState(value)).toBeNull();
  }, 30_000);

  it('keeps busy discovery inside the deadline when state appears late in a hold', async () => {
    const value = home();
    writeRestartHold(value, 8);
    const busy = http.createServer(() => undefined);
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const address = busy.address();
    if (address === null || typeof address === 'string') throw new Error('missing busy port');
    const publish = setTimeout(() => fs.writeFileSync(daemonStatePath(value), JSON.stringify({
      port: address.port, token: 'busy-token', pid: process.pid, version: '0.0.0-busy',
      startedAt: new Date().toISOString(), instanceId: 'busy-instance',
    })), 7_200);
    try {
      const began = Date.now();
      await expect(ensureDaemon({ home: value })).rejects.toThrow('running but did not answer in time');
      expect(Date.now() - began).toBeLessThan(12_000);
    } finally {
      clearTimeout(publish);
      busy.closeAllConnections();
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  }, 25_000);

  it('ends a live wrapper before a held call rejects at its deadline', async () => {
    const value = home();
    const marker = path.join(value, 'wrapper-pid');
    fs.writeFileSync(path.join(value, 'config.json'), JSON.stringify({
      daemon: { startWith: [process.execPath, failureWrapper, 'hang', marker] },
    }));
    writeRestartHold(value, 8, { instanceId: 'old-instance', pid: process.pid,
      port: 1, startMode: 'direct' });
    let pid: number | undefined;
    try {
      const began = Date.now();
      await expect(ensureDaemon({ home: value })).rejects.toThrow('did not settle within its health bound');
      const elapsed = Date.now() - began;
      expect(fs.existsSync(marker)).toBe(true);
      pid = Number(fs.readFileSync(marker, 'utf8'));
      const parentPid = Number(fs.readFileSync(`${marker}.parent`, 'utf8'));
      expect(processAlive(pid), `wrapper pid=${String(pid)}, test child=${String(parentPid === process.pid)}, ` +
        `parent pid=${String(parentPid)}, exit status=unknown, elapsed=${String(elapsed)} ms`).toBe(false);
      expect(elapsed).toBeLessThan(36_000);
      expect(await startEndpointOccupied(value)).toBe(false);
    } finally {
      if (pid !== undefined && processAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 40_000);

  it('starts in the same call when a hold is removed early', async () => {
    const value = home();
    writeRestartHold(value, 30);
    const pending = ensureDaemon({ home: value, daemonEntry: distDaemonEntry });
    setTimeout(() => fs.unlinkSync(restartHoldPath(value)), 350);
    const connection = await pending;
    started.set(value, connection.pid);
    expect(connection.pid).toBe(readDaemonState(value)?.pid);
  }, 20_000);

  it('lets a pending-start waiter finish when its hold expires', async () => {
    const value = home();
    writeRestartHold(value, 1);
    await expect(waitForPendingDaemon({ home: value })).resolves.toBeNull();
    expect(fs.existsSync(restartHoldPath(value))).toBe(false);
  }, 20_000);

  it('does not follow a linked hold record', ({ skip }) => {
    const value = home();
    const target = path.join(value, 'linked-target.json');
    fs.writeFileSync(target, JSON.stringify({ expiresAt: Date.now() + 30_000, pid: process.pid }));
    try { fs.symlinkSync(target, restartHoldPath(value), 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        skip('Creating symbolic links is unavailable on this platform');
        return;
      }
      throw error;
    }
    const warnings: string[] = [];
    const logger: Logger = { debug: () => undefined, info: () => undefined, warn: (message) => { warnings.push(message); }, error: () => undefined };
    expect(readRestartHold(value, logger)).toBeNull();
    expect(readRestartHold(value, logger)).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('treats a directory hold record as malformed and warns once', () => {
    const value = home();
    fs.mkdirSync(restartHoldPath(value));
    const warnings: string[] = [];
    const logger: Logger = { debug: () => undefined, info: () => undefined, warn: (message) => { warnings.push(message); }, error: () => undefined };
    expect(readRestartHold(value, logger)).toBeNull();
    expect(readRestartHold(value, logger)).toBeNull();
    expect(warnings).toEqual(['ignoring invalid restart hold record']);
  });

  it('does not overwrite a hard-linked temporary pathname', () => {
    const value = home();
    const sentinel = path.join(value, 'sentinel');
    fs.writeFileSync(sentinel, 'unchanged');
    fs.linkSync(sentinel, path.join(value, `.restart-hold-${String(process.pid)}.tmp`));
    writeRestartHold(value, 5);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
  });

  it('removes old regular temporary records when writing a hold', () => {
    const value = home();
    const oldFile = path.join(value, '.restart-hold-old.tmp');
    const recentFile = path.join(value, '.restart-hold-recent.tmp');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(recentFile, 'recent');
    const oldTime = new Date(Date.now() - 3_700_000);
    fs.utimesSync(oldFile, oldTime, oldTime);
    writeRestartHold(value, 5);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.readFileSync(recentFile, 'utf8')).toBe('recent');
  });

  it('waits through a slow stop and a slow direct start', async () => {
    const value = home();
    let stopRequested: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => { stopRequested = resolve; });
    const oldServer = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, version: '0.0.0-old', pid: process.pid, instanceId: 'old-instance' }));
      } else if (request.url === '/daemon/shutdown') {
        stopRequested();
        response.writeHead(200);
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) => oldServer.listen(0, '127.0.0.1', resolve));
    const oldAddress = oldServer.address();
    if (oldAddress === null || typeof oldAddress === 'string') throw new Error('missing old port');
    const startedAt = new Date().toISOString();
    fs.writeFileSync(daemonStatePath(value), JSON.stringify({ port: oldAddress.port, token: 'old-token',
      pid: process.pid, version: '0.0.0-old', startedAt, instanceId: 'old-instance' }));
    let replacement: http.Server | undefined;
    let replacementPort = -1;
    try {
      const coordinator = withDaemonStartLock({ home: value }, async () => {
        writeRestartHold(value, 30, { instanceId: 'old-instance', pid: process.pid,
          port: oldAddress.port, startMode: 'direct' });
        const shutdown = fetch(`http://127.0.0.1:${String(oldAddress.port)}/daemon/shutdown`, { method: 'POST' });
        await stopping;
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        fs.unlinkSync(daemonStatePath(value));
        await new Promise<void>((resolve) => oldServer.close(() => resolve()));
        await shutdown;
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        replacement = http.createServer((request, response) => {
          if (request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, version: '0.0.0-new', pid: process.pid + 1, instanceId: 'new-instance' }));
          }
        });
        await new Promise<void>((resolve) => replacement?.listen(0, '127.0.0.1', resolve));
        const address = replacement.address();
        if (address === null || typeof address === 'string') throw new Error('missing replacement port');
        replacementPort = address.port;
        fs.writeFileSync(daemonStatePath(value), JSON.stringify({ port: address.port, token: 'new-token',
          pid: process.pid + 1, version: '0.0.0-new', startedAt: new Date().toISOString(), instanceId: 'new-instance' }));
      });
      await stopping;
      const connection = await ensureDaemon({ home: value, daemonEntry: markerEntry });
      await coordinator;
      expect(connection.port).toBe(replacementPort);
      expect(connection.pid).toBe(process.pid + 1);
    } finally {
      await new Promise<void>((resolve) => oldServer.close(() => resolve()));
      if (replacement !== undefined) await new Promise<void>((resolve) => replacement?.close(() => resolve()));
    }
  }, 30_000);

  it('prevents auto-start during a hold, then starts when it expires', async () => {
    const value = home();
    const stop = await cli(value, 'daemon', 'stop', '--hold', '5');
    expect(stop.code).toBe(0);
    expect(fs.existsSync(restartHoldPath(value))).toBe(true);
    const began = Date.now();
    const attempt = await cli(value, 'list');
    expect(attempt.code).toBe(0);
    expect(Date.now() - began).toBeGreaterThanOrEqual(4_000);
    expect(Date.now() - began).toBeLessThan(15_000);
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
