/**
 * `shellpuppet start` reports problems with config `envNames` on a start that
 * names a variable, and only then: the real CLI and a real daemon on an
 * isolated home.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDaemonState } from '../../src/daemon/paths.js';
import { api, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const home = makeTempHome('shellpuppet-env-names-');
const VALUE = 'env-names-fixture-5c1d';
const REPORTER = "console.log('REPORT'); setInterval(() => {}, 200)";

function writeConfig(text: string): void {
  fs.writeFileSync(path.join(home, 'config.json'), text);
}

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: home, SP_TEST_ENV_NAME: VALUE },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

beforeAll(async () => {
  writeConfig(JSON.stringify({ viewer: { launchMode: 'none' }, sessionEnv: 'clean' }));
  await cli('list');
}, 60_000);

afterAll(async () => {
  const state = readDaemonState(home);
  if (state !== null) {
    try {
      await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } });
    } catch {
      // Daemon already gone.
    }
  }
  removeTempHome(home);
}, 120_000);

describe('shellpuppet start and config envNames problems', () => {
  it('says nothing about envNames on a start with no --env-name', async () => {
    writeConfig(JSON.stringify({ viewer: { launchMode: 'none' }, sessionEnv: 'clean', envNames: 'SP_TEST_ENV_NAME' }));
    const started = await cli('start', '--no-shell', process.execPath, '-e', REPORTER);
    expect(started.code).toBe(0);
    expect(started.stderr).not.toContain('envNames');
    const id = /^(s\d+) /m.exec(started.stdout)?.[1];
    if (id !== undefined) await cli('kill', id);
  }, 90_000);

  it('reports a list that is not one when --env-name is used, and starts nothing', async () => {
    writeConfig(JSON.stringify({ viewer: { launchMode: 'none' }, sessionEnv: 'clean', envNames: 'SP_TEST_ENV_NAME' }));
    const started = await cli('start', '--env-name', 'SP_TEST_ENV_NAME', '--no-shell', process.execPath, '-e', REPORTER);
    expect(started.code).toBe(2);
    expect(started.stderr).toContain('warning: envNames in config.json must be an array of variable names: passing none');
    expect(started.stdout + started.stderr).not.toContain(VALUE);
  }, 90_000);
});

describe('shellpuppet start with a config.json that does not parse', () => {
  it('says the file does not parse, rather than only that the name is not listed', async () => {
    writeConfig('{ "envNames": ["SP_TEST_ENV_NAME"], ');
    try {
      const started = await cli('start', '--env-name', 'SP_TEST_ENV_NAME', '--no-shell', process.execPath, '-e', REPORTER);
      expect(started.code).toBe(2);
      expect(started.stdout + started.stderr).not.toContain(VALUE);
      expect(started.stderr).toMatch(/not valid JSON|could not be parsed/);
    } finally {
      writeConfig(JSON.stringify({ viewer: { launchMode: 'none' }, sessionEnv: 'clean' }));
    }
  }, 90_000);
});
