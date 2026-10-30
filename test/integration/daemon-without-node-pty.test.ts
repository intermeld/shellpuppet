/**
 * The compiled daemon on an install where node-pty will not load. It starts
 * and answers, and a session start is refused with what to do, word for word.
 * A preload makes both an import and a require of node-pty fail as a missing
 * package does, so this runs the daemon's real loading path on every platform.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explainLoadFailure } from '../../src/core/nativePty.js';
import { readDaemonState } from '../../src/daemon/paths.js';
import type { DaemonState } from '../../src/daemon/paths.js';
import { api, distDaemonEntry, eventually, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const preload = pathToFileURL(path.join(repoRoot, 'test', 'integration', 'fixtures', 'without-node-pty.mjs')).href;

let home: string;
let daemon: ChildProcess;
let state: DaemonState;
let exited = false;

beforeAll(async () => {
  home = makeTempHome('shellpuppet-no-pty-');
  daemon = spawn(process.execPath, ['--import', preload, distDaemonEntry], {
    env: { ...process.env, SHELLPUPPET_HOME: home },
    stdio: 'ignore',
  });
  daemon.on('exit', () => {
    exited = true;
  });
  // A daemon that loads node-pty as it starts dies here, before it has
  // written its state file.
  await eventually(() => exited || readDaemonState(home) !== null, 30_000);
  expect(exited).toBe(false);
  const found = readDaemonState(home);
  if (found === null) throw new Error('the daemon wrote no state file');
  state = found;
});

afterAll(async () => {
  if (!exited) {
    await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } }).catch(() => undefined);
    await eventually(() => exited, 30_000).catch(() => daemon.kill());
  }
  removeTempHome(home);
});

describe('the compiled daemon without node-pty', () => {
  it('answers, and refuses a start with what to do, as written', async () => {
    const health = await api(state.port, null, '/health');
    expect(health.status).toBe(200);
    expect((await api(state.port, state.token, '/sessions')).body['sessions']).toEqual([]);

    const refused = await api(state.port, state.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', ''], shell: false, label: 'no-node-pty' },
    });
    expect(refused.status).toBe(500);
    expect(refused.body).toEqual({ error: explainLoadFailure(new Error("Cannot find module 'node-pty'")) });

    // The refusal leaves the daemon as it was.
    expect((await api(state.port, null, '/health')).status).toBe(200);
    expect((await api(state.port, state.token, '/sessions')).body['sessions']).toEqual([]);
    expect(exited).toBe(false);
  });
});
