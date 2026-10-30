/**
 * `daemon status` makes two requests after finding the daemon, `/sessions`
 * and then `/environment`, and neither may start a daemon. A stand-in answers
 * `/sessions` and vanishes on `/environment`, so the second request is the
 * one that meets a daemon that has gone.
 *
 * `daemon restart`'s stop half uses the same rule. A stand-in that vanishes
 * on the shutdown request must not be replaced until the start half, which
 * is the one start the verb is allowed to make.
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

const STAND_IN = `
import * as http from 'node:http';
import process from 'node:process';
import { setInterval } from 'node:timers';
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.0.0-stand-in', pid: process.pid }));
    return;
  }
  if (req.url === '/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [], version: '0.0.0-stand-in' }));
    return;
  }
  server.close();
  server.closeAllConnections();
  setInterval(() => undefined, 1_000);
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;
  process.stdout.write(JSON.stringify({ port, pid: process.pid }) + '\\n');
});
`;

const children: ChildProcess[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
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

async function standIn(prefix: string): Promise<{ home: string; port: number; pid: number }> {
  const home = makeTempHome(prefix);
  homes.push(home);
  const script = path.join(home, 'stand-in.mjs');
  fs.writeFileSync(script, STAND_IN);
  const child = spawn(process.execPath, [script], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
  });
  const { port, pid } = JSON.parse(line) as { port: number; pid: number };
  fs.writeFileSync(
    daemonStatePath(home),
    JSON.stringify({ port, token: 't', pid, version: '0.0.0-stand-in', startedAt: new Date().toISOString() }),
  );
  return { home, port, pid };
}

describe('daemon status when the daemon goes at /environment', () => {
  it('reports what it saw and starts nothing', async () => {
    const { home, port, pid } = await standIn('shellpuppet-status-env-');
    const { stdout } = await execFileAsync(process.execPath, [cliEntry, 'daemon', 'status'], {
      env: { ...process.env, SHELLPUPPET_HOME: home },
      timeout: 60_000,
      windowsHide: true,
    });
    expect(stdout).toContain(`running on port ${String(port)}`);
    expect(readDaemonState(home)?.pid).toBe(pid);
    expect(fs.existsSync(daemonLogPath(home))).toBe(false);
  }, 60_000);
});

describe('daemon restart when the daemon goes during its stop half', () => {
  it('starts one daemon, from the start half', async () => {
    const { home, pid } = await standIn('shellpuppet-restart-stop-');
    const { stdout } = await execFileAsync(process.execPath, [cliEntry, 'daemon', 'restart'], {
      env: { ...process.env, SHELLPUPPET_HOME: home },
      timeout: 60_000,
      windowsHide: true,
    });
    expect(stdout).toContain('restarted on port');
    expect(readDaemonState(home)?.pid).not.toBe(pid);
    const log = fs.readFileSync(daemonLogPath(home), 'utf8');
    const starts = log.split('\n').filter((line) => line.includes('"message":"daemon started"'));
    expect(starts).toHaveLength(1);
  }, 60_000);
});
