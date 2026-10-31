/**
 * CLI integration tests: every invocation is the real compiled one-shot
 * binary against a real (auto-started) daemon: the full production path,
 * including the §2.2 promptness guarantee.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { daemonLogPath, readDaemonState } from '../../src/daemon/paths.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const execFileAsync = promisify(execFile);
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const home = makeTempHome('shellpuppet-cli-');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/**
 * Every CLI invocation gets a minute. That is far more than any verb needs
 * warm, and it is a promptness bound rather than a performance measurement:
 * the tests that care about how fast a call returns assert it themselves.
 * On a heavily loaded machine a `kill` can take longer than thirty seconds.
 */
const CLI_BUDGET_MS = 60_000;

async function cli(...args: string[]): Promise<CliResult> {
  return cliWithin(CLI_BUDGET_MS, ...args);
}

/** The same invocation from another daemon home, for tests about what a
 * command leaves behind: the shared `home` above has a daemon running. */
async function cliFromHome(homeDir: string, ...args: string[]): Promise<CliResult> {
  return cliFromHomeWithEnv(homeDir, {}, ...args);
}

/** The same invocation with extra environment variables for the CLI and the
 * daemon it auto-starts. */
async function cliFromHomeWithEnv(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<CliResult> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: homeDir, ...env },
      timeout: CLI_BUDGET_MS,
    });
    return { code: 0, stdout, stderr, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * The same invocation with a stated budget, for the one verb that waits on a
 * browser. The minute above is a promptness bound on verbs that answer from
 * the daemon; a screenshot starts Chromium, and detection alone was measured
 * at nearly 10 s on a macOS runner.
 */
async function cliWithin(timeout: number, ...args: string[]): Promise<CliResult> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, SHELLPUPPET_HOME: home },
      timeout,
    });
    return { code: 0, stdout, stderr, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * What a failed assertion on an exit code says. The code alone cannot tell a
 * request the daemon refused from a process ended from outside, which exits 1
 * with nothing on stderr, so the message carries stderr, the end of stdout
 * and the warnings and errors in the daemon's log, which is where a failed
 * capture says why.
 */
function whatHappened(result: CliResult, homeDir: string = home): string {
  let logged: string[] = [];
  try {
    logged = fs
      .readFileSync(daemonLogPath(homeDir), 'utf8')
      .split('\n')
      .filter((line) => /"level":"(warn|error)"/.test(line))
      .slice(-10);
  } catch {
    // No log: no daemon has run in that home.
  }
  return [
    `exit ${String(result.code)} after ${String(result.elapsedMs)} ms`,
    `stderr: ${result.stderr.trim() || '(empty)'}`,
    `stdout: ${result.stdout.trim().slice(-500) || '(empty)'}`,
    `daemon warnings and errors: ${logged.length === 0 ? 'none' : `\n${logged.join('\n')}`}`,
  ].join('\n');
}

afterAll(async () => {
  await cli('daemon', 'stop', '--force');
  removeTempHome(home);
});

describe('shellpuppet CLI', () => {
  it('filters waiting questions in list and refuses a filtered screenshot without a signature', async () => {
    const question = 'Reveal the turquoise accordion? (y/n)';
    const encoded = Buffer.from(question).toString('base64');
    const started = await cli('start', '--no-viewer', '--no-shell', process.execPath,
      '-e', `console.log(Buffer.from('${encoded}','base64').toString()); setInterval(() => {}, 500)`);
    expect(started.code, whatHappened(started)).toBe(0);
    const id = started.stdout.split(/\s+/)[0]!;
    try {
      const state = readDaemonState(home);
      expect(state).not.toBeNull();
      await eventually(async () => {
        const listed = await api(state!.port, state!.token, '/sessions');
        return JSON.stringify(listed.body).includes(`"question":"${question}"`);
      }, 20_000);
      const plain = await cli('list');
      expect(plain.stdout).toContain(question);
      const hidden = await cli('list', '--hide-reasoning');
      expect(hidden.code, whatHappened(hidden)).toBe(0);
      expect(hidden.stdout).toContain(id);
      expect(hidden.stdout).toContain('WAITING');
      expect(hidden.stdout).not.toContain(question);
      const screenshot = await cli('screenshot', id, '--hide-reasoning');
      expect(screenshot.code).toBe(2);
      expect(screenshot.stderr).toContain('no agent signature');
    } finally {
      await cli('kill', id);
    }
  }, 60_000);

  it('drives a full session lifecycle end to end', async () => {
    // start: auto-starts the daemon (cold) and returns promptly regardless.
    const started = await cli(
      'start',
      '--no-shell',
      '--label',
      'cli-e2e',
      process.execPath,
      '-e',
      "console.log('cli-e2e-marker'); setInterval(() => {}, 200)",
    );
    expect(started.code, whatHappened(started)).toBe(0);
    expect(started.stdout).toMatch(/^s\d+ {2}cli-e2e/m);
    expect(started.stdout).toContain('viewer: http://127.0.0.1:');
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';

    // Every one-shot invocation must exit promptly: the §2.2 guarantee.
    // Warm calls skip the spawn entirely, so give the cold call headroom and
    // hold the warm ones to a tight bound.
    expect(started.elapsedMs).toBeLessThan(15_000);

    const wait = await cli('wait', id, '--text', 'cli-e2e-marker', '--timeout', '20000');
    expect(wait.code, whatHappened(wait)).toBe(0);
    expect(wait.stderr).toContain('matched');
    expect(wait.elapsedMs).toBeLessThan(8_000);

    const list = await cli('list');
    expect(list.code, whatHappened(list)).toBe(0);
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain('live');

    const snap = await cli('snap', id);
    expect(snap.code, whatHappened(snap)).toBe(0);
    expect(snap.stdout).toContain('cli-e2e-marker');

    const json = await cli('snap', id, '--json');
    expect((JSON.parse(json.stdout) as { screen: string }).screen).toContain('cli-e2e-marker');

    // The verb, not just the route: `--read-only` has to be a flag the CLI
    // knows, or it slides into the positionals.
    const link = await cli('viewer-url', id, '--read-only');
    expect(link.code, whatHappened(link)).toBe(0);
    expect(link.stdout).toContain(`/view?s=${id}&vt=`);
    expect(link.stdout).toContain('watch-only');

    const killed = await cli('kill', id);
    expect(killed.code, whatHappened(killed)).toBe(0);
    expect(killed.stdout).toContain(`killed ${id}`);

    const after = await cli('list');
    expect(after.stdout).not.toContain(`${id} `);
  });

  it('screenshot writes a PNG where it was told and says so in JSON', async (context) => {
    // The verb, not the route: --out has to reach the file it names, and the
    // JSON has to carry what a script would branch on. Skipped where no
    // Chromium-family browser is installed, as in viewer-capture.
    if ((await findBrowser()) === null) {
      context.skip();
      return;
    }
    const started = await cli(
      'start',
      '--no-shell',
      '--label',
      'cli-shot',
      '--cols',
      '100',
      '--rows',
      '30',
      // Held, so the grid the JSON reports is the grid that was asked for.
      '--hold',
      process.execPath,
      '-e',
      "console.log('cli-shot-marker'); setInterval(() => {}, 200)",
    );
    expect(started.code, whatHappened(started)).toBe(0);
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    const painted = await cli('wait', id, '--text', 'cli-shot-marker', '--timeout', '20000');
    expect(painted.code, whatHappened(painted)).toBe(0);
    // The session must die whether the capture worked or not: left alive, it
    // would fail the daemon tests after it, because a daemon with a live
    // session will not stop.
    try {
      const out = path.join(home, 'cli-shot.png');
      const shot = await cliWithin(
        90_000,
        'screenshot',
        id,
        '--out',
        out,
        '--width',
        '800',
        '--height',
        '600',
        '--json',
      );
      expect(shot.code, whatHappened(shot)).toBe(0);
      const body = JSON.parse(shot.stdout) as Record<string, unknown>;
      expect(body['width']).toBe(800);
      expect(body['height']).toBe(600);
      expect(body['cols']).toBe(100);
      expect(body['rows']).toBe(30);
      expect(body['path']).toBe(path.resolve(out));
      // The bytes, not just the claim.
      expect(fs.readFileSync(out).subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    } finally {
      await cli('kill', id);
    }
  }, 150_000);

  it("exercises the README's five CLI steps", async () => {
    // This invocation (bare `node`, --no-shell) is the first thing any new
    // user runs, and it depends on PATH resolution. Keep the sequence in step
    // with the README's.
    const started = await cli('start', '--label', 'smoke', '--no-shell', 'node');
    expect(started.code, whatHappened(started)).toBe(0);
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';

    const wait = await cli('wait', id, '--quiet', '1000', '--timeout', '15000');
    expect(wait.code, whatHappened(wait)).toBe(0);

    const typed = await cli('type', id, '6 * 7', '--enter', '--verify');
    expect(typed.code, whatHappened(typed)).toBe(0);
    expect(typed.stdout).toContain('verified on screen');

    await eventually(async () => (await cli('snap', id)).stdout.includes('42'), 15_000);

    const killed = await cli('kill', id);
    expect(killed.code, whatHappened(killed)).toBe(0);
  });

  it("flags after the command belong to the command, not to shellpuppet", async () => {
    // Options go before the command; everything after passes through
    // verbatim, so `start goose --version` hands --version to Goose rather
    // than booting a full interactive Goose with its MCP fleet.
    const started = await cli('start', '--no-shell', '--label', 'passthrough', process.execPath, '--version');
    expect(started.code, whatHappened(started)).toBe(0);
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    const wait = await cli('wait', id, '--text', 'v', '--timeout', '15000', '--debounce', '300');
    expect(wait.code, whatHappened(wait)).toBe(0);
    // node --version printed its version: proof the flag reached node.
    expect(wait.stdout).toMatch(/v\d+\.\d+\.\d+/);
    await cli('kill', id);
  });

  it('type --verify confirms text landed in an echoing session', async () => {
    const started = await cli('start', '--no-shell', '--label', 'repl', process.execPath);
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    await cli('wait', id, '--quiet', '700', '--timeout', '15000');

    const typed = await cli('type', id, '1 + 1', '--verify');
    expect(typed.code, whatHappened(typed)).toBe(0);
    expect(typed.stdout).toContain('typed');
    await cli('kill', id);
  });

  it('type --verify reports swallowed input against a raw-mode app that discards it (§3.1)', async () => {
    // Raw mode disables PTY echo and the script never prints what it reads:
    // the deterministic stand-in for a TUI silently swallowing keystrokes.
    const started = await cli(
      'start',
      '--no-shell',
      process.execPath,
      '-e',
      "process.stdin.setRawMode(true); process.stdin.resume(); console.log('swallower-up')",
    );
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    const ready = await cli('wait', id, '--text', 'swallower-up', '--timeout', '15000');
    expect(ready.code, whatHappened(ready)).toBe(0);

    const typed = await cli('type', id, 'does-not-land', '--verify');
    expect(typed.code, whatHappened(typed)).toBe(1);
    expect(typed.stdout).toContain('did NOT appear');
    await cli('kill', id);
  });

  it('wait exits 3 when the condition does not hold, so scripts can branch', async () => {
    const started = await cli('start', '--no-shell', process.execPath, '-e', 'setInterval(() => {}, 200)');
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    const wait = await cli('wait', id, '--text', 'never-appears', '--timeout', '1500');
    expect(wait.code, whatHappened(wait)).toBe(3);
    expect(wait.stderr).toContain('NOT matched');
    await cli('kill', id);
  });

  it('find prints numbered hits and exits 0, and exits 3 with a fixed line when nothing matches', async () => {
    const started = await cli(
      'start',
      '--no-shell',
      process.execPath,
      '-e',
      "console.log('find-marker-one'); setInterval(() => {}, 200)",
    );
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    // Killed whatever happens, so a failure here leaves no live session for
    // the tests after it to trip over.
    try {
      await cli('wait', id, '--text', 'find-marker-one', '--timeout', '20000');

      const hit = await cli('find', id, 'find-marker-\\w+');
      expect(hit.code, whatHappened(hit)).toBe(0);
      expect(hit.stdout.trim().split('\n')).toEqual([expect.stringMatching(/^\d+: find-marker-one$/)]);
      expect(hit.stderr).toBe('');

      // The pattern names text that is on no line, so any echo of it would show.
      const miss = await cli('find', id, 'absent-pattern-xyz');
      expect(miss.code, whatHappened(miss)).toBe(3);
      expect(miss.stdout).toBe('');
      expect(miss.stderr.trim()).toBe('No matches.');

      // As JSON the empty result is printed, and the exit code still says so.
      const missJson = await cli('find', id, 'absent-pattern-xyz', '--json');
      expect(missJson.code, whatHappened(missJson)).toBe(3);
      expect((JSON.parse(missJson.stdout) as { matches: unknown[] }).matches).toEqual([]);
    } finally {
      await cli('kill', id);
    }
  });

  it('rejects input to an exited session with a clear error', async () => {
    const started = await cli('start', '--no-shell', process.execPath, '-e', 'process.exit(0)');
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    await eventually(async () => {
      const state = readDaemonState(home);
      if (state === null) return false;
      const list = await api(state.port, state.token, '/sessions');
      const sessions = list.body['sessions'] as { id: string; exited: boolean }[];
      return sessions.find((s) => s.id === id)?.exited === true;
    }, 15_000);

    const typed = await cli('type', id, 'anything');
    expect(typed.code, whatHappened(typed)).toBe(1);
    expect(typed.stderr).toContain('has exited');
    await cli('kill', id);
  });

  it('daemon status / stop / start round-trip', async () => {
    const status = await cli('daemon', 'status');
    expect(status.code, whatHappened(status)).toBe(0);
    expect(status.stdout).toContain('running on port');
    // No sessionEnv in the config: sessions get the clean baseline (ADR-008).
    expect(status.stdout).toContain('session environment clean');

    const stopped = await cli('daemon', 'stop');
    expect(stopped.code, whatHappened(stopped)).toBe(0);
    expect(stopped.stdout).toContain('stopped');

    const statusDown = await cli('daemon', 'status');
    expect(statusDown.stdout).toContain('not running');

    const startedAgain = await cli('daemon', 'start');
    expect(startedAgain.code, whatHappened(startedAgain)).toBe(0);
    expect(startedAgain.stdout).toContain('started on port');
  });

  it('daemon stop refuses politely while a session is live', async () => {
    const started = await cli('start', '--no-shell', process.execPath, '-e', 'setInterval(() => {}, 200)');
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';

    const refused = await cli('daemon', 'stop');
    expect(refused.code, whatHappened(refused)).toBe(1);
    expect(refused.stderr).toContain('live session');

    await cli('kill', id);
    const stopped = await cli('daemon', 'stop');
    expect(stopped.code, whatHappened(stopped)).toBe(0);
  });

  it('audits CLI actions under the cli actor (§4.5)', () => {
    const lines = fs
      .readFileSync(path.join(home, 'audit.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { actor: string; action: string });
    expect(lines.some((l) => l.actor === 'cli' && l.action === 'start')).toBe(true);
    expect(lines.some((l) => l.actor === 'cli' && l.action === 'kill')).toBe(true);
  });

  it('usage errors exit 2 with help pointers', async () => {
    expect((await cli('bogus-verb')).code).toBe(2);
    expect((await cli('snap')).code).toBe(2);
    expect((await cli('daemon', 'bogus')).code).toBe(2);
    const help = await cli('help');
    expect(help.code, whatHappened(help)).toBe(0);
    expect(help.stdout).toContain('Usage:');
  });

  it('a request the daemon refuses as malformed exits 2; an operation that failed exits 1', async () => {
    // A script must be able to tell "I asked wrongly" from "it did not work"
    // without reading the message. A 400 is the daemon refusing the caller's
    // own input, which is the same class of mistake as a flag this CLI
    // rejects itself.
    const started = await cli('start', '--no-shell', process.execPath, '-e', 'setInterval(() => {}, 200)');
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    try {
      const badRegex = await cli('wait', id, '--regex', '(unclosed', '--timeout', '2000');
      expect(badRegex.code, whatHappened(badRegex)).toBe(2);
      expect(badRegex.stderr).toContain('error (400)');

      const badGrid = await cli('resize', id, '5000', '30');
      expect(badGrid.code, whatHappened(badGrid)).toBe(2);

      // Not the caller's input: the session is not there. That is the
      // operation failing, and it stays 1.
      const gone = await cli('kill', 's99999');
      expect(gone.code, whatHappened(gone)).toBe(1);
      expect(gone.stderr).toContain('error (404)');
    } finally {
      await cli('kill', id);
    }
  });

  it('daemon start, stop and restart answer in JSON when asked', async () => {
    // `--help` says every verb accepts --json, these three included. A home
    // of its own, so stopping and restarting here cannot disturb the daemon
    // the rest of this file is using.
    const jsonHome = makeTempHome('shellpuppet-cli-json-');
    try {
      const started = await cliFromHome(jsonHome, 'daemon', 'start', '--json');
      expect(started.code, whatHappened(started, jsonHome)).toBe(0);
      const startBody = JSON.parse(started.stdout) as Record<string, unknown>;
      expect(startBody['running']).toBe(true);
      expect(typeof startBody['port']).toBe('number');
      expect(typeof startBody['version']).toBe('string');

      const again = await cliFromHome(jsonHome, 'daemon', 'start', '--json');
      expect(JSON.parse(again.stdout)).toMatchObject({ running: true, port: startBody['port'] });

      const restarted = await cliFromHome(jsonHome, 'daemon', 'restart', '--json');
      expect(restarted.code, whatHappened(restarted, jsonHome)).toBe(0);
      expect(JSON.parse(restarted.stdout)).toMatchObject({ running: true });

      const stopped = await cliFromHome(jsonHome, 'daemon', 'stop', '--json');
      expect(stopped.code, whatHappened(stopped, jsonHome)).toBe(0);
      expect(JSON.parse(stopped.stdout)).toEqual({ running: false, stopped: true });

      // And a stop with nothing to stop reads the same to a script.
      const again2 = await cliFromHome(jsonHome, 'daemon', 'stop', '--json');
      expect(JSON.parse(again2.stdout)).toEqual({ running: false, stopped: true });
    } finally {
      await cliFromHome(jsonHome, 'daemon', 'stop', '--force');
      removeTempHome(jsonHome);
    }
  }, 120_000);

  it('start says when a viewer window opened, and prints no link', async () => {
    // A home whose "browser" is Node: the launcher spawns it detached and
    // reports a window opened (Node exits at once, which is beside the point),
    // and the start prints no link, because the window holds the only grant.
    // The shared `home` above opens nothing, which is why its starts print a
    // URL.
    const windowHome = makeTempHome('shellpuppet-cli-window-');
    fs.writeFileSync(
      path.join(windowHome, 'config.json'),
      JSON.stringify({ viewer: { launchMode: 'isolated-app', browserPath: process.execPath } }),
    );
    try {
      const started = await cliFromHome(
        windowHome,
        'start',
        '--no-shell',
        '--label',
        'cli-window',
        process.execPath,
        '-e',
        'setInterval(() => {}, 200)',
      );
      expect(started.code, whatHappened(started, windowHome)).toBe(0);
      expect(started.stdout).toMatch(/^viewer: window opened \(viewer-url s\d+ mints a link\)$/m);
      expect(started.stdout).not.toContain('vt=');

      const asJson = await cliFromHome(
        windowHome,
        'start',
        '--json',
        '--no-shell',
        process.execPath,
        '-e',
        'setInterval(() => {}, 200)',
      );
      expect(asJson.code, whatHappened(asJson, windowHome)).toBe(0);
      const body = JSON.parse(asJson.stdout) as Record<string, unknown>;
      expect(body['viewer']).toEqual({ opened: true, mode: 'isolated-app' });
      expect(body['viewerUrl']).toBeUndefined();
    } finally {
      await cliFromHome(windowHome, 'daemon', 'stop', '--force');
      removeTempHome(windowHome);
    }
  }, 120_000);

  it('dashboard opens the isolated window, prints no link, and fails without a fallback', async () => {
    // Node stands in for the isolated browser, so no window opens on the
    // machine running the suite. `launchMode` says default-browser on purpose:
    // the dashboard command must still use the isolated profile. COMSPEC
    // points at nothing so a regression that reaches the system opener fails
    // here instead of opening a real browser.
    const windowHome = makeTempHome('shellpuppet-cli-dashboard-');
    fs.writeFileSync(
      path.join(windowHome, 'config.json'),
      JSON.stringify({
        viewer: { launchMode: 'default-browser', browserPath: process.execPath },
      }),
    );
    const env = { COMSPEC: path.join(windowHome, 'no-such-command.exe') };
    try {
      const opened = await cliFromHomeWithEnv(windowHome, env, 'dashboard');
      expect(opened.code, whatHappened(opened, windowHome)).toBe(0);
      expect(opened.stdout.trim()).toBe('dashboard: window opened');
      expect(opened.stdout).not.toContain('dt=');
      expect(opened.stdout).not.toContain('/dashboard?');
      expect(opened.stderr).not.toContain('dt=');

      const asJson = await cliFromHomeWithEnv(windowHome, env, 'dashboard', '--json');
      expect(asJson.code, whatHappened(asJson, windowHome)).toBe(0);
      expect(JSON.parse(asJson.stdout)).toEqual({ opened: true });
      expect(asJson.stdout).not.toContain('dt=');
      expect(asJson.stdout).not.toContain('/dashboard?');

      const auditPath = path.join(windowHome, 'audit.log');
      const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
      const log = fs.existsSync(daemonLogPath(windowHome))
        ? fs.readFileSync(daemonLogPath(windowHome), 'utf8')
        : '';
      expect(`${audit}\n${log}`).not.toContain('dt=');
      expect(`${audit}\n${log}`).not.toContain('/dashboard?');
    } finally {
      await cliFromHome(windowHome, 'daemon', 'stop', '--force');
      removeTempHome(windowHome);
    }
  }, 120_000);

  it('dashboard fails with a clear message and no link when no isolated window can open', async () => {
    const noWindowHome = makeTempHome('shellpuppet-cli-dashboard-none-');
    fs.writeFileSync(
      path.join(noWindowHome, 'config.json'),
      JSON.stringify({
        viewer: {
          launchMode: 'isolated-app',
          browserPath: path.join(noWindowHome, 'absent-browser.exe'),
        },
      }),
    );
    try {
      const failed = await cliFromHomeWithEnv(
        noWindowHome,
        { COMSPEC: path.join(noWindowHome, 'no-such-command.exe') },
        'dashboard',
      );
      expect(failed.code, whatHappened(failed, noWindowHome)).toBe(1);
      expect(failed.stderr).toContain('The dashboard window did not open');
      expect(failed.stderr).toContain('viewer.browserPath');
      expect(failed.stdout).not.toContain('dt=');
      expect(failed.stderr).not.toContain('dt=');
      expect(failed.stderr).not.toContain('/dashboard?');
      const log = fs.existsSync(daemonLogPath(noWindowHome))
        ? fs.readFileSync(daemonLogPath(noWindowHome), 'utf8')
        : '';
      expect(log).not.toContain('dt=');
      expect(log).not.toContain('/dashboard?');
    } finally {
      await cliFromHome(noWindowHome, 'daemon', 'stop', '--force');
      removeTempHome(noWindowHome);
    }
  }, 120_000);

  it('result prints the agent answer alone, and snap --hide-reasoning refuses a session with no signature', async () => {
    // A session that draws a screen captured from Qoder, started as that agent
    // through node, the way a launcher script would start it.
    const fixtures = path.join(repoRoot, 'test', 'fixtures', 'reasoning');
    const meta = JSON.parse(
      fs.readFileSync(path.join(fixtures, 'qoder-answered-after-reasoning.json'), 'utf8'),
    ) as { cols: number; rows: number };
    const file = path.join(fixtures, 'qoder-answered-after-reasoning.ansi');
    const script =
      `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8')); ` +
      'setInterval(() => {}, 500)';
    const started = await cli(
      'start',
      '--no-shell',
      '--hold',
      '--agent',
      'qoder',
      '--cols',
      String(meta.cols),
      '--rows',
      String(meta.rows),
      process.execPath,
      '-e',
      script,
    );
    expect(started.code, whatHappened(started)).toBe(0);
    const id = /^(s\d+)/m.exec(started.stdout)?.[1] ?? '';
    try {
      await eventually(async () => (await cli('snap', id)).stdout.includes('Type your message'), 30_000);
      const result = await cli('result', id);
      expect(result.code, whatHappened(result)).toBe(0);
      expect(result.stdout.trim()).toBe('▪ MANGO');
      const flaggedResult = await cli('result', id, '--hide-reasoning');
      expect(flaggedResult.code, whatHappened(flaggedResult)).toBe(0);
      expect(flaggedResult.stdout).toBe(result.stdout);
      const hidden = await cli('snap', id, '--hide-reasoning');
      expect(hidden.code, whatHappened(hidden)).toBe(0);
      expect(hidden.stdout).not.toMatch(/^ │ /m);
      expect(hidden.stdout).toMatch(/^\[reasoning hidden: \d+ lines?\]$/m);
    } finally {
      await cli('kill', id);
    }

    const plain = await cli('start', '--no-shell', process.execPath, '-e', 'setInterval(() => {}, 500)');
    const plainId = /^(s\d+)/m.exec(plain.stdout)?.[1] ?? '';
    try {
      const refused = await cli('snap', plainId, '--hide-reasoning');
      expect(refused.code, whatHappened(refused)).toBe(2);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toMatch(/no agent signature/);
      const noResult = await cli('result', plainId);
      expect(noResult.code, whatHappened(noResult)).toBe(2);
    } finally {
      await cli('kill', plainId);
    }
  }, 120_000);

  it('daemon status names what passthrough hands every session, never the values (ADR-008)', async () => {
    // The daemon inherits the environment of the CLI that starts it, so a
    // credential-shaped variable set here is one passthrough would pass on.
    const leakyHome = makeTempHome('shellpuppet-cli-passthrough-');
    // launchMode none, as makeTempHome wrote before this replaced it. Under
    // the product default the daemon looks for a browser as it starts, and on
    // macOS that look holds the daemon for 5 to 10 s, longer than
    // `daemon start` waits for a new daemon to answer (viewerLauncher.ts).
    fs.writeFileSync(
      path.join(leakyHome, 'config.json'),
      JSON.stringify({ viewer: { launchMode: 'none' }, sessionEnv: 'passthrough' }),
    );
    process.env['SHELLPUPPET_CLI_CANARY_TOKEN'] = 'cli-canary-value-5e2a';
    try {
      const started = await cliFromHome(leakyHome, 'daemon', 'start');
      expect(started.code, whatHappened(started, leakyHome)).toBe(0);

      const status = await cliFromHome(leakyHome, 'daemon', 'status');
      expect(status.code, whatHappened(status, leakyHome)).toBe(0);
      expect(status.stdout).toContain('session environment passthrough');
      expect(status.stderr).toContain('SHELLPUPPET_CLI_CANARY_TOKEN');
      expect(status.stdout + status.stderr).not.toContain('cli-canary-value-5e2a');

      const json = await cliFromHome(leakyHome, 'daemon', 'status', '--json');
      const sessionEnv = (JSON.parse(json.stdout) as { sessionEnv: { mode: string; exposed: string[] } })
        .sessionEnv;
      expect(sessionEnv.mode).toBe('passthrough');
      expect(sessionEnv.exposed).toContain('SHELLPUPPET_CLI_CANARY_TOKEN');
      expect(json.stdout).not.toContain('cli-canary-value-5e2a');
    } finally {
      delete process.env['SHELLPUPPET_CLI_CANARY_TOKEN'];
      await cliFromHome(leakyHome, 'daemon', 'stop', '--force');
      removeTempHome(leakyHome);
    }
  }, 120_000);

  it('--help and -h print usage and exit 0 without touching the daemon', async () => {
    // Asking for help must not start a daemon the user never asked for, and
    // the unknown-verb branch runs AFTER ensureDaemon().
    // A home of its own: the shared one has a daemon up from earlier tests,
    // so only a fresh directory can show that help started nothing.
    const helpHome = makeTempHome('shellpuppet-help-');
    try {
      const long = await cliFromHome(helpHome, '--help');
      expect(long.code, whatHappened(long, helpHome)).toBe(0);
      expect(long.stdout).toContain('Usage:');

      const short = await cliFromHome(helpHome, '-h');
      expect(short.code, whatHappened(short, helpHome)).toBe(0);
      expect(short.stdout).toContain('Usage:');

      // Usage and exit 0 would also hold for a build that asked for the
      // daemon first and answered afterwards. The file the daemon publishes
      // on start is what says whether one was started.
      expect(fs.existsSync(path.join(helpHome, 'daemon.json'))).toBe(false);
    } finally {
      removeTempHome(helpHome);
    }
  });
});

describe('shellpuppet CLI: value flags', () => {
  it('--purpose consumes its value instead of leaking it as the command', async () => {
    // A value-taking flag missing from VALUE_FLAGS does not fail loudly: it
    // becomes boolean true and its value slides into the positionals, so the
    // FIRST WORD of the purpose is treated as the program to run.
    const started = await cli(
      'start',
      '--no-shell',
      '--label',
      'purpose-flag',
      '--purpose',
      'Fix the failing login test',
      process.execPath,
      '-e',
      'setInterval(() => {}, 200)',
    );
    expect(started.code, whatHappened(started)).toBe(0);
    const id = started.stdout.trim().split(/\s+/)[0] ?? '';
    expect(id).not.toBe('');

    const state = readDaemonState(home);
    expect(state).not.toBeNull();
    const listed = await api(state!.port, state!.token, '/sessions');
    const mine = (listed.body as unknown as {
      sessions: { id: string; purpose: string; command: string; exited: boolean }[];
    }).sessions.find((s) => s.id === id);

    expect(mine?.purpose).toBe('Fix the failing login test');
    // The command must still be node, not the first word of the purpose.
    expect(mine?.command).toBe(process.execPath);
    expect(mine?.exited).toBe(false);

    await cli('kill', id);
  });
});
