/**
 * Daemon HTTP + WebSocket integration tests (design §6): auth, DNS-rebinding
 * defences, viewer-token scoping, the tool routes and the core shared-session
 * guarantee: two clients, one PTY.
 */

import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWER_GRANT_TTL_MS } from '../../src/daemon/auth.js';
import { DEFAULT_CAPTURE_TIMEOUT_MS } from '../../src/daemon/screenshot.js';
import {
  api,
  connectWs,
  connectWsWithCookie,
  eventually,
  expectWsRejected,
  interactiveShell,
  makeTempHome,
  rawRequestWithHost,
  redeemViewerUrl,
  repoRoot,
  startTestDaemon,
  wsUpgradeStatus,
} from './helpers.js';
import type { ApiResult, TestDaemon } from './helpers.js';

let td: TestDaemon;

beforeAll(async () => {
  // This file starts about thirty sessions, more than ten of them live at
  // once, under a policy that sets no session cap: there is none unless one
  // is configured (the configured cap is tested separately below).
  td = await startTestDaemon({ policy: { mode: 'allow-all' } });
});
afterAll(async () => {
  // This file starts about thirty sessions, and the harness drains them in
  // batches of four at teardown (see startTestDaemon); under a full-suite
  // load that outgrows the default hook budget.
  await td.stop();
}, 180_000);

async function startNodeSession(marker: string): Promise<{ id: string; viewerUrl: string }> {
  const started = await api(td.port, td.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', `console.log('${marker}'); setInterval(() => {}, 200)`],
      shell: false,
      label: marker,
    },
  });
  expect(started.status).toBe(200);
  return started.body as unknown as { id: string; viewerUrl: string };
}

describe('auth and loopback defences', () => {
  it('sends no CORS headers, so a foreign page is never allowed to read an answer', async () => {
    // Claimed in security-model.md, and pinned here.
    for (const [route, token] of [
      ['/health', null],
      ['/sessions', td.token],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${String(td.port)}${route}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
      await response.text();
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('answers /health without a token, revealing only ok/version/pid', async () => {
    const result = await api(td.port, null, '/health');
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['ok', 'pid', 'version']);
  });

  it('rejects API requests without a token', async () => {
    expect((await api(td.port, null, '/sessions')).status).toBe(401);
  });

  it('rejects API requests with a wrong token', async () => {
    expect((await api(td.port, 'not-the-token', '/sessions')).status).toBe(401);
  });

  it('rejects any request whose Host header is foreign (DNS rebinding, §4.2)', async () => {
    const evil = await rawRequestWithHost(td.port, `evil.example:${String(td.port)}`);
    expect(evil.status).toBe(403);
    const good = await rawRequestWithHost(td.port, `127.0.0.1:${String(td.port)}`);
    expect(good.status).toBe(200);
    const localhost = await rawRequestWithHost(td.port, `localhost:${String(td.port)}`);
    expect(localhost.status).toBe(200);
  });
});

describe('session lifecycle over HTTP', () => {
  it('start returns id, ready and a viewer URL carrying a scoped token (§3.1, §4.1)', async () => {
    const session = await startNodeSession('http-start-marker');
    expect(session.id).toMatch(/^s\d+$/);
    // Constant path, session in the QUERY: Chrome keys an --app window's
    // AppUserModelID on host + path, and Windows groups taskbar buttons by it,
    // so a per-session path would give every viewer window its own taskbar icon.
    expect(session.viewerUrl).toContain(`/view?s=${session.id}&vt=`);
    expect(session.viewerUrl).not.toContain(`/view/${session.id}`);
    // The viewer URL must never carry the client token.
    expect(session.viewerUrl).not.toContain(td.token);

    const list = await api(td.port, td.token, '/sessions');
    expect(list.status).toBe(200);
    const sessions = list.body['sessions'] as { id: string; label: string }[];
    expect(sessions.some((s) => s.id === session.id)).toBe(true);
  });

  it('a start that opened a viewer window hands the caller no link', async () => {
    // One grant per start, and the window has it (§3.1, §4.1). A link the
    // caller did not ask for would sit in a transcript as a live capability
    // until it expired, so when a window opened the response says so and
    // carries no URL. The window's own grant still works.
    const opened: string[] = [];
    const daemon = await startTestDaemon({
      launcher: (url) => {
        opened.push(url);
        return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
      },
    });
    try {
      const started = await api(daemon.port, daemon.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('launch-opened'); setInterval(() => {}, 200)"],
          shell: false,
        },
      });
      expect(started.status).toBe(200);
      const body = started.body as unknown as {
        id: string;
        viewerUrl?: string;
        viewer: { opened: boolean; mode: string; reason?: string };
      };
      expect(body.viewer).toEqual({ opened: true, mode: 'isolated-app' });
      expect(body.viewerUrl).toBeUndefined();
      expect(JSON.stringify(started.body)).not.toContain('vt=');

      expect(opened).toHaveLength(1);
      const cookie = await redeemViewerUrl(opened[0] ?? '');
      const viewer = await connectWsWithCookie(daemon.port, body.id, cookie);
      viewer.close();
    } finally {
      await daemon.stop();
    }
  });

  it('a start that asks for no viewer opens nothing, mints no link, and still lists the session', async () => {
    const opened: string[] = [];
    const daemon = await startTestDaemon({
      launcher: (url) => {
        opened.push(url);
        return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
      },
    });
    try {
      const started = await api(daemon.port, daemon.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('no-viewer'); setInterval(() => {}, 200)"],
          shell: false,
          openViewer: false,
        },
      });
      expect(started.status).toBe(200);
      const body = started.body as unknown as { id: string; viewerUrl?: string; viewer: { opened: boolean; reason?: string } };
      expect(body.viewer).toMatchObject({ opened: false, reason: 'not requested at start' });
      expect(body.viewerUrl).toBeUndefined();
      expect(JSON.stringify(started.body)).not.toContain('vt=');
      expect(opened).toEqual([]);
      const list = await api(daemon.port, daemon.token, '/sessions');
      expect((list.body['sessions'] as { id: string }[]).some((s) => s.id === body.id)).toBe(true);
      const refused = await api(daemon.port, daemon.token, '/sessions', {
        body: { command: process.execPath, shell: false, openViewer: 'no' },
      });
      expect(refused.status).toBe(400);
      expect(String(refused.body['error'])).toContain('openViewer');
    } finally {
      await daemon.stop();
    }
  });

  it('a start that opened nothing hands the caller the unspent link, with the reason', async () => {
    // With no window there is no other way in, so the caller gets the URL to
    // hand to the human, and the response says why nothing opened. The grant
    // never reached a browser, so it is the one the window would have had.
    const opened: string[] = [];
    const daemon = await startTestDaemon({
      launcher: (url) => {
        opened.push(url);
        return Promise.resolve({
          launched: false,
          mode: 'none' as const,
          reason: 'viewer.launchMode is "none"',
        });
      },
    });
    try {
      const started = await api(daemon.port, daemon.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('launch-none'); setInterval(() => {}, 200)"],
          shell: false,
        },
      });
      expect(started.status).toBe(200);
      const body = started.body as unknown as {
        id: string;
        viewerUrl: string;
        viewer: { opened: boolean; mode: string; reason?: string };
      };
      expect(body.viewer).toEqual({
        opened: false,
        mode: 'none',
        reason: 'viewer.launchMode is "none"',
      });
      expect(opened).toEqual([body.viewerUrl]);

      const cookie = await redeemViewerUrl(body.viewerUrl);
      const viewer = await connectWsWithCookie(daemon.port, body.id, cookie);
      viewer.close();
    } finally {
      await daemon.stop();
    }
  });

  it('a launcher that fails never fails the start, and the caller gets the link', async () => {
    // A browser that will not start is an inconvenience; a session start that
    // failed because of it would break the one path every delegate depends on.
    const daemon = await startTestDaemon({
      launcher: () => Promise.reject(new Error('no browser today')),
    });
    try {
      const started = await api(daemon.port, daemon.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('launch-failed'); setInterval(() => {}, 200)"],
          shell: false,
        },
      });
      expect(started.status).toBe(200);
      const body = started.body as unknown as {
        viewerUrl?: string;
        viewer: { opened: boolean; reason?: string };
      };
      expect(body.viewer.opened).toBe(false);
      expect(body.viewer.reason).toContain('no browser today');
      expect(body.viewerUrl).toContain('/view?s=');
    } finally {
      await daemon.stop();
    }
  });

  it('wait + snapshot + find see the same output', async () => {
    const session = await startNodeSession('wait-snap-find');

    const waited = await api(
      td.port,
      td.token,
      `/sessions/${session.id}/wait?text=wait-snap-find&timeout=20000`,
    );
    expect(waited.status).toBe(200);
    expect(waited.body['matched']).toBe(true);
    expect(waited.body['reason']).toBe('text');

    const snapshot = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(String(snapshot.body['screen'])).toContain('wait-snap-find');

    const found = await api(
      td.port,
      td.token,
      `/sessions/${session.id}/find?pattern=${encodeURIComponent('wait-snap-\\w+')}`,
    );
    expect(found.status).toBe(200);
    const matches = found.body['matches'] as { line: number; match: string }[];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]?.match).toBe('wait-snap-find');
  });

  it('resolves a BARE command name with shell:false (Windows PATH)', async () => {
    // node-pty's Windows backend does not search PATH when spawning directly,
    // and fails with an empty `File not found:`. The other tests use
    // process.execPath (absolute), so this one pins that `node` resolves from
    // PATH, as the README's five CLI steps need.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: 'node',
        args: ['-e', "console.log('bare-name-resolved'); setInterval(() => {}, 200)"],
        shell: false,
      },
    });
    expect(started.status).toBe(200);
    const id = String((started.body as { id: string }).id);
    const waited = await api(
      td.port,
      td.token,
      `/sessions/${id}/wait?text=bare-name-resolved&timeout=20000`,
    );
    expect(waited.body['matched']).toBe(true);
  });

  it('reports an unresolvable bare command as 400 with an actionable message', async () => {
    const result = await api(td.port, td.token, '/sessions', {
      body: { command: 'definitely-not-a-real-command-xyz', shell: false },
    });
    expect(result.status).toBe(400);
    expect(String(result.body['error'])).toContain('not found on PATH');
    expect(String(result.body['error'])).toContain('--no-shell');
  });

  it('a nonexistent absolute path fails loudly, never as a silent dead session', async () => {
    // On POSIX, pty.spawn of a missing executable SUCCEEDS: execvp fails in
    // the forked child and the parent never learns, so the caller would get a
    // healthy-looking session that is silently dead, and an agent would wait
    // out its whole timeout for output that can never arrive.
    const missing = path.join(repoRoot, 'no-such-binary-here');
    const result = await api(td.port, td.token, '/sessions', {
      body: { command: missing, shell: false },
    });
    expect(result.status).toBe(400);
    expect(String(result.body['error'])).toContain('Not an executable file');
  });

  it.runIf(process.platform === 'win32')(
    'refuses a script started without the shell on Windows, and runs it through the shell',
    async () => {
      // Without the shell, Windows hands a batch file to cmd.exe on its own,
      // with the arguments quoted for a program's parser, and fails anything
      // else that is not an .exe or a .com with error 193 once the terminal
      // is built. Each is a 400 that says what to do instead.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-scripts-'));
      try {
        const files = {
          cmd: path.join(dir, 'say.cmd'),
          bat: path.join(dir, 'say.bat'),
          ps1: path.join(dir, 'say.ps1'),
          none: path.join(dir, 'say'),
        };
        fs.writeFileSync(files.cmd, '@echo script-ran-%1\r\n');
        fs.writeFileSync(files.bat, '@echo script-ran-%1\r\n');
        fs.writeFileSync(files.ps1, 'Write-Output "script-ran"\r\n');
        fs.writeFileSync(files.none, '#!/bin/sh\necho script-ran\n');
        for (const [kind, file] of Object.entries(files)) {
          const refused = await api(td.port, td.token, '/sessions', {
            body: { command: file, args: ['x'], shell: false },
          });
          expect(refused.status, kind).toBe(400);
          expect(String(refused.body['error']), kind).toContain(
            'Not a program Windows can start directly',
          );
          expect(String(refused.body['error']), kind).toContain('Drop shell:false');
        }
        // Through the shell, the default on Windows, the batch file runs.
        const started = await api(td.port, td.token, '/sessions', {
          body: { command: files.cmd, args: ['through-shell'] },
        });
        expect(started.status).toBe(200);
        const id = String((started.body as { id: string }).id);
        const waited = await api(
          td.port,
          td.token,
          `/sessions/${id}/wait?text=script-ran-through-shell&timeout=20000`,
        );
        expect(waited.body['matched']).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );

  it('refuses a directory as the command with a clean 400', async () => {
    // A directory is not a program: statSync succeeds, so isFile() is what
    // keeps this a clean 400 rather than an obscure spawn failure.
    const result = await api(td.port, td.token, '/sessions', {
      body: { command: repoRoot, shell: false },
    });
    expect(result.status).toBe(400);
  });

  it('validates wait conditions at the API boundary', async () => {
    const session = await startNodeSession('wait-validation');
    const both = await api(
      td.port,
      td.token,
      `/sessions/${session.id}/wait?text=a&quiet=100`,
    );
    expect(both.status).toBe(400);
    const neither = await api(td.port, td.token, `/sessions/${session.id}/wait`);
    expect(neither.status).toBe(400);
  });

  it('a malformed wait timeout is a prompt 400, never an unbounded wait', async () => {
    // `--timeout abc` becomes Number('abc') = NaN; unvalidated, the deadline
    // check would be permanently false and this request would never complete,
    // so the one-shot CLI awaiting it would hang forever, and its calling
    // shell with it.
    const session = await startNodeSession('wait-nan-timeout');
    const badTimeout = await api(
      td.port,
      td.token,
      `/sessions/${session.id}/wait?text=never-appears-here&timeout=abc`,
    );
    expect(badTimeout.status).toBe(400);
    expect(String(badTimeout.body['error'])).toContain('timeout');
    const badDebounce = await api(
      td.port,
      td.token,
      `/sessions/${session.id}/wait?text=a&debounce=abc`,
    );
    expect(badDebounce.status).toBe(400);
    // Clean up promptly rather than leave the PTY to the teardown at the end
    // of the file (startTestDaemon says why that teardown is paced). Fewer
    // leftovers, smaller pile.
    await api(td.port, td.token, `/sessions/${session.id}`, { method: 'DELETE' });
  });

  it('stops polling a wait whose caller has gone', async () => {
    // A wait ends with its caller: a client that gives up, or whose process
    // dies, must not leave the poll running to its full timeout, taking a
    // renderer snapshot every eighty milliseconds for an answer nobody will
    // read.
    const session = await startNodeSession('wait-abandoned');
    const caller = new AbortController();
    const abandoned = fetch(
      `http://127.0.0.1:${String(td.port)}/sessions/${session.id}` +
        `/wait?text=never-appears-at-all&timeout=120000`,
      { headers: { authorization: `Bearer ${td.token}` }, signal: caller.signal },
    ).catch(() => undefined);

    await eventually(() => td.daemon.waitsPolling === 1, 10_000);
    caller.abort();
    await abandoned;
    // Promptly, not in two minutes' time.
    await eventually(() => td.daemon.waitsPolling === 0, 5_000);

    // And the session itself is untouched by the abandonment.
    expect((await api(td.port, td.token, `/sessions/${session.id}/snapshot`)).status).toBe(200);
    await api(td.port, td.token, `/sessions/${session.id}`, { method: 'DELETE' });
  });

  it('verify sees text the TUI WRAPPED across rows', async () => {
    // A long line typed into a narrow screen is redrawn across rows, and the
    // break (plus any continuation indent) lands INSIDE the 40-char needle,
    // so a literal substring check would fail on text that arrived perfectly.
    // An agent trusting that false would retype and DUPLICATE its input.
    const started = await api(td.port, td.token, '/sessions', {
      body: { ...interactiveShell(), cols: 40, rows: 20, label: 'verify-wrap' },
    });
    expect(started.status).toBe(200);
    const id = String((started.body as { id: string }).id);
    await api(td.port, td.token, `/sessions/${id}/wait?quiet=700&timeout=20000`);

    // 100 printable characters into a 40-column screen: the last 40, which
    // are the needle, must straddle at least one wrap. Deliberately NOT submitted,
    // so nothing executes; this only exercises the shell's echo.
    const long = `wrapcheck-${'x'.repeat(80)}-endmarker`;
    const typed = await api(td.port, td.token, `/sessions/${id}/input`, {
      body: { data: long, verify: true },
    });
    expect(typed.status).toBe(200);
    expect(typed.body['verified']).toBe(true);

    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('exited sessions: the final screen stays readable; input, key and resize answer 409', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('short-lived-output')"],
        shell: false,
      },
    });
    expect(started.status).toBe(200);
    const id = String((started.body as { id: string }).id);
    await eventually(async () => {
      const list = await api(td.port, td.token, '/sessions');
      const sessions = list.body['sessions'] as { id: string; exited: boolean }[];
      return sessions.find((s) => s.id === id)?.exited === true;
    }, 20_000);

    // During the reap grace (default 15 min) the final screen is readable:
    // agents legitimately come back for it after exit.
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(String(snapshot.body['screen'])).toContain('short-lived-output');

    // Resize gets the same deliberate 409 as input and key, rather than
    // reaching node-pty's dead PTY.
    const resize = await api(td.port, td.token, `/sessions/${id}/resize`, {
      body: { cols: 100, rows: 30 },
    });
    expect(resize.status).toBe(409);
    expect(String(resize.body['error'])).toContain('has exited');
    expect(
      (await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'x' } })).status,
    ).toBe(409);
    // Remove the exited session rather than leaving it for afterAll's
    // killAll (see the wait-timeout test above for why).
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('rejects unknown keys with the known-keys list, accepts real ones', async () => {
    const session = await startNodeSession('key-route');
    const bad = await api(td.port, td.token, `/sessions/${session.id}/key`, {
      body: { key: 'bogus' },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body['error'])).toContain('enter');
    const good = await api(td.port, td.token, `/sessions/${session.id}/key`, {
      body: { key: 'enter' },
    });
    expect(good.status).toBe(200);
  });

  it('validates snapshot lastLines and resize bounds', async () => {
    const session = await startNodeSession('validation-bounds');
    expect(
      (await api(td.port, td.token, `/sessions/${session.id}/snapshot?lastLines=0`)).status,
    ).toBe(400);
    expect(
      (
        await api(td.port, td.token, `/sessions/${session.id}/resize`, {
          body: { cols: 1, rows: 30 },
        })
      ).status,
    ).toBe(400);
    const resized = await api(td.port, td.token, `/sessions/${session.id}/resize`, {
      body: { cols: 100, rows: 30 },
    });
    expect(resized.status).toBe(200);
  });

  it('holds start to the same grid bounds as resize, at the boundary and just outside', async () => {
    // Start and resize share one set of bounds, so no session starts at a
    // grid no caller could resize it back to.
    const attempt = (grid: Record<string, unknown>): Promise<ApiResult> =>
      api(td.port, td.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
          ...grid,
        },
      });

    expect((await attempt({ cols: 1_001, rows: 24 })).status).toBe(400);
    expect((await attempt({ cols: 80, rows: 501 })).status).toBe(400);
    expect((await attempt({ cols: 1, rows: 24 })).status).toBe(400);
    expect((await attempt({ cols: 80, rows: 1 })).status).toBe(400);
    expect((await attempt({ cols: 80.5, rows: 24 })).status).toBe(400);
    // Each axis on its own, so no check can hide behind its neighbour.
    expect((await attempt({ cols: 80, rows: 24.5 })).status).toBe(400);

    // And the boundary itself is still accepted.
    const edge = await attempt({ cols: 1_000, rows: 500 });
    expect(edge.status).toBe(200);
    await api(td.port, td.token, `/sessions/${String(edge.body['id'])}`, { method: 'DELETE' });
  });

  it('refuses a present-but-wrong field rather than silently using the default', async () => {
    // A caller with a bug in its own serialisation (`{cols: "80", rows: "24",
    // args: 4}`) must be told so, not handed a session at the default grid
    // with no arguments.
    const send = (fields: Record<string, unknown>): Promise<ApiResult> =>
      api(td.port, td.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
          ...fields,
        },
      });

    const strings = await send({ cols: '80', rows: '24' });
    expect(strings.status).toBe(400);
    expect(String(strings.body['error'])).toContain('cols');

    // With cols valid, so the rows check has to do the refusing itself: sent
    // together, an intact cols check would hide a missing rows check.
    const stringRows = await send({ cols: 80, rows: '24' });
    expect(stringRows.status).toBe(400);
    expect(String(stringRows.body['error'])).toContain('rows');

    const numericArgs = await send({ args: 4 });
    expect(numericArgs.status).toBe(400);
    expect(String(numericArgs.body['error'])).toContain('array of strings');

    expect((await send({ args: ['-e', 7] })).status).toBe(400);
    expect((await send({ cwd: 42 })).status).toBe(400);
    expect((await send({ shell: 'false' })).status).toBe(400);
    expect((await send({ hold: 'yes' })).status).toBe(400);
    expect((await send({ label: 12 })).status).toBe(400);
    expect((await send({ readyQuiet: 'soon' })).status).toBe(400);
    expect((await send({ readyQuiet: -1 })).status).toBe(400);
    expect((await send({ purpose: 7 })).status).toBe(400);
    expect((await send({ readyText: 9 })).status).toBe(400);

    // A session's own variables are names mapped to string values (§4.6). A
    // refusal names the variable and never repeats its value.
    const badName = await send({ env: { 'BAD-NAME': 'value-never-echoed' } });
    expect(badName.status).toBe(400);
    expect(String(badName.body['error'])).toContain('BAD-NAME');
    expect(String(badName.body['error'])).not.toContain('value-never-echoed');
    const badValue = await send({ env: { GOOD_NAME: 42 } });
    expect(badValue.status).toBe(400);
    expect(String(badValue.body['error'])).toContain('GOOD_NAME');
    const nul = await send({ env: { GOOD_NAME: 'value\u0000never-echoed' } });
    expect(nul.status).toBe(400);
    expect(String(nul.body['error'])).not.toContain('never-echoed');
    expect((await send({ env: ['GOOD_NAME=x'] })).status).toBe(400);
    expect((await send({ env: 'GOOD_NAME=x' })).status).toBe(400);
    // A name an object would swallow is refused rather than silently dropped.
    const proto = await send({ env: JSON.parse('{"__proto__":"value-never-echoed"}') as unknown });
    expect(proto.status).toBe(400);
    expect(String(proto.body['error'])).toContain('__proto__');
  });

  it('refuses a cwd that is not an existing directory, in words the caller can act on', async () => {
    // Checked before the spawn, rather than left to fail deep inside ConPTY
    // as "Cannot create process, error code: 267".
    const missing = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        cwd: path.join(repoRoot, 'no-such-directory-here'),
      },
    });
    expect(missing.status).toBe(400);
    expect(String(missing.body['error'])).toContain('does not exist');

    const notADirectory = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        cwd: path.join(repoRoot, 'package.json'),
      },
    });
    expect(notADirectory.status).toBe(400);
    expect(String(notADirectory.body['error'])).toContain('not a directory');
  });

  it('404s for unknown sessions and routes', async () => {
    expect((await api(td.port, td.token, '/sessions/s999/snapshot')).status).toBe(404);
    expect((await api(td.port, td.token, '/nonsense')).status).toBe(404);
  });

  it('DELETE kills the session, and its viewer link opens nothing afterwards', async () => {
    const session = await startNodeSession('delete-me');
    const viewerToken = new URL(session.viewerUrl).searchParams.get('vt') ?? '';
    expect(viewerToken).not.toBe('');

    const killed = await api(td.port, td.token, `/sessions/${session.id}`, {
      method: 'DELETE',
    });
    expect(killed.status).toBe(200);

    const list = await api(td.port, td.token, '/sessions');
    const sessions = list.body['sessions'] as { id: string }[];
    expect(sessions.some((s) => s.id === session.id)).toBe(false);

    // The session's viewer grant must not open a stream (the session is
    // gone, so this must be 401/404, never an accepted socket).
    await expectWsRejected(td.port, session.id, viewerToken);
  });
});

describe('viewer grant scoping (§4.1)', () => {
  it('a viewer grant cannot call the HTTP API at all', async () => {
    const session = await startNodeSession('viewer-scope-api');
    const viewerToken = new URL(session.viewerUrl).searchParams.get('vt') ?? '';

    expect((await api(td.port, viewerToken, '/sessions')).status).toBe(401);
    expect(
      (await api(td.port, viewerToken, `/sessions/${session.id}/snapshot`)).status,
    ).toBe(401);
    expect(
      (await api(td.port, viewerToken, `/sessions/${session.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(401);
  });

  it('a viewer grant opens nothing by itself: it is exchanged, once', async () => {
    const session = await startNodeSession('viewer-grant-exchange');
    const grant = new URL(session.viewerUrl).searchParams.get('vt') ?? '';
    expect(grant).not.toBe('');

    // The thing that lands in a transcript is not a credential.
    await expectWsRejected(td.port, session.id, grant);

    const cookie = await redeemViewerUrl(session.viewerUrl);
    expect(cookie).toContain('sp_viewer=');

    // ...and the URL is spent, so a later reader of that transcript gets
    // nothing at all.
    await expect(redeemViewerUrl(session.viewerUrl)).rejects.toThrow(/no credential/);
  });

  it('a redeemed credential opens a stream for THEIR session only', async () => {
    const a = await startNodeSession('viewer-scope-a');
    const b = await startNodeSession('viewer-scope-b');
    const cookieA = await redeemViewerUrl(a.viewerUrl);

    const allowed = await connectWsWithCookie(td.port, a.id, cookieA);
    allowed.close();

    await expectWsRejected(td.port, b.id, '', { cookie: cookieA });
  });

  it('a live credential for another session, sent first, does not shadow the right one', async () => {
    // Cookies ignore ports, and a page elsewhere on loopback can plant one at
    // a broader path than the daemon uses, so the upgrade can be shown a
    // credential the daemon really did issue for a DIFFERENT session, ahead
    // of the one for this stream. Taking the first that verified would find
    // it was for the wrong session and refuse the human, with the right
    // credential still unread.
    const a = await startNodeSession('viewer-shadow-a');
    const b = await startNodeSession('viewer-shadow-b');
    const cookieA = await redeemViewerUrl(a.viewerUrl);
    const cookieB = await redeemViewerUrl(b.viewerUrl);

    const viewer = await connectWsWithCookie(td.port, a.id, `${cookieB}; ${cookieA}`);
    await viewer.waitForControl((c) => c['type'] === 'identity');
    viewer.close();

    // ...while the other session's credential is still no use here on its own.
    await expectWsRejected(td.port, a.id, '', { cookie: cookieB });
  });

  it('a read-only link watches but the daemon refuses its keystrokes', async () => {
    const session = await startNodeSession('viewer-read-only');
    const minted = await api(td.port, td.token, `/sessions/${session.id}/viewer`, {
      body: { readOnly: true },
    });
    expect(minted.status).toBe(200);
    expect(minted.body['readOnly']).toBe(true);

    const cookie = await redeemViewerUrl(String(minted.body['viewerUrl']));
    const viewer = await connectWsWithCookie(td.port, session.id, cookie);
    const identity = await viewer.waitForControl((c) => c['type'] === 'identity');
    // The page is told, rather than left to work it out.
    expect(identity['readOnly']).toBe(true);

    viewer.ws.send('echo should-never-run\r');
    // Give the daemon every chance to have written it before concluding it did not.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    expect(String(snapshot.body['screen'])).not.toContain('should-never-run');
    viewer.close();
  });

  it('a read-only link cannot resize the session, and is never handed its grid', async () => {
    // The other half of "may watch but never type or resize"
    // (docs/reference/security-model.md). Typing is pinned above; this pins the
    // resize guard and the connect-time claim of the grid.
    const session = await startNodeSession('viewer-read-only-grid');
    const minted = await api(td.port, td.token, `/sessions/${session.id}/viewer`, {
      body: { readOnly: true },
    });
    const cookie = await redeemViewerUrl(String(minted.body['viewerUrl']));
    const watcher = await connectWsWithCookie(td.port, session.id, cookie);
    const frame = await watcher.waitForControl((c) => c['type'] === 'geometry');
    // Nobody is driving, and the first read-write viewport would be handed
    // the grid, but choosing the grid is a write, so a watcher never is.
    expect(frame['control']).toBe('adopt');

    watcher.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    expect(snapshot.body['cols']).toBe(frame['cols']);
    expect(snapshot.body['rows']).toBe(frame['rows']);
    // Dropped, not answered: a request the daemon refuses draws no frame.
    expect(watcher.controls().filter((c) => c['type'] === 'geometry')).toHaveLength(1);

    // The grid the watcher was refused is still free for a viewport that may write.
    const writer = await connectWs(td.port, session.id, td.token);
    const theirs = await writer.waitForControl((c) => c['type'] === 'geometry');
    expect(theirs['control']).toBe('yours');
    writer.close();
    watcher.close();
  });

  it('the credential arrives HttpOnly, SameSite=Strict, on its session path, with no Max-Age', async () => {
    // The unit test checks the helper; this checks the header a browser
    // actually receives. A route that built the cookie some other way would
    // pass the helper's test and lose the property that matters.
    const session = await startNodeSession('viewer-cookie-flags');
    const response = await fetch(session.viewerUrl);
    await response.text();
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^sp_viewer=[A-Za-z0-9%._~-]+; /);
    expect(header).toContain(`Path=/sessions/${session.id}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toMatch(/Max-Age|Expires/i);
  });

  it('a mismatched s= is corrected rather than obeyed', async () => {
    // The grant says which session it is for; `s=` only tells the page, so a
    // hand-edited link must not spend its grant on a page that then asks for
    // the wrong stream.
    const a = await startNodeSession('viewer-s-mismatch-a');
    const b = await startNodeSession('viewer-s-mismatch-b');
    const edited = a.viewerUrl.replace(`s=${a.id}&`, `s=${b.id}&`);
    expect(edited).not.toBe(a.viewerUrl);
    const response = await fetch(edited, { redirect: 'manual' });
    await response.text();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/view?s=${a.id}`);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('sp_viewer=');
    // ...and the credential it set is for the grant's session, not the edited one.
    const viewer = await connectWsWithCookie(td.port, a.id, cookie);
    viewer.close();
    await expectWsRejected(td.port, b.id, '', { cookie });
  });

  it('a malformed or planted cookie neither fells the daemon nor locks the human out', async () => {
    // Cookies ignore ports, so a page on any other loopback port can set one
    // named like ours. A value that will not decode is skipped rather than
    // thrown on, and a planted value ahead of the real one does not stop the
    // real one being tried.
    const session = await startNodeSession('viewer-cookie-poison');
    await expectWsRejected(td.port, session.id, '', { cookie: 'sp_viewer=%zz' });
    expect((await api(td.port, null, '/health')).status).toBe(200);
    const real = await redeemViewerUrl(session.viewerUrl);
    // One that will not decode, one that decodes to nothing the daemon ever
    // issued, then the real one: every cookie of the name is tried in turn.
    const viewer = await connectWsWithCookie(
      td.port,
      session.id,
      `sp_viewer=%zz; sp_viewer=planted-by-another-page; junk=1; ${real}`,
    );
    await viewer.waitForControl((c) => c['type'] === 'identity');
    viewer.close();
  });

  it('a malformed frame on a viewer socket closes that socket, not the daemon', async () => {
    // A protocol error on a viewer socket closes that socket and nothing
    // else. The handshake is done by hand because no client library will
    // send a bad frame for you.
    const session = await startNodeSession('viewer-bad-frame');
    const cookie = await redeemViewerUrl(session.viewerUrl);
    const socket = net.connect(td.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    // The daemon destroys this socket after the bad frame; a reset arriving
    // after the test has moved on must not be an unhandled error of its own.
    socket.on('error', () => undefined);
    socket.write(
      `GET /sessions/${session.id}/stream HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${String(td.port)}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        `Cookie: ${cookie}\r\n\r\n`,
    );
    const head = await new Promise<string>((resolve) => {
      socket.once('data', (data) => resolve(data.toString('latin1')));
    });
    expect(head).toMatch(/^HTTP\/1\.1 101/);
    // FIN and RSV1 set, text opcode, no mask, zero length: two protocol
    // errors in two bytes.
    socket.write(Buffer.from([0xc1, 0x00]));
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      setTimeout(resolve, 2_000);
    });
    socket.destroy();

    expect((await api(td.port, null, '/health')).status).toBe(200);
    const list = await api(td.port, td.token, '/sessions');
    const sessions = list.body['sessions'] as { id: string }[];
    expect(sessions.some((entry) => entry.id === session.id)).toBe(true);
  });

  it('a malformed upgrade target is refused on the socket, and the daemon lives', async () => {
    // The upgrade path parses its target before authenticating, so an
    // unparsable request target is refused with a 400 and nothing more. No
    // credential of any kind is sent here: any local process can send this.
    const session = await startNodeSession('upgrade-bad-target');
    const socket = net.connect(td.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.on('error', () => undefined);
    socket.write(
      'GET http://[ HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${String(td.port)}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    const head = await new Promise<string>((resolve) => {
      socket.once('data', (data) => resolve(data.toString('latin1')));
      setTimeout(() => resolve(''), 5_000);
    });
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 400/);

    // Alive, and still serving the session it already had.
    expect((await api(td.port, null, '/health')).status).toBe(200);
    const snapshot = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    expect(snapshot.status).toBe(200);
  });

  it('a refused upgrade leaves its socket listening for errors, so a late one is not uncaught', async () => {
    // Node takes its own 'error' listener off the socket before it emits
    // 'upgrade', and ws adds one only inside its handleUpgrade, which a
    // refusal never reaches. An error on that socket after the refusal, a
    // reset say, would be an uncaught exception, on which the daemon shuts
    // down with every session.
    const server = (td.daemon as unknown as { server: http.Server }).server;
    const refused = new Promise<net.Socket>((resolve) => {
      server.once('upgrade', (_request: http.IncomingMessage, socket: net.Socket) => resolve(socket));
    });
    expect(await wsUpgradeStatus(td.port, 's999999', 'garbage-token')).toBe(401);
    const socket = await refused;

    // With no listener, emit('error') throws the error back at its caller.
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => socket.emit('error', reset)).not.toThrow();
  });

  it('mints a fresh link for a running session', async () => {
    const session = await startNodeSession('viewer-fresh-link');
    await redeemViewerUrl(session.viewerUrl);

    const minted = await api(td.port, td.token, `/sessions/${session.id}/viewer`, {
      body: {},
    });
    expect(minted.status).toBe(200);
    expect(String(minted.body['viewerUrl'])).toContain(`/view?s=${session.id}&vt=`);
    expect(minted.body['readOnly']).toBe(false);
    // The life it reports is the life the docs promise, as a number.
    expect(minted.body['expiresInMs']).toBe(VIEWER_GRANT_TTL_MS);

    const cookie = await redeemViewerUrl(String(minted.body['viewerUrl']));
    const viewer = await connectWsWithCookie(td.port, session.id, cookie);
    viewer.close();
  });

  it('WS upgrades with a bad token or a foreign Origin are refused (§4.2)', async () => {
    const session = await startNodeSession('ws-refusals');
    await expectWsRejected(td.port, session.id, 'garbage-token');
    await expectWsRejected(td.port, session.id, td.token, {
      origin: 'http://evil.example',
    });
    // Our own origin is fine.
    const ok = await connectWs(td.port, session.id, td.token, {
      origin: `http://127.0.0.1:${String(td.port)}`,
    });
    ok.close();
  });

  it('WS upgrades check the token BEFORE revealing whether a session exists', async () => {
    // Session ids are sequential; answering 404 before auth would let an
    // unauthenticated prober enumerate which ones exist, the same leak the
    // unauthenticated viewer route deliberately avoids. 404 is reserved for
    // authenticated callers.
    const session = await startNodeSession('ws-auth-order');
    expect(await wsUpgradeStatus(td.port, 's999999', 'garbage-token')).toBe(401);
    expect(await wsUpgradeStatus(td.port, 's999999', null)).toBe(401);
    expect(await wsUpgradeStatus(td.port, session.id, 'garbage-token')).toBe(401);
    expect(await wsUpgradeStatus(td.port, 's999999', td.token)).toBe(404);
    await api(td.port, td.token, `/sessions/${session.id}`, { method: 'DELETE' });
  });
});

describe('exited-session reaping', () => {
  it('after the grace: gone from list, viewer link inert, watcher sockets closed', async () => {
    // A natural exit cleans up the same way a kill does, once the grace
    // lapses.
    const reaper = await startTestDaemon({ exitedGraceMs: 2_000, idleCheckIntervalMs: 100 });
    try {
      const started = await api(reaper.port, reaper.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('reap-me')"],
          shell: false,
        },
      });
      expect(started.status).toBe(200);
      const { id, viewerUrl } = started.body as unknown as { id: string; viewerUrl: string };
      const viewerToken = new URL(viewerUrl).searchParams.get('vt') ?? '';
      expect(viewerToken).not.toBe('');

      // A watcher attaches (well within the 2 s grace) and is then abandoned.
      const watcher = await connectWs(reaper.port, id, reaper.token);
      const socketClosed = new Promise<void>((resolve) =>
        watcher.ws.on('close', () => resolve()),
      );

      await eventually(async () => {
        const list = await api(reaper.port, reaper.token, '/sessions');
        const sessions = list.body['sessions'] as { id: string }[];
        return !sessions.some((s) => s.id === id);
      }, 20_000);

      await socketClosed;
      expect(await wsUpgradeStatus(reaper.port, id, viewerToken)).toBe(401);
      expect(
        (await api(reaper.port, reaper.token, `/sessions/${id}/snapshot`)).status,
      ).toBe(404);
    } finally {
      await reaper.stop();
    }
  });
});

describe('the shared-session guarantee (§6)', () => {
  it('two WS clients both see output, and input from either reaches the one PTY', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { ...interactiveShell(), label: 'shared' },
    });
    expect(started.status).toBe(200);
    expect(started.body['id']).toBeDefined();
    const id = String((started.body as { id: string }).id);
    await api(td.port, td.token, `/sessions/${id}/wait?quiet=700&timeout=20000`);

    const ws1 = await connectWs(td.port, id, td.token);
    const ws2 = await connectWs(td.port, id, td.token);

    // Input from client 1 → echo reaches BOTH watchers.
    ws1.ws.send('echo from-first-client\r');
    await ws1.waitForData('from-first-client');
    await ws2.waitForData('from-first-client');

    // Input from client 2 → both watchers AND the PTY state agree.
    ws2.ws.send('echo from-second-client\r');
    await ws1.waitForData('from-second-client');
    await ws2.waitForData('from-second-client');
    await eventually(async () => {
      const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
      return String(snapshot.body['screen']).includes('from-second-client');
    }, 15_000);

    ws1.close();
    ws2.close();
  });

  it('a late joiner receives replayed history, not a blank screen (§5)', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('history-before-join'); setInterval(() => {}, 200)"],
        shell: false,
      },
    });
    expect(started.status).toBe(200);
    const id = String((started.body as { id: string }).id);
    await api(td.port, td.token, `/sessions/${id}/wait?text=history-before-join&timeout=20000`);

    const late = await connectWs(td.port, id, td.token);
    await late.waitForData('history-before-join', 5_000);
    late.close();
  });
});

describe('viewer assets and the WS frame protocol (§5)', () => {
  it('serves the viewer page without auth, with CSP and no-store', async () => {
    const response = await fetch(`http://127.0.0.1:${String(td.port)}/view?s=s1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    // xterm.js styles rows, the cursor and its measurement element inline,
    // and a real browser reported ten CSP violations per load without this.
    // Scripts stay strict; only styles are relaxed.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('/viewer/viewer.js');
    expect(html).toContain('/vendor/xterm.js');
  });

  it('answers /favicon.ico without auth, so the browser never logs a 401', async () => {
    // It is the real mark, because a Chrome --app window asks for
    // /favicon.ico when it builds its taskbar button, and "no content" leaves
    // that button showing the generic globe. The point of this test is that
    // the answer comes before auth runs: a 401 here is console and audit-log
    // noise on every single page load.
    const response = await fetch(`http://127.0.0.1:${String(td.port)}/favicon.ico`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('serves exactly the allowlisted static assets', async () => {
    for (const [assetPath, type] of [
      ['/viewer/viewer.js', 'text/javascript'],
      ['/viewer/viewer.css', 'text/css'],
      ['/vendor/xterm.js', 'text/javascript'],
      ['/vendor/xterm.css', 'text/css'],
      ['/vendor/addon-fit.js', 'text/javascript'],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${String(td.port)}${assetPath}`);
      expect(response.status, assetPath).toBe(200);
      expect(response.headers.get('content-type'), assetPath).toContain(type);
      expect((await response.text()).length, assetPath).toBeGreaterThan(100);
    }
    // Anything off the allowlist is not a file read.
    expect((await fetch(`http://127.0.0.1:${String(td.port)}/viewer/nope.js`)).status).toBe(401);
  });

  it('sends PTY bytes as BINARY frames and input-source notices as JSON text frames', async () => {
    const session = await startNodeSession('frame-protocol');
    const ws1 = await connectWs(td.port, session.id, td.token);
    const ws2 = await connectWs(td.port, session.id, td.token);
    await ws1.waitForData('frame-protocol');
    expect(ws1.sawBinary()).toBe(true);

    // Agent input over HTTP → both watchers told the agent typed.
    await api(td.port, td.token, `/sessions/${session.id}/input`, { body: { data: 'x' } });
    const agentNotice = await ws1.waitForControl(
      (c) => c['type'] === 'input-source' && c['source'] === 'agent',
    );
    expect(agentNotice['source']).toBe('agent');
    await ws2.waitForControl((c) => c['source'] === 'agent');

    // Human input over WS → watchers told a human typed.
    ws1.ws.send('y');
    await ws2.waitForControl(
      (c) => c['type'] === 'input-source' && c['source'] === 'human',
    );

    ws1.close();
    ws2.close();
  });

  it('an API resize tells watchers the new geometry (§5)', async () => {
    // A viewer left at its own fitted width while the program redraws
    // narrower keeps everything beyond the new last column as stale borders
    // and duplicated boxes.
    const session = await startNodeSession('geometry-broadcast');
    const watcher = await connectWs(td.port, session.id, td.token);

    const resized = await api(td.port, td.token, `/sessions/${session.id}/resize`, {
      body: { cols: 100, rows: 30 },
    });
    expect(resized.status).toBe(200);

    // Match the RESIZE's frame specifically. Every connect also delivers a
    // geometry frame carrying the session's current size, so waiting for "the
    // first geometry frame" would match that one and never see the resize.
    const geometry = await watcher.waitForControl(
      (c) => c['type'] === 'geometry' && c['cols'] === 100,
    );
    expect(geometry['rows']).toBe(30);
    // An API resize takes the grid away from whichever viewport was driving
    // it, so nobody is left believing they still are.
    expect(geometry['control']).toBe('adopt');
    watcher.close();
  });

  it('tells each viewport whether the grid is theirs, adopted or held', async () => {
    // A viewport must not fit itself before it knows whether it is entitled
    // to: fitting resizes the PTY, possibly under a run that cannot take it.
    // So the daemon says which of the three positions each one is in.
    const session = await startNodeSession('geometry-on-connect');

    // Nobody driving, so the first to arrive picks the grid up.
    const first = await connectWs(td.port, session.id, td.token);
    const firstFrame = await first.waitForControl((c) => c['type'] === 'geometry');
    expect(firstFrame['control']).toBe('yours');

    // A second arrival is passive: it shows what it finds rather than
    // reshaping a session somebody else is already watching.
    const second = await connectWs(td.port, session.id, td.token);
    const secondFrame = await second.waitForControl((c) => c['type'] === 'geometry');
    expect(secondFrame['control']).toBe('adopt');

    // When the one driving leaves, the grid stays where it is and simply
    // belongs to nobody, so the next to arrive picks it up.
    first.close();
    await eventually(async () => {
      const third = await connectWs(td.port, session.id, td.token);
      const frame = await third.waitForControl((c) => c['type'] === 'geometry');
      third.close();
      return frame['control'] === 'yours';
    }, 10_000);
    second.close();

    // A held session never hands the grid to anyone.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('held-start'); setInterval(() => {}, 200)"],
        shell: false,
        label: 'geometry-on-connect-held',
        cols: 120,
        rows: 34,
        hold: true,
      },
    });
    expect(started.status).toBe(200);
    const heldSession = started.body as unknown as { id: string };

    const heldWatcher = await connectWs(td.port, heldSession.id, td.token);
    const heldFrame = await heldWatcher.waitForControl((c) => c['type'] === 'geometry');
    expect(heldFrame['control']).toBe('held');
    expect(heldFrame['cols']).toBe(120);
    expect(heldFrame['rows']).toBe(34);
    heldWatcher.close();
  });

  it('confirms a viewport resize to everyone, each from their own position', async () => {
    // The page asks for a grid and only the answer resizes it, so the answer
    // has to come back, including to the asker, whose local grid has not
    // moved yet. The loop this invites (fit → resize → geometry → fit) is
    // closed in the page: it proposes nothing once the grid already matches
    // what its window wants.
    const session = await startNodeSession('resize-confirm');
    const asker = await connectWs(td.port, session.id, td.token);
    await asker.waitForControl((c) => c['type'] === 'geometry');
    const bystander = await connectWs(td.port, session.id, td.token);
    await bystander.waitForControl((c) => c['type'] === 'geometry');

    asker.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 }));

    const mine = await asker.waitForControl(
      (c) => c['type'] === 'geometry' && c['cols'] === 90,
    );
    expect(mine['rows']).toBe(28);
    expect(mine['control']).toBe('yours');

    const theirs = await bystander.waitForControl(
      (c) => c['type'] === 'geometry' && c['cols'] === 90,
    );
    expect(theirs['control']).toBe('adopt');

    asker.close();
    bystander.close();
  });

  it('bounds the grid a viewport can ask for', async () => {
    // The human's monitor would otherwise set what the agent reads: a huge
    // window at a small font asks for a grid whose every snapshot is an order
    // of magnitude larger than the default.
    const session = await startNodeSession('resize-clamp');
    const watcher = await connectWs(td.port, session.id, td.token);
    await watcher.waitForControl((c) => c['type'] === 'geometry');

    watcher.ws.send(JSON.stringify({ type: 'resize', cols: 900, rows: 400 }));
    const frame = await watcher.waitForControl(
      (c) => c['type'] === 'geometry' && c['cols'] === 400,
    );
    expect(frame['rows']).toBe(150);
    watcher.close();
  });

  it('an adopting viewport that asks is handed the grid, even when it asks for the grid it already has', async () => {
    // Acting takes control: the way back from a grid somebody else chose. A
    // proposal that matches the current grid still changes hands, and both
    // viewports are told, or the old driver would go on believing the grid
    // was theirs.
    const session = await startNodeSession('adopter-takes-over');
    const first = await connectWs(td.port, session.id, td.token);
    await first.waitForControl((c) => c['type'] === 'geometry' && c['control'] === 'yours');
    const second = await connectWs(td.port, session.id, td.token);
    await second.waitForControl((c) => c['type'] === 'geometry' && c['control'] === 'adopt');

    second.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 }));
    await second.waitForControl(
      (c) => c['type'] === 'geometry' && c['cols'] === 90 && c['control'] === 'yours',
    );
    await first.waitForControl(
      (c) => c['type'] === 'geometry' && c['cols'] === 90 && c['control'] === 'adopt',
    );

    // Same grid, different hands: both are told, without a snapshot for it.
    const frames = (client: typeof first): Record<string, unknown>[] =>
      client.controls().filter((c) => c['type'] === 'geometry');
    const firstBefore = frames(first).length;
    const secondBefore = frames(second).length;
    first.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 }));
    await eventually(
      () => frames(first).length > firstBefore && frames(first).at(-1)?.['control'] === 'yours',
      10_000,
    );
    await eventually(
      () => frames(second).length > secondBefore && frames(second).at(-1)?.['control'] === 'adopt',
      10_000,
    );
    first.close();
    second.close();
  });

  it('answers a proposal past the bound once, however often the page repeats it', async () => {
    // The page proposes the grid its window wants; past the bound the daemon
    // answers with the clamped grid, and a page whose window has not changed
    // may propose the same again. It is the CLAMPED grid that has to be
    // compared with the session's: comparing the proposal would draw a fresh
    // frame for every repeat, and the two would ping-pong for ever.
    const session = await startNodeSession('resize-clamp-repeat');
    const watcher = await connectWs(td.port, session.id, td.token);
    const first = await watcher.waitForControl((c) => c['type'] === 'geometry');
    // Every frame says what the most is, so the page can stop asking for more.
    expect(first['max']).toEqual({ cols: 400, rows: 150 });

    watcher.ws.send(JSON.stringify({ type: 'resize', cols: 900, rows: 400 }));
    await watcher.waitForControl((c) => c['type'] === 'geometry' && c['cols'] === 400);
    const frames = (): number =>
      watcher.controls().filter((c) => c['type'] === 'geometry').length;
    const before = frames();

    watcher.ws.send(JSON.stringify({ type: 'resize', cols: 900, rows: 400 }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(frames()).toBe(before);
    watcher.close();
  });

  it('a held grid refuses a viewport, and holding is asked for rather than inferred', async () => {
    // A size at start is a starting size, not a hold: a frozen grid would
    // leave the human's viewer unable to fill a window of a different shape.
    // Holding is a separate, deliberate request.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('hold-me'); setInterval(() => {}, 200)"],
        shell: false,
        label: 'hold-me',
        cols: 120,
        rows: 34,
      },
    });
    const session = started.body as unknown as { id: string };

    const state = async (): Promise<{ cols: number; geometryHeld: boolean } | undefined> => {
      const list = await api(td.port, td.token, '/sessions');
      const sessions = list.body['sessions'] as {
        id: string;
        cols: number;
        geometryHeld: boolean;
      }[];
      return sessions.find((entry) => entry.id === session.id);
    };

    expect((await state())?.geometryHeld).toBe(false);

    const watcher = await connectWs(td.port, session.id, td.token);
    await watcher.waitForControl((c) => c['type'] === 'geometry');
    watcher.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 }));
    await eventually(async () => (await state())?.cols === 90, 10_000);

    // Now hold it, and the same viewport is refused, with the real grid sent
    // back so its page stops asking for one it will never be given.
    await api(td.port, td.token, `/sessions/${session.id}/resize`, {
      body: { cols: 100, rows: 30, hold: true },
    });
    await eventually(async () => (await state())?.geometryHeld === true, 10_000);

    watcher.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    const refusal = await watcher.waitForControl(
      (c) => c['type'] === 'geometry' && c['control'] === 'held',
    );
    expect(refusal['cols']).toBe(100);
    expect((await state())?.cols).toBe(100);
    watcher.close();
  });

  it('a viewer joining an exited session is told, and its keystrokes are refused out loud', async () => {
    // A session stays reachable for fifteen minutes after its process exits.
    // A viewer joining in that window is told the program has gone, and its
    // keystrokes are refused out loud, as the HTTP path refuses them with a
    // 409.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('last-words'); process.exit(7)"],
        shell: false,
        label: 'viewer-on-a-dead-session',
      },
    });
    expect(started.status).toBe(200);
    const { id, viewerUrl } = started.body as unknown as { id: string; viewerUrl: string };
    await eventually(async () => {
      const list = await api(td.port, td.token, '/sessions');
      const sessions = list.body['sessions'] as { id: string; exited: boolean }[];
      return sessions.find((s) => s.id === id)?.exited === true;
    }, 20_000);

    const viewer = await connectWsWithCookie(td.port, id, await redeemViewerUrl(viewerUrl));
    try {
      const identity = await viewer.waitForControl((c) => c['type'] === 'identity');
      expect(identity['exited']).toBe(true);
      expect(identity['exitCode']).toBe(7);

      // The same notice the watchers present at the exit received, replayed
      // to someone who arrived afterwards.
      await viewer.waitForData('[process exited: 7]');

      viewer.ws.send('typed-into-a-dead-session');
      const refused = await viewer.waitForControl((c) => c['type'] === 'input-refused');
      expect(refused['reason']).toBe('exited');
      expect(refused['exitCode']).toBe(7);
    } finally {
      viewer.close();
    }
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('a watcher present when the program exits is told in a control frame, before it types', async () => {
    // The late joiner above learns from its identity frame. A page that was
    // already watching is told the moment the process goes, rather than only
    // when it types and is refused.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('going'); setTimeout(() => process.exit(3), 4000)"],
        shell: false,
        label: 'watcher-present-at-exit',
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const watcher = await connectWs(td.port, id, td.token);
    try {
      const identity = await watcher.waitForControl((c) => c['type'] === 'identity');
      expect(identity['exited']).toBe(false);
      const exited = await watcher.waitForControl((c) => c['type'] === 'exited');
      expect(exited['exitCode']).toBe(3);
      await watcher.waitForData('[process exited: 3]');
    } finally {
      watcher.close();
    }
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('closes viewer sockets when the session is killed', async () => {
    const session = await startNodeSession('kill-closes-sockets');
    const watcher = await connectWs(td.port, session.id, td.token);
    const closed = new Promise<void>((resolve) => watcher.ws.on('close', () => resolve()));
    await api(td.port, td.token, `/sessions/${session.id}`, { method: 'DELETE' });
    await closed;
  });
});

describe('policy enforcement at the API (§4.3)', () => {
  it('refuses commands off the allowlist with 403 and enforces maxSessions', async () => {
    const restricted = await startTestDaemon({
      policy: {
        mode: 'allowlist',
        allow: ['^node', `^${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`],
        maxSessions: 1,
      },
    });
    try {
      const refused = await api(restricted.port, restricted.token, '/sessions', {
        body: { command: 'powershell', args: [] },
      });
      expect(refused.status).toBe(403);
      expect(String(refused.body['error'])).toContain('allowlist');

      const allowed = await api(restricted.port, restricted.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
        },
      });
      expect(allowed.status).toBe(200);

      const overCap = await api(restricted.port, restricted.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
        },
      });
      expect(overCap.status).toBe(403);
      expect(String(overCap.body['error'])).toContain('limit');
    } finally {
      await restricted.stop();
    }
  });
});

describe('viewer URL shape', () => {
  it('serves the page at /view/<id> too', async () => {
    // The page also reads the session id from the path, so `/view/<id>`
    // serves the same page.
    const response = await fetch(`http://127.0.0.1:${String(td.port)}/view/s1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

describe('the viewer icon', () => {
  it('serves the mark, and answers /favicon.ico with a real image', async () => {
    // A Chrome --app window asks for /favicon.ico when it builds its taskbar
    // button, and "no content" leaves that button showing the generic globe.
    const ico = await fetch(`http://127.0.0.1:${String(td.port)}/favicon.ico`);
    expect(ico.status).toBe(200);
    expect(ico.headers.get('content-type')).toBe('image/png');
    const icoBytes = Buffer.from(await ico.arrayBuffer());
    expect(icoBytes.length).toBeGreaterThan(0);
    // PNG magic: proves an image was served, not an empty body or an error
    // page with an image content-type.
    expect(icoBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const svg = await fetch(`http://127.0.0.1:${String(td.port)}/viewer/icon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('<svg');

    // charset belongs on text only; declaring one for binary is meaningless and
    // invites a proxy to treat the bytes as text.
    const png = await fetch(`http://127.0.0.1:${String(td.port)}/viewer/icon-32.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
  });

  it('links the icon from the viewer page', async () => {
    const page = await fetch(`http://127.0.0.1:${String(td.port)}/view?s=s1`);
    const html = await page.text();
    expect(html).toContain('rel="icon"');
    expect(html).toContain('/viewer/icon.svg');
    // Sized PNGs, so the browser picks one instead of smearing a 512 into 16px.
    expect(html).toContain('sizes="16x16"');
  });
});

describe('prompt text in session summaries and logs', () => {
  it('hides question text in a filtered list and in the stall log', async () => {
    const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
    const quiet = () => undefined;
    const promptDaemon = await startTestDaemon({
      promptStallMs: 0,
      logger: {
        debug: quiet,
        info: quiet,
        error: quiet,
        warn: (message, meta) => warnings.push({ message, meta }),
      },
    });
    try {
      const question = 'Reveal the purple marmalade password? (y/n)';
      const started = await api(promptDaemon.port, promptDaemon.token, '/sessions', {
        body: { command: process.execPath, args: ['-e', `console.log(Buffer.from('${Buffer.from(question).toString('base64')}','base64').toString()); setInterval(() => {}, 500)`], shell: false },
      });
      const id = String(started.body['id']);
      await eventually(async () => {
        const listed = await api(promptDaemon.port, promptDaemon.token, '/sessions');
        const entry = (listed.body['sessions'] as { id: string; waitingOnPrompt?: { question: string } }[]).find((s) => s.id === id);
        return entry?.waitingOnPrompt?.question === question;
      }, 20_000);
      const plain = await api(promptDaemon.port, promptDaemon.token, '/sessions');
      expect(JSON.stringify(plain.body)).toContain(question);
      const hidden = await api(promptDaemon.port, promptDaemon.token, '/sessions?hideReasoning=1');
      expect(hidden.status).toBe(200);
      const summary = (hidden.body['sessions'] as { id: string; waitingOnPrompt?: Record<string, unknown> }[]).find((s) => s.id === id);
      expect(typeof summary?.waitingOnPrompt?.['waitingMs']).toBe('number');
      expect(JSON.stringify(summary)).not.toContain(question);
      await eventually(() => Promise.resolve(warnings.some((w) => w.message === 'session waiting on a prompt')), 20_000);
      expect(JSON.stringify(warnings.find((w) => w.message === 'session waiting on a prompt'))).not.toContain(question);
    } finally {
      await promptDaemon.stop();
    }
  }, 60_000);
});

describe('screenshots without a browser (§5)', () => {
  // Neither test needs a browser: the first replaces the capture with a seam
  // and the second names a browser that does not exist. The real capture is
  // exercised in viewer-capture.test.ts, which skips where none is installed.

  it('photographs through a credential that may watch but never write', async () => {
    // A picture must not be able to type into, or reshape, the thing it is
    // photographing.
    const seen: { readOnly: unknown; control: unknown }[] = [];
    let port = 0;
    const shooter = await startTestDaemon({
      // Any existing file passes for a browser: the seam below is what runs.
      viewer: { browserPath: process.execPath },
      capture: async (options) => {
        const sessionId = new URL(options.viewerUrl).searchParams.get('s') ?? '';
        const cookie = await redeemViewerUrl(options.viewerUrl);
        const viewer = await connectWsWithCookie(port, sessionId, cookie);
        const identity = await viewer.waitForControl((c) => c['type'] === 'identity');
        const geometry = await viewer.waitForControl((c) => c['type'] === 'geometry');
        seen.push({ readOnly: identity['readOnly'], control: geometry['control'] });
        viewer.close();
        return { png: Buffer.from('not-a-png'), width: 800, height: 600, rows: ['photographed'] };
      },
    });
    port = shooter.port;
    try {
      const started = await api(shooter.port, shooter.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('shot-seam'); setInterval(() => {}, 200)"],
          shell: false,
        },
      });
      const id = String(started.body['id']);
      // Present and not a number is refused, not quietly defaulted.
      const typed = await api(shooter.port, shooter.token, `/sessions/${id}/screenshot`, {
        body: { width: '800', height: 600 },
      });
      expect(typed.status).toBe(400);
      const shot = await api(shooter.port, shooter.token, `/sessions/${id}/screenshot`, {
        body: { width: 800, height: 600 },
      });
      expect(shot.status).toBe(200);
      expect(shot.body['lines']).toEqual(['photographed']);
      expect(seen).toEqual([{ readOnly: true, control: 'adopt' }]);
    } finally {
      await shooter.stop();
    }
  });

  it('takes the capture credential back when the capture ends', async () => {
    // The photographer's credential must not outlive the photograph, or a
    // session photographed a thousand times would hold a thousand
    // credentials that could each open a socket. Asserted from outside, on the
    // cookie the capture was given, because the daemon's token store is
    // private and a seam onto it would be a test-only door into the
    // credentials this is about.
    let capturedCookie = '';
    let port = 0;
    const shooter = await startTestDaemon({
      viewer: { browserPath: process.execPath },
      capture: async (options) => {
        capturedCookie = await redeemViewerUrl(options.viewerUrl);
        const sessionId = new URL(options.viewerUrl).searchParams.get('s') ?? '';
        // It works WHILE the capture runs. Without that, the assertion below
        // would pass against a credential that never worked at all.
        const viewer = await connectWsWithCookie(port, sessionId, capturedCookie);
        await viewer.waitForControl((c) => c['type'] === 'identity');
        viewer.close();
        return { png: Buffer.from('not-a-png'), width: 800, height: 600, rows: ['gone-after'] };
      },
    });
    port = shooter.port;
    try {
      const started = await api(shooter.port, shooter.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('shot-revoke'); setInterval(() => {}, 200)"],
          shell: false,
        },
      });
      const id = String(started.body['id']);
      // The human's own link, opened before the picture and still expected to
      // work after it: revoking the capture's grant must not touch it.
      const human = await redeemViewerUrl(String(started.body['viewerUrl']));

      const shot = await api(shooter.port, shooter.token, `/sessions/${id}/screenshot`, {
        body: { width: 800, height: 600 },
      });
      expect(shot.status).toBe(200);

      await expectWsRejected(shooter.port, id, '', { cookie: capturedCookie });
      const stillWatching = await connectWsWithCookie(shooter.port, id, human);
      await stillWatching.waitForControl((c) => c['type'] === 'identity');
      stillWatching.close();
    } finally {
      await shooter.stop();
    }
  });

  it('carries the capture budget to the capture, and refuses one outside its bounds', async () => {
    // A caller may move the budget: a capture that worked took 20.8 s on a
    // cold Windows CI runner.
    const budgets: (number | undefined)[] = [];
    const shooter = await startTestDaemon({
      viewer: { browserPath: process.execPath },
      capture: (options) => {
        budgets.push(options.timeoutMs);
        return Promise.resolve({
          png: Buffer.from('not-a-png'),
          width: 800,
          height: 600,
          rows: ['budgeted'],
        });
      },
    });
    try {
      const started = await api(shooter.port, shooter.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('shot-budget'); setInterval(() => {}, 200)"],
          shell: false,
        },
      });
      const id = String(started.body['id']);
      const shoot = (body: Record<string, unknown>): Promise<ApiResult> =>
        api(shooter.port, shooter.token, `/sessions/${id}/screenshot`, { body });

      expect((await shoot({})).status).toBe(200);
      expect(budgets[0]).toBe(DEFAULT_CAPTURE_TIMEOUT_MS);

      expect((await shoot({ timeoutMs: 5_000 })).status).toBe(200);
      expect(budgets[1]).toBe(5_000);

      // Outside the bounds, or not a number at all, is refused rather than
      // quietly defaulted, as width and height are.
      expect((await shoot({ timeoutMs: 10 })).status).toBe(400);
      expect((await shoot({ timeoutMs: 999_999 })).status).toBe(400);
      expect((await shoot({ timeoutMs: '5000' })).status).toBe(400);
      expect(budgets).toHaveLength(2);
    } finally {
      await shooter.stop();
    }
  });

  it('answers 503, not a picture of something else, when there is no browser', async () => {
    // No silent fallback to re-rendering the cells: that would be a picture of
    // what the daemon thinks, labelled as what the browser drew, which is
    // exactly the disagreement a screenshot exists to find.
    const home = makeTempHome('shellpuppet-noshot-');
    const shooter = await startTestDaemon({
      home,
      viewer: { browserPath: path.join(home, 'no-such-browser') },
    });
    try {
      const started = await api(shooter.port, shooter.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', "console.log('shot-none'); setInterval(() => {}, 200)"],
          shell: false,
        },
      });
      const id = String(started.body['id']);
      const shot = await api(shooter.port, shooter.token, `/sessions/${id}/screenshot`, {
        body: { width: 800, height: 600 },
      });
      expect(shot.status).toBe(503);
      expect(String(shot.body['error'])).toContain('No Chromium-family browser');
    } finally {
      await shooter.stop();
    }
  });
});

describe('errors the daemon carries on through', () => {
  it('logs every error on its HTTP server once listening, and goes on answering', async () => {
    // Once listening, an error on the server is a connection it failed to
    // accept, out of handles say. With no listener it would be an uncaught
    // exception, on which the daemon shuts down with every session. Out of
    // handles, such failures come in runs, so it is heard every time.
    const errors: { message: string; meta?: Record<string, unknown> }[] = [];
    const ignore = (): void => undefined;
    const listener = await startTestDaemon({
      logger: { debug: ignore, info: ignore, warn: ignore, error: (message, meta) => errors.push({ message, meta }) },
    });
    try {
      const server = (listener.daemon as unknown as { server: http.Server }).server;
      const refused = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE', syscall: 'accept' });
      expect(() => server.emit('error', refused)).not.toThrow();
      expect(() => server.emit('error', refused)).not.toThrow();
      const line = { message: 'http server error', meta: { error: 'Error: accept EMFILE' } };
      expect(errors).toEqual([line, line]);
      expect((await api(listener.port, null, '/health')).status).toBe(200);
    } finally {
      await listener.stop();
    }
  });
});
