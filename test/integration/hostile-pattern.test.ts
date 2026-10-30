/**
 * A caller's regular expression cannot take the daemon away from everybody
 * else (design §3.1, §4).
 *
 * The daemon is one event loop, so a pattern that backtracks catastrophically
 * stops it outright: while it runs, no poll timer fires, no other
 * session is served and `/health` does not answer.
 *
 * The daemon under test is the REAL detached one, started the way a client
 * starts it, because the point is that the daemon PROCESS keeps answering.
 * An in-process daemon shares this test's event loop and would prove nothing.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { readDaemonState } from '../../src/daemon/paths.js';
import { api, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const execFileAsync = promisify(execFile);
const ensureDaemonFixture = path.join(repoRoot, 'test', 'integration', 'fixtures', 'ensure-daemon.mjs');

/** Exponential backtracking against a line that cannot match. */
const HOSTILE = '^(a+)+$';
const BAIT = `${'a'.repeat(30)}!`;

const home = makeTempHome('shellpuppet-hostile-');

afterAll(async () => {
  const state = readDaemonState(home);
  if (state !== null) {
    try {
      await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } });
    } catch {
      // Already gone.
    }
  }
  removeTempHome(home);
}, 60_000);

describe('a hostile pattern from an authenticated caller', () => {
  it('is refused on its own request, and the daemon keeps answering everyone else', async () => {
    await execFileAsync(process.execPath, [ensureDaemonFixture], {
      env: { ...process.env, SHELLPUPPET_HOME: home },
      timeout: 30_000,
    });
    const state = readDaemonState(home);
    expect(state).not.toBeNull();
    const { port, token } = state as { port: number; token: string };

    const started = await api(port, token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(BAIT)}); setInterval(() => {}, 200)`],
        shell: false,
        label: 'hostile-pattern',
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    // The bait must be ON SCREEN before the hostile pattern is aimed at it.
    const painted = await api(port, token, `/sessions/${id}/wait?text=aaaaaaaa&timeout=20000`);
    expect(painted.body['matched']).toBe(true);

    // Fired and deliberately not awaited: what matters is what the daemon
    // does for everybody else while this is in flight.
    const hostile = api(
      port,
      token,
      `/sessions/${id}/wait?regex=${encodeURIComponent(HOSTILE)}&timeout=20000`,
    );

    // Five health checks, each with its own one-second patience. Without the
    // budget not one of them would be answered: the daemon would be inside
    // the regular expression for minutes.
    for (let i = 0; i < 5; i++) {
      const startedAt = Date.now();
      const health = await fetch(`http://127.0.0.1:${String(port)}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      expect(health.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // And the caller that asked for it is told why, by name.
    const refused = await hostile;
    expect(refused.status).toBe(400);
    expect(String(refused.body['error'])).toContain('(a+)+');

    // The session is untouched by any of it.
    const snapshot = await api(port, token, `/sessions/${id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(await api(port, token, `/sessions/${id}`, { method: 'DELETE' })).toMatchObject({
      status: 200,
    });
  }, 120_000);
});
