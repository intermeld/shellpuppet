/**
 * `shellpuppet start --env-name` (design §4.6): the CLI copies only the
 * variables the human listed in config `envNames` from its own environment
 * into a session's, as `terminal_start`'s `envNames` does for the MCP server.
 * The real CLI, a real daemon and real PTYs. The home sets
 * `sessionEnv: "clean"`, so a variable that reached the session by the
 * daemon's own inheritance cannot pass for one this feature carried.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogPath } from '../../src/daemon/audit.js';
import { daemonLogPath, readDaemonState } from '../../src/daemon/paths.js';
import { api, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const home = makeTempHome('shellpuppet-cli-env-');

const PASSED_VALUE = 'passed-value-7e1a';
const SECOND_VALUE = 'second-value-3f60';
const UNNAMED_VALUE = 'unnamed-value-d2c8';
const AGENT_VALUE = 'agent-value-b913';
const VALUES = [PASSED_VALUE, SECOND_VALUE, UNNAMED_VALUE, AGENT_VALUE];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function writeConfig(envNames: string[], agentPassEnv: Record<string, string[]> = { qoder: ['SP_TEST_AGENT'] }): void {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      viewer: { launchMode: 'none' },
      sessionEnv: 'clean',
      envNames,
      agents: { passEnv: agentPassEnv },
    }),
  );
}

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SHELLPUPPET_HOME: home };
  env['SP_TEST_PASSED'] = PASSED_VALUE;
  env['SP_TEST_SECOND'] = SECOND_VALUE;
  env['SP_TEST_UNNAMED'] = UNNAMED_VALUE;
  env['SP_TEST_AGENT'] = AGENT_VALUE;
  delete env['SP_TEST_LISTED_UNSET'];
  return env;
}

async function cli(...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: cliEnv(),
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const REPORTER =
  "console.log('REPORT listed:' + (process.env.SP_TEST_PASSED ?? 'none') + ' second:' + " +
  "(process.env.SP_TEST_SECOND ?? 'none') + ' other:' + (process.env.SP_TEST_UNNAMED ?? 'none') + ' agent:' + " +
  "(process.env.SP_TEST_AGENT ?? 'none')); " +
  'setInterval(() => {}, 200)';

/** Start a session that prints what it can see of the three variables. */
async function startReporter(...envFlags: string[]): Promise<CliResult & { id: string }> {
  // --no-shell: the reporter goes straight to node, never through a shell
  // that would read its `>` as a redirect.
  const result = await cli('start', ...envFlags, '--no-shell', process.execPath, '-e', REPORTER);
  const id = /^(s\d+) /m.exec(result.stdout)?.[1] ?? '';
  return { ...result, id };
}

async function screenOf(id: string): Promise<string> {
  const waited = await cli('wait', id, '--text', 'REPORT', '--timeout', '20000', '--debounce', '300');
  return waited.stdout;
}

async function sessionCount(): Promise<number> {
  const listed = await cli('list');
  return listed.stdout.match(/^s\d+ {2}/gm)?.length ?? 0;
}

beforeAll(() => {
  writeConfig(['SP_TEST_PASSED', 'SP_TEST_SECOND', 'SP_TEST_LISTED_UNSET']);
});

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

describe('shellpuppet start --agent (agents.passEnv)', () => {
  it('passes the agent\'s listed variables with no flag, and prints no value', async () => {
    const started = await startReporter('--agent', 'qoder');
    expect(started.code).toBe(0);
    expect(started.stderr).toContain("Passed for qoder from this shell's environment: SP_TEST_AGENT.");
    for (const value of VALUES) expect(started.stdout + started.stderr).not.toContain(value);
    const screen = await screenOf(started.id);
    expect(screen).toContain(`agent:${AGENT_VALUE}`);
    expect(screen).toContain('listed:none');
  }, 90_000);

  it('gives an agent with no list nothing', async () => {
    const started = await startReporter('--agent', 'codex');
    expect(started.code).toBe(0);
    expect(await screenOf(started.id)).toContain('agent:none');
  }, 90_000);

  it('refuses --env-name off the agent\'s list with exit 2, and starts nothing', async () => {
    const before = await sessionCount();
    const started = await startReporter('--agent', 'qoder', '--env-name', 'SP_TEST_PASSED');
    expect(started.code).toBe(2);
    expect(started.stderr).toContain('agents.passEnv.qoder');
    expect(started.stderr).toContain('SP_TEST_PASSED');
    for (const value of VALUES) expect(started.stdout + started.stderr).not.toContain(value);
    expect(await sessionCount()).toBe(before);
  }, 90_000);

  it('reads the agent lists on every run: a list changed in config applies to the next start', async () => {
    writeConfig(['SP_TEST_PASSED', 'SP_TEST_SECOND', 'SP_TEST_LISTED_UNSET'], { qoder: ['SP_TEST_AGENT'], codex: ['SP_TEST_AGENT'] });
    try {
      const started = await startReporter('--agent', 'codex');
      expect(await screenOf(started.id)).toContain(`agent:${AGENT_VALUE}`);
    } finally {
      writeConfig(['SP_TEST_PASSED', 'SP_TEST_SECOND', 'SP_TEST_LISTED_UNSET']);
    }
  }, 90_000);
});

describe('shellpuppet start --env-name', () => {
  it('passes a listed variable and nothing it was not asked for, and prints no value', async () => {
    const started = await startReporter('--env-name', 'SP_TEST_PASSED');
    expect(started.code).toBe(0);
    expect(started.stderr).toContain("Passed from this shell's environment: SP_TEST_PASSED.");
    for (const value of VALUES) expect(started.stdout + started.stderr).not.toContain(value);
    const screen = await screenOf(started.id);
    expect(screen).toContain(`listed:${PASSED_VALUE}`);
    expect(screen).toContain('second:none');
    expect(screen).toContain('other:none');
  }, 90_000);

  it('passes each name of a repeated flag', async () => {
    const started = await startReporter('--env-name', 'SP_TEST_PASSED', '--env-name', 'SP_TEST_SECOND');
    expect(started.stderr).toContain("Passed from this shell's environment: SP_TEST_PASSED, SP_TEST_SECOND.");
    const screen = await screenOf(started.id);
    expect(screen).toContain(`listed:${PASSED_VALUE}`);
    expect(screen).toContain(`second:${SECOND_VALUE}`);
  }, 90_000);

  it('passes nothing when no names are given', async () => {
    const started = await startReporter();
    const screen = await screenOf(started.id);
    expect(screen).toContain('listed:none');
    expect(screen).toContain('other:none');
  }, 90_000);

  it('refuses a name the human did not list, naming it, with exit 2, and starts nothing', async () => {
    const before = await sessionCount();
    const started = await startReporter('--env-name', 'SP_TEST_PASSED', '--env-name', 'SP_TEST_UNNAMED');
    expect(started.code).toBe(2);
    expect(started.stderr).toContain('SP_TEST_UNNAMED');
    expect(started.stderr).toContain('envNames in ~/.shellpuppet/config.json');
    for (const value of VALUES) expect(started.stdout + started.stderr).not.toContain(value);
    expect(await sessionCount()).toBe(before);
  }, 90_000);

  it('reports a listed name that is not set here, by name, and still starts', async () => {
    const started = await startReporter('--env-name', 'SP_TEST_LISTED_UNSET', '--env-name', 'SP_TEST_PASSED');
    expect(started.code).toBe(0);
    expect(started.stderr).toContain("Not set in this shell's environment, so not passed: SP_TEST_LISTED_UNSET.");
    expect(await screenOf(started.id)).toContain(`listed:${PASSED_VALUE}`);
  }, 90_000);

  it('--no-viewer says no window opened and prints no link', async () => {
    const started = await startReporter('--no-viewer');
    expect(started.code).toBe(0);
    expect(started.stdout).toContain(`viewer: none opened (--no-viewer); viewer-url ${started.id} mints a link`);
    expect(started.stdout).not.toContain('/view');
  }, 90_000);

  it('needs a value for the flag', async () => {
    const result = await cli('start', '--env-name');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--env-name needs a value.');
  });

  it('reads the list on every run: a name added to it passes on the next start, with no restart', async () => {
    const refused = await startReporter('--env-name', 'SP_TEST_UNNAMED');
    expect(refused.code).toBe(2);
    writeConfig(['SP_TEST_PASSED', 'SP_TEST_SECOND', 'SP_TEST_LISTED_UNSET', 'SP_TEST_UNNAMED']);
    try {
      const started = await startReporter('--env-name', 'SP_TEST_UNNAMED');
      expect(started.code).toBe(0);
      expect(await screenOf(started.id)).toContain(`other:${UNNAMED_VALUE}`);
    } finally {
      writeConfig(['SP_TEST_PASSED', 'SP_TEST_SECOND', 'SP_TEST_LISTED_UNSET']);
    }
  }, 90_000);

  it('passes nothing from a list under mcp.passEnv, says the list is read from envNames, and starts nothing', async () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ viewer: { launchMode: 'none' }, sessionEnv: 'clean', mcp: { passEnv: ['SP_TEST_PASSED'] } }),
    );
    try {
      const before = await sessionCount();
      const started = await startReporter('--env-name', 'SP_TEST_PASSED');
      expect(started.code).toBe(2);
      expect(started.stderr).toContain('warning: mcp.passEnv is not read, so nothing passes from it');
      expect(started.stderr).toContain('read from envNames');
      expect(started.stderr).toContain('SP_TEST_PASSED is not listed in envNames');
      for (const value of VALUES) expect(started.stdout + started.stderr).not.toContain(value);
      expect(await sessionCount()).toBe(before);
    } finally {
      writeConfig(['SP_TEST_PASSED', 'SP_TEST_SECOND', 'SP_TEST_LISTED_UNSET']);
    }
  }, 90_000);

  it('keeps every value out of --json output, the audit trail and the daemon log, and audits the names', async () => {
    const json = await cli('start', '--json', '--env-name', 'SP_TEST_PASSED', '--no-shell', process.execPath, '-e', REPORTER);
    expect(json.code).toBe(0);
    for (const value of VALUES) expect(json.stdout).not.toContain(value);
    const audit = fs.readFileSync(auditLogPath(home), 'utf8');
    const starts = audit
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { action: string; meta?: { envNames?: string[] } })
      .filter((line) => line.action === 'start');
    expect(starts.some((line) => line.meta?.envNames?.includes('SP_TEST_PASSED'))).toBe(true);
    for (const value of VALUES) {
      expect(audit).not.toContain(value);
      expect(fs.readFileSync(daemonLogPath(home), 'utf8')).not.toContain(value);
    }
  }, 90_000);
});
