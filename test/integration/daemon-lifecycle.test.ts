/**
 * Daemon lifecycle: detached auto-start (the inherited-stdio hang), the
 * concurrent auto-start race, stale-state recovery, idle self-shutdown and
 * state-file claim atomicity (design §2.2, §2.3, §6).
 *
 * These tests spawn the REAL compiled daemon via the real client, and the
 * project's global setup builds dist/.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { claimDaemonState, daemonStatePath, readDaemonState } from '../../src/daemon/paths.js';
import { Daemon, AlreadyRunningError } from '../../src/daemon/server.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import { api, connectWs, eventually, makeTempHome, removeTempHome, repoRoot, startTestDaemon } from './helpers.js';

const execFileAsync = promisify(execFile);
const fixture = path.join(repoRoot, 'test', 'integration', 'fixtures', 'ensure-daemon.mjs');

interface FixtureResult {
  port: number;
  version: string;
  tokenPrefix: string;
  warnings: string[];
  elapsedMs: number;
}

const homes: string[] = [];
function tempHome(): string {
  const home = makeTempHome('shellpuppet-lifecycle-');
  homes.push(home);
  return home;
}

async function runFixture(home: string): Promise<FixtureResult> {
  const startedAt = Date.now();
  const { stdout } = await execFileAsync(process.execPath, [fixture], {
    env: { ...process.env, SHELLPUPPET_HOME: home },
    timeout: 30_000,
  });
  const elapsedMs = Date.now() - startedAt;
  return { ...(JSON.parse(stdout) as Omit<FixtureResult, 'elapsedMs'>), elapsedMs };
}

/** Ask the daemon in `home` to shut down; tolerate it being gone already. */
async function stopDaemonAt(home: string): Promise<void> {
  const state = readDaemonState(home);
  if (state === null) return;
  try {
    await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } });
    await eventually(async () => {
      try {
        await fetch(`http://127.0.0.1:${String(state.port)}/health`, {
          signal: AbortSignal.timeout(500),
        });
        return false;
      } catch {
        return true;
      }
    }, 10_000);
  } catch {
    // Already dead.
  }
}

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home === undefined) continue;
    await stopDaemonAt(home);
    removeTempHome(home);
  }
});

describe('daemon auto-start', () => {
  it('the spawning client exits promptly and cleanly (the inherited-stdio hang)', async () => {
    const home = tempHome();
    // execFileAsync resolving AT ALL proves the client's stdio closed: a
    // daemon holding inherited handles keeps the pipes open and this would
    // time out. The bound covers a cold daemon start on a slow CI runner.
    const result = await runFixture(home);
    expect(result.port).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeLessThan(10_000);

    // The daemon it started is genuinely healthy and discoverable.
    const state = readDaemonState(home);
    expect(state?.port).toBe(result.port);
    const health = await fetch(`http://127.0.0.1:${String(result.port)}/health`);
    expect((await health.json() as { ok: boolean }).ok).toBe(true);
  });

  it('a second invocation attaches to the running daemon near-instantly', async () => {
    const home = tempHome();
    const first = await runFixture(home);
    const second = await runFixture(home);
    expect(second.port).toBe(first.port);
    expect(second.tokenPrefix).toBe(first.tokenPrefix);
    // Warm attach: no spawn, no poll loop, just a state read and one health
    // check, measured without the cold-start noise. The design asks for about
    // 2 s (§6); the bound is 5 s, for a loaded runner.
    expect(second.elapsedMs).toBeLessThan(5_000);
  });

  it('two clients racing to auto-start both end up on ONE healthy daemon (§2.2)', async () => {
    const home = tempHome();
    const [a, b] = await Promise.all([runFixture(home), runFixture(home)]);
    expect(a.port).toBe(b.port);
    expect(a.tokenPrefix).toBe(b.tokenPrefix);

    const health = await fetch(`http://127.0.0.1:${String(a.port)}/health`);
    const body = (await health.json()) as { ok: boolean; pid: number };
    expect(body.ok).toBe(true);

    // Exactly one daemon owns the state file, and it is the one both joined.
    expect(readDaemonState(home)?.pid).toBe(body.pid);
  });

  it('recovers from a stale daemon.json (crash/reboot) by starting fresh (§2.3)', async () => {
    const home = tempHome();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      daemonStatePath(home),
      JSON.stringify({
        port: 1, // nothing listens here
        token: 'stale-token',
        pid: 99_999_999,
        version: '0.0.0',
        startedAt: new Date(0).toISOString(),
      }),
    );
    const result = await runFixture(home);
    expect(result.port).not.toBe(1);
    expect(readDaemonState(home)?.port).toBe(result.port);
  });
});

describe('daemon lifecycle', () => {
  it('a second in-process daemon on the same home defers to the incumbent', async () => {
    const td = await startTestDaemon();
    homes.push(td.home);
    const rival = new Daemon({ home: td.home, logger: NULL_LOGGER });
    await expect(rival.start()).rejects.toBeInstanceOf(AlreadyRunningError);
    await td.daemon.stop();
  });

  it('idle-stops with no sessions and no clients, but never while a session lives (§2.3)', async () => {
    let selfStopReason: string | null = null;
    const td = await startTestDaemon({
      idleMs: 600,
      idleCheckIntervalMs: 100,
      onSelfStop: (reason) => {
        selfStopReason = reason;
      },
    });
    homes.push(td.home);

    // A live session blocks idle shutdown even with nobody watching.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
      },
    });
    const id = String((started.body as { id: string }).id);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(selfStopReason).toBeNull();

    // Kill it; with nothing live and nobody connected, idle fires.
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
    await eventually(() => selfStopReason !== null, 10_000);
    expect(selfStopReason).toBe('idle');
  });

  it('an abandoned viewer on a dead session does not block idle shutdown', async () => {
    let selfStopReason: string | null = null;
    const td = await startTestDaemon({
      idleMs: 600,
      idleCheckIntervalMs: 100,
      exitedGraceMs: 500,
      onSelfStop: (reason) => {
        selfStopReason = reason;
      },
    });
    homes.push(td.home);

    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('bye')"],
        shell: false,
      },
    });
    const id = String((started.body as { id: string }).id);
    // A viewer attaches and is then abandoned; the session exits. The reap
    // closes the socket, so it cannot hold the daemon alive.
    await connectWs(td.port, id, td.token);
    await eventually(() => selfStopReason !== null, 20_000);
    expect(selfStopReason).toBe('idle');
  });

  it('shutdown refuses while sessions are live unless forced (§2.3)', async () => {
    const td = await startTestDaemon();
    homes.push(td.home);
    await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
      },
    });

    const polite = await api(td.port, td.token, '/daemon/shutdown', { body: {} });
    expect(polite.status).toBe(409);

    const forced = await api(td.port, td.token, '/daemon/shutdown', {
      body: { force: true },
    });
    expect(forced.status).toBe(200);
    // The daemon stops listening before it tears down session trees, so the
    // port frees promptly; the allowance covers a heavily loaded CI runner.
    await eventually(async () => {
      try {
        await fetch(`http://127.0.0.1:${String(td.port)}/health`, {
          signal: AbortSignal.timeout(500),
        });
        return false;
      } catch {
        return true;
      }
    }, 30_000);
  });
});

describe('config validation end-to-end', () => {
  it('a STRING allowlist refuses all commands instead of failing open', async () => {
    // Through the REAL compiled daemon and its real config read: a string
    // where the allowlist's array belongs refuses every command.
    const home = tempHome();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.json'),
      // launchMode none: the config written here replaces the one
      // makeTempHome wrote, and the real daemon entry point would otherwise
      // default to opening a viewer window. Harmless while the session below
      // is refused; a session that started would put a browser on the
      // desktop.
      JSON.stringify({
        policy: { mode: 'allowlist', allow: '^goose' },
        viewer: { launchMode: 'none' },
      }),
    );

    const result = await runFixture(home);
    const state = readDaemonState(home);
    expect(state?.port).toBe(result.port);

    const refused = await api(result.port, state?.token ?? '', '/sessions', {
      body: { command: 'goose', args: ['session'] },
    });
    expect(refused.status).toBe(403);
    expect(String(refused.body['error'])).toContain('ARRAY');

    // The daemon stayed up (it just answered us) and said why in its log.
    const log = fs.readFileSync(path.join(home, 'daemon.log'), 'utf8');
    expect(log).toContain('CONFIG PROBLEM');
  });
});

describe('daemon state file', () => {
  it('claim is atomic: exactly one of two racers wins', () => {
    const home = tempHome();
    fs.mkdirSync(home, { recursive: true });
    const first = claimDaemonState(home, {
      port: 1111,
      token: 'a',
      pid: 1,
      version: '0',
      startedAt: new Date().toISOString(),
    });
    const second = claimDaemonState(home, {
      port: 2222,
      token: 'b',
      pid: 2,
      version: '0',
      startedAt: new Date().toISOString(),
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(readDaemonState(home)?.port).toBe(1111);
    // No temp litter left behind.
    expect(fs.readdirSync(home).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('home directory permissions are hardened on first creation (§4.1)', async () => {
    // The home must NOT pre-exist: hardening runs only on first creation, and
    // a pre-made mkdtemp dir would make this test pass without it ever running.
    const parent = tempHome();
    const freshHome = path.join(parent, 'sp-home');
    expect(fs.existsSync(freshHome)).toBe(false);
    const td = await startTestDaemon({ home: freshHome });
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('icacls', [freshHome]);
      const user = process.env['USERNAME'] ?? '';
      expect(stdout).toContain(user);
      // Inheritance stripped: no BUILTIN\Users / Everyone grants survive.
      expect(stdout).not.toMatch(/BUILTIN\\Users|Everyone/);
    } else {
      const mode = fs.statSync(freshHome).mode & 0o777;
      expect(mode).toBe(0o700);
    }
    await td.daemon.stop();
  });
});
