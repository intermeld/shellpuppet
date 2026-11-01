/**
 * Dashboard launch profiles: the route, its caps, the environment it copies
 * and the folder it chooses (design §4.3, §5.1; ADR-009).
 *
 * The page names a profile and nothing else. Every test here starts from a
 * real dashboard cookie and proof, so the route is exercised exactly as the
 * page will call it.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditor } from '../../src/daemon/audit.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { readDaemonState } from '../../src/daemon/paths.js';
import type { LauncherConfig } from '../../src/daemon/launchProfiles.js';
import type { PolicyConfig } from '../../src/core/types.js';
import {
  api,
  connectWsWithCookie,
  eventually,
  interactiveShell,
  makeTempHome,
  redeemViewerUrl,
  repoRoot,
  startTestDaemon,
} from './helpers.js';
import type { TestDaemon } from './helpers.js';

const execFileAsync = promisify(execFile);
const ensureDaemonFixture = path.join(repoRoot, 'test', 'integration', 'fixtures', 'ensure-daemon.mjs');

interface RawResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface LaunchDaemon extends TestDaemon {
  cookie: string;
  proof: string;
  logPath: string;
  urls: string[];
}

const running: LaunchDaemon[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  const pending = running.splice(0);
  for (const daemon of pending) await daemon.stop();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a folder a killed process ran in for a moment.
    }
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Parse profile entries the way the daemon does, insisting they all load. */
function profilesOf(entries: unknown[]): LauncherConfig {
  const { config, problems } = parseDaemonConfig({ launcher: { profiles: entries } });
  expect(problems).toEqual([]);
  if (config.launcher === undefined) throw new Error('launcher did not parse');
  return config.launcher;
}

function raw(
  port: number,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: { host: `127.0.0.1:${String(port)}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function headerList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cookiePair(headers: http.IncomingHttpHeaders): string {
  const line = headerList(headers['set-cookie'])[0] ?? '';
  return line.split(';')[0] ?? '';
}

function csrfMeta(html: string): string | null {
  const match = /<meta name="sp-csrf" content="([^"]*)">/.exec(html);
  return match === null ? null : (match[1] ?? '');
}

function navigationHeaders(): Record<string, string> {
  return {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-site': 'none',
  };
}

async function startLaunchDaemon(options: {
  launcher?: LauncherConfig;
  policy?: PolicyConfig;
} = {}): Promise<LaunchDaemon> {
  const home = makeTempHome('dash-launch-');
  const logPath = path.join(home, 'daemon.log');
  const urls: string[] = [];
  const daemon = await startTestDaemon({
    home,
    logger: createFileLogger(logPath),
    audit: createAuditor(home),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    launchProfiles: options.launcher ?? { profiles: [], problems: [] },
    viewer: { launchMode: 'none' },
    promptScanIntervalMs: 600_000,
    idleCheckIntervalMs: 600_000,
    launcher: (url) => {
      urls.push(url);
      return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
    },
  });

  const opened = await api(daemon.port, daemon.token, '/dashboard/open', {
    method: 'POST',
    body: {},
  });
  expect(opened.status).toBe(200);
  const url = urls.at(-1) ?? '';
  const grant = new URL(url).searchParams.get('dt') ?? '';
  const page = await raw(daemon.port, 'GET', `/dashboard?dt=${grant}`, navigationHeaders());
  expect(page.status).toBe(200);
  const cookie = cookiePair(page.headers);
  const proof = csrfMeta(page.body) ?? '';
  expect(cookie).toMatch(/^sp_dash=/);
  expect(proof).toMatch(/^[0-9a-f]{64}$/);

  const wrapped = Object.assign(daemon, { cookie, proof, logPath, urls });
  running.push(wrapped);
  return wrapped;
}

function launchHeaders(
  daemon: LaunchDaemon,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    cookie: daemon.cookie,
    'x-shellpuppet-csrf': daemon.proof,
    origin: `http://127.0.0.1:${String(daemon.port)}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...extra,
  };
}

function launchRaw(
  daemon: LaunchDaemon,
  body: string,
  extra: Record<string, string> = {},
): Promise<RawResult> {
  return raw(daemon.port, 'POST', '/dashboard/launch', launchHeaders(daemon, extra), body);
}

function launch(
  daemon: LaunchDaemon,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<RawResult> {
  return launchRaw(daemon, JSON.stringify(body), extra);
}

function readProfiles(
  daemon: LaunchDaemon,
  extra: Record<string, string> = {},
): Promise<RawResult> {
  return raw(daemon.port, 'GET', '/dashboard/profiles', {
    cookie: daemon.cookie,
    'x-shellpuppet-csrf': daemon.proof,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...extra,
  });
}

async function sessionIds(daemon: TestDaemon): Promise<string[]> {
  const list = await api(daemon.port, daemon.token, '/sessions');
  expect(list.status).toBe(200);
  return ((list.body['sessions'] as { id: string }[] | undefined) ?? []).map((session) => session.id);
}

async function screenOf(daemon: TestDaemon, id: string): Promise<string> {
  const snapshot = await api(daemon.port, daemon.token, `/sessions/${id}/snapshot`);
  expect(snapshot.status).toBe(200);
  const screen = snapshot.body['screen'];
  return typeof screen === 'string' ? screen : '';
}

async function waitForScreen(daemon: TestDaemon, id: string, needle: string): Promise<void> {
  await eventually(async () => (await screenOf(daemon, id)).includes(needle), 15_000);
}

function auditEntries(home: string): Record<string, unknown>[] {
  const file = path.join(home, 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function refusalReasons(home: string): string[] {
  return auditEntries(home)
    .filter((line) => line['action'] === 'refuse')
    .map((line) => String((line['meta'] as Record<string, unknown> | undefined)?.['reason']));
}

/**
 * Stand-in live sessions for the default thirty-two cap. They spawn no
 * process; the cap reads only `liveCount`, and these are shaped so the
 * daemon's teardown skips a tree kill and releases them cleanly.
 */
function padLiveSessions(daemon: TestDaemon, count: number): void {
  const manager = (daemon.daemon as unknown as {
    manager: { sessions: Map<string, unknown> };
  }).manager;
  for (let index = 0; index < count; index++) {
    manager.sessions.set(`pad${String(index)}`, {
      id: `pad${String(index)}`,
      exited: false,
      programEnded: true,
      pid: 0,
      kill: () => Promise.resolve(),
    });
  }
}

describe('the body names a profile and cannot widen it', () => {
  it('refuses a command, a missing profile and extra arguments, then starts the profile', async () => {
    const dir = makeDir('dash-launch-cwd-');
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        {
          name: 'shell',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
          cwd: dir,
          label: 'A quiet shell',
        },
      ]),
    });

    const before = await sessionIds(daemon);
    for (const body of [
      { profile: 'shell', command: 'calc' },
      { command: 'calc' },
      { profile: 'shell', args: ['/c', 'calc'] },
    ]) {
      const refused = await launch(daemon, body);
      expect(refused.status).toBe(400);
      expect(await sessionIds(daemon)).toEqual(before);
    }

    const started = await launch(daemon, { profile: 'shell' });
    expect(started.status).toBe(200);
    const body = JSON.parse(started.body) as Record<string, unknown>;
    expect(String(body['id'])).toMatch(/^s\d+$/);
    expect(body['open']).toBe('grid');
    expect(body['profile']).toBe('shell');
    expect(await sessionIds(daemon)).toHaveLength(before.length + 1);

    const entry = auditEntries(daemon.home).find(
      (line) => line['actor'] === 'dashboard' && line['action'] === 'start',
    );
    expect(entry).toBeDefined();
    expect(entry?.['meta']).toMatchObject({ profile: 'shell', command: process.execPath });
    expect(JSON.stringify(entry)).not.toContain('calc');
  });

  it('refuses the profile list and the launch without the document proof or from a foreign origin', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([{ name: 'shell', command: process.execPath, args: ['-e', '0'], shell: false }]),
    });
    const before = await sessionIds(daemon);

    const noProof = await readProfiles(daemon, { 'x-shellpuppet-csrf': '' });
    expect(noProof.status).toBe(403);
    const noProofLaunch = await launch(daemon, { profile: 'shell' }, { 'x-shellpuppet-csrf': '' });
    expect(noProofLaunch.status).toBe(403);
    expect(await sessionIds(daemon)).toEqual(before);

    const foreign = await launch(
      daemon,
      { profile: 'shell' },
      { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    );
    expect(foreign.status).toBe(403);
    expect(await sessionIds(daemon)).toEqual(before);

    const form = await launch(
      daemon,
      { profile: 'shell' },
      { 'content-type': 'application/x-www-form-urlencoded' },
    );
    expect(form.status).toBe(415);
    expect(await sessionIds(daemon)).toEqual(before);
  });
});

describe('a bad profile is left out and its siblings load', () => {
  it('names every bad entry and still starts the valid one', async () => {
    const dir = makeDir('dash-launch-good-');
    const { config, problems } = parseDaemonConfig({
      launcher: {
        profiles: [
          { name: 'unknown-key', command: 'cmd.exe', surprise: true },
          { name: 'Bad Name', command: 'cmd.exe' },
          { name: 'both-ready', command: 'cmd.exe', readyText: 'x', readyQuiet: 10 },
          { name: 'ask-no-folders', command: 'cmd.exe', cwd: 'ask' },
          {
            name: 'good',
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 200)'],
            shell: false,
            cwd: dir,
          },
        ],
      },
    });
    const text = problems.join('\n');
    for (const name of ['unknown-key', 'Bad Name', 'both-ready', 'ask-no-folders']) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('unknown key "launcher"');
    expect(config.launcher?.profiles.map((profile) => profile.name)).toEqual(['good']);

    const daemon = await startLaunchDaemon({ launcher: config.launcher });
    const list = await readProfiles(daemon);
    expect(list.status).toBe(200);
    const body = JSON.parse(list.body) as {
      profiles: { name: string }[];
      problems: string[];
    };
    expect(body.profiles.map((profile) => profile.name)).toEqual(['good']);
    expect(body.problems.join('\n')).toContain('unknown-key');

    const bad = await launch(daemon, { profile: 'unknown-key' });
    expect(bad.status).toBe(400);
    const good = await launch(daemon, { profile: 'good' });
    expect(good.status).toBe(200);
  });

  it('the real daemon names a bad entry in daemon.log at start', async () => {
    const home = makeTempHome('dash-launch-log-');
    const tmp = path.join(home, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        viewer: { launchMode: 'none' },
        launcher: {
          profiles: [
            { name: 'bad-entry', command: 'cmd.exe', surprise: true },
            { name: 'good-entry', command: process.execPath, shell: false },
          ],
        },
      }),
    );
    try {
      await execFileAsync(process.execPath, [ensureDaemonFixture], {
        env: { ...process.env, SHELLPUPPET_HOME: home, TEMP: tmp, TMP: tmp },
        timeout: 30_000,
      });
      const log = fs.readFileSync(path.join(home, 'daemon.log'), 'utf8');
      expect(log).toContain('bad-entry');
      expect(log).toContain('surprise');
      expect(log).not.toContain('unknown key "launcher"');
    } finally {
      const state = readDaemonState(home);
      if (state !== null) {
        try {
          await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } });
        } catch {
          // The daemon has already gone.
        }
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // Windows can hold the log open for a moment.
      }
    }
  });
});

describe('policy sees the real command, and both caps bite', () => {
  it('refuses a denied profile and one outside the allowlist, and audits the real command', async () => {
    const daemon = await startLaunchDaemon({
      policy: { mode: 'allowlist', allow: ['node'] },
      launcher: profilesOf([
        { name: 'blocked', command: 'forbidden-program', shell: false },
        {
          name: 'denied',
          command: process.execPath,
          args: ['--dangerously-skip-permissions'],
          shell: false,
          policy: { deny: ['--dangerously'] },
        },
        {
          name: 'allowed',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
        },
      ]),
    });

    const blocked = await launch(daemon, { profile: 'blocked' });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toContain('not on the allowlist');
    expect(blocked.body).toContain('forbidden-program');

    const denied = await launch(daemon, { profile: 'denied' });
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('deny rule');
    expect(denied.body).toContain('--dangerously');

    const allowed = await launch(daemon, { profile: 'allowed' });
    expect(allowed.status).toBe(200);
    const entry = auditEntries(daemon.home).find(
      (line) => line['actor'] === 'dashboard' && line['action'] === 'start',
    );
    expect(entry?.['meta']).toMatchObject({ command: process.execPath });
    expect(JSON.stringify(entry)).not.toContain('cmd.exe /c');
  });

  it('applies policy.maxSessions as the live cap', async () => {
    const daemon = await startLaunchDaemon({
      policy: { mode: 'allow-all', maxSessions: 1 },
      launcher: profilesOf([
        {
          name: 'quiet',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
        },
      ]),
    });
    const first = await api(daemon.port, daemon.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        openViewer: false,
      },
    });
    expect(first.status).toBe(200);

    const before = await sessionIds(daemon);
    const refused = await launch(daemon, { profile: 'quiet' });
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('Session limit reached (1 live sessions)');
    expect(await sessionIds(daemon)).toEqual(before);
  });

  it('refuses at thirty-two live sessions when no maxSessions is set', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        {
          name: 'quiet',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
        },
      ]),
    });
    padLiveSessions(daemon, 32);
    const refused = await launch(daemon, { profile: 'quiet' });
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('Session limit reached (32 live sessions)');
    expect(refused.body).toContain('policy.maxSessions');
  });

  it('accepts eight launches in a minute, refuses the ninth, and leaves the client token uncapped', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        {
          name: 'quick',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          shell: false,
        },
      ]),
    });
    for (let index = 0; index < 8; index++) {
      const started = await launch(daemon, { profile: 'quick' });
      expect(started.status).toBe(200);
    }
    const beforeNinth = await sessionIds(daemon);
    const ninth = await launch(daemon, { profile: 'quick' });
    expect(ninth.status).toBe(429);
    expect(ninth.body).toContain(
      'Dashboard launch rate reached (8 in 60 seconds). Wait before starting another profile.',
    );
    expect(await sessionIds(daemon)).toEqual(beforeNinth);

    const clientStart = await api(daemon.port, daemon.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        openViewer: false,
      },
    });
    expect(clientStart.status).toBe(200);
  });
});

describe('envFromDaemon copies names from the daemon, never from the body', () => {
  it('copies a configured name and keeps its value out of the response and audit line', async () => {
    const variable = 'SP_LAUNCH_TEST_TOKEN';
    const value = 's3cret-launch-value';
    process.env[variable] = value;
    try {
      const daemon = await startLaunchDaemon({
        launcher: profilesOf([
          {
            name: 'envtest',
            command: process.execPath,
            args: [
              '-e',
              `console.log("GOT=" + (process.env.${variable} ?? "missing"))`,
            ],
            shell: false,
            envFromDaemon: [variable],
          },
          {
            name: 'noenv',
            command: process.execPath,
            args: [
              '-e',
              `console.log("GOT=" + (process.env.${variable} ?? "missing"))`,
            ],
            shell: false,
            agent: 'claude',
          },
        ]),
      });

      const started = await launch(daemon, { profile: 'envtest' });
      expect(started.status).toBe(200);
      expect(started.body).toContain(variable);
      expect(started.body).not.toContain(value);
      const id = String((JSON.parse(started.body) as Record<string, unknown>)['id']);
      await waitForScreen(daemon, id, `GOT=${value}`);

      const entry = auditEntries(daemon.home).find(
        (line) => line['actor'] === 'dashboard' && line['action'] === 'start',
      );
      expect(JSON.stringify(entry)).toContain(variable);
      expect(JSON.stringify(entry)).not.toContain(value);

      const before = await sessionIds(daemon);
      const bodyEnv = await launch(daemon, {
        profile: 'envtest',
        env: { [variable]: 'body-value' },
        envFromDaemon: [variable],
      });
      expect(bodyEnv.status).toBe(400);
      expect(await sessionIds(daemon)).toEqual(before);

      const noEnv = await launch(daemon, { profile: 'noenv' });
      expect(noEnv.status).toBe(200);
      const noEnvId = String((JSON.parse(noEnv.body) as Record<string, unknown>)['id']);
      await waitForScreen(daemon, noEnvId, 'GOT=missing');
    } finally {
      delete process.env[variable];
    }
  });
});

describe('the page chooses a folder by name', () => {
  it('uses the fixed directory, and a listed folder name on an ask profile', async () => {
    const fixedDir = makeDir('dash-launch-fixed-');
    const folderDir = makeDir('dash-launch-folder-');
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        {
          name: 'fixed',
          command: process.execPath,
          args: ['-e', 'console.log("CWD=" + process.cwd())'],
          shell: false,
          cwd: fixedDir,
        },
        {
          name: 'ask',
          command: process.execPath,
          args: ['-e', 'console.log("CWD=" + process.cwd())'],
          shell: false,
          cwd: 'ask',
          folders: [{ name: 'alpha', path: folderDir }],
        },
      ]),
    });

    const before = await sessionIds(daemon);
    const extra = await launch(daemon, { profile: 'fixed', folder: 'alpha' });
    expect(extra.status).toBe(400);
    expect(await sessionIds(daemon)).toEqual(before);

    const fixed = await launch(daemon, { profile: 'fixed' });
    expect(fixed.status).toBe(200);
    const fixedId = String((JSON.parse(fixed.body) as Record<string, unknown>)['id']);
    await waitForScreen(daemon, fixedId, `CWD=${fs.realpathSync(fixedDir)}`);
    // The whole line, so a fixed folder inside the repository does not read as the repository itself.
    const cwdLines = (await screenOf(daemon, fixedId)).split(/\r?\n/).map((line) => line.trimEnd());
    expect(cwdLines).not.toContain(`CWD=${fs.realpathSync(repoRoot)}`);

    const asked = await launch(daemon, { profile: 'ask', folder: 'alpha' });
    expect(asked.status).toBe(200);
    const askedId = String((JSON.parse(asked.body) as Record<string, unknown>)['id']);
    await waitForScreen(daemon, askedId, `CWD=${fs.realpathSync(folderDir)}`);
    const entry = auditEntries(daemon.home)
      .filter((line) => line['actor'] === 'dashboard' && line['action'] === 'start')
      .find((line) => (line['meta'] as Record<string, unknown> | undefined)?.['profile'] === 'ask');
    expect(entry?.['meta']).toMatchObject({ folder: 'alpha' });

    const unknown = await launch(daemon, { profile: 'ask', folder: 'nope' });
    expect(unknown.status).toBe(400);
    const rawPath = await launch(daemon, { profile: 'ask', folder: folderDir });
    expect(rawPath.status).toBe(400);
    const withCwd = await launch(daemon, {
      profile: 'ask',
      folder: 'alpha',
      cwd: folderDir,
    });
    expect(withCwd.status).toBe(400);
  });
});

describe('no profiles means a watch-only dashboard', () => {
  it('lists nothing, refuses a launch, and leaves an existing session typable', async () => {
    const daemon = await startLaunchDaemon();
    const list = await readProfiles(daemon);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual({ profiles: [], problems: [] });
    const refused = await launch(daemon, { profile: 'anything' });
    expect(refused.status).toBe(400);

    const shell = interactiveShell();
    const started = await api(daemon.port, daemon.token, '/sessions', {
      body: { command: shell.command, shell: false, openViewer: false, label: 'typing' },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const viewer = await api(daemon.port, daemon.token, `/sessions/${id}/viewer`, {
      method: 'POST',
      body: {},
    });
    expect(viewer.status).toBe(200);
    const cookie = await redeemViewerUrl(String(viewer.body['viewerUrl']));
    const socket = await connectWsWithCookie(daemon.port, id, cookie);
    try {
      socket.ws.send('echo COOKIE_TYPING\r');
      await socket.waitForData('COOKIE_TYPING');
    } finally {
      socket.close();
    }
  });
});

describe('the program is resolved before it is spawned', () => {
  it('runs the program on PATH, not a same-named executable in the chosen folder', async () => {
    if (process.platform !== 'win32') return;
    const binDir = makeDir('dash-launch-bin-');
    const workDir = makeDir('dash-launch-decoy-');
    // Two harmless script runners we write ourselves: one on PATH, one in the
    // folder the session starts in. Nothing is taken from outside these dirs.
    fs.writeFileSync(path.join(binDir, 'sptool.cmd'), '@echo off\r\necho REAL_RAN\r\n');
    fs.writeFileSync(path.join(workDir, 'sptool.cmd'), '@echo off\r\necho DECOY_RAN\r\n');

    const savedPath = process.env['PATH'];
    const savedNoDefault = process.env['NoDefaultCurrentDirectoryInExePath'];
    process.env['PATH'] = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    // The stock Windows behaviour: cmd.exe searches the current directory.
    delete process.env['NoDefaultCurrentDirectoryInExePath'];
    try {
      const daemon = await startLaunchDaemon({
        launcher: profilesOf([{ name: 'tool', command: 'sptool', cwd: workDir }]),
      });
      const started = await launch(daemon, { profile: 'tool' });
      expect(started.status).toBe(200);
      const id = String((JSON.parse(started.body) as Record<string, unknown>)['id']);
      await eventually(async () => {
        const screen = await screenOf(daemon, id);
        return screen.includes('REAL_RAN') || screen.includes('DECOY_RAN');
      }, 15_000);
      const screen = await screenOf(daemon, id);
      expect(screen).toContain('REAL_RAN');
      expect(screen).not.toContain('DECOY_RAN');

      const entry = auditEntries(daemon.home).find(
        (line) => line['actor'] === 'dashboard' && line['action'] === 'start',
      );
      // The written command stays for policy and the page; the audit also
      // records the file that was actually started. Windows names files
      // without case, and the suffix comes from PATHEXT.
      const meta = entry?.['meta'] as Record<string, unknown> | undefined;
      expect(meta?.['command']).toBe('sptool');
      expect(String(meta?.['resolvedCommand']).toLowerCase()).toBe(
        path.join(binDir, 'sptool.cmd').toLowerCase(),
      );
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      if (savedNoDefault === undefined) delete process.env['NoDefaultCurrentDirectoryInExePath'];
      else process.env['NoDefaultCurrentDirectoryInExePath'] = savedNoDefault;
    }
  });

  it('refuses a profile whose command cannot be resolved, before anything starts', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([{ name: 'missing', command: 'sp-no-such-program-xyz' }]),
    });
    const before = await sessionIds(daemon);
    const refused = await launch(daemon, { profile: 'missing' });
    expect(refused.status).toBe(400);
    expect(refused.body).toContain('sp-no-such-program-xyz');
    expect(refused.body).toContain('PATH');
    expect(await sessionIds(daemon)).toEqual(before);
    expect(refusalReasons(daemon.home)).toContain('command');
  });
});

describe('the launch body cannot confuse the request', () => {
  it('refuses __proto__, constructor, duplicate keys and arrays, and starts nothing', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        { name: 'quick', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false },
      ]),
    });
    const before = await sessionIds(daemon);
    const bodies = [
      '{"profile":"quick","__proto__":{"polluted":true}}',
      '{"profile":"quick","constructor":{"prototype":{"polluted":true}}}',
      '{"profile":"quick","profile":"nope"}',
      '{"profile":["quick"]}',
      '{"profile":7}',
    ];
    const statuses: number[] = [];
    for (const body of bodies) statuses.push((await launchRaw(daemon, body)).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400]);
    // The last duplicate wins, and the refusal names it.
    const duplicate = await launchRaw(daemon, '{"profile":"quick","profile":"nope"}');
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toContain('nope');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(await sessionIds(daemon)).toEqual(before);
  });

  it('refuses a folder name that is a path, and still takes the configured name', async () => {
    const folderDir = makeDir('dash-launch-paths-');
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        {
          name: 'ask',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          shell: false,
          cwd: 'ask',
          folders: [{ name: 'alpha', path: folderDir }],
        },
      ]),
    });
    const before = await sessionIds(daemon);
    const pathShaped = [
      '..\\',
      '..\\..\\Windows',
      'C:/Windows',
      '\\\\server\\share',
      'D:',
      '/etc',
      folderDir,
      'alpha/../alpha',
    ];
    const statuses: number[] = [];
    for (const folder of pathShaped) {
      statuses.push((await launch(daemon, { profile: 'ask', folder })).status);
    }
    expect(statuses).toEqual(pathShaped.map(() => 400));
    const arrayFolder = await launch(daemon, { profile: 'ask', folder: ['alpha'] });
    expect(arrayFolder.status).toBe(400);
    expect(await sessionIds(daemon)).toEqual(before);

    const accepted = await launch(daemon, { profile: 'ask', folder: 'alpha' });
    expect(accepted.status).toBe(200);
  });

  it('answers malformed JSON with 400 and starts nothing', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        { name: 'quick', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false },
      ]),
    });
    const before = await sessionIds(daemon);
    const refused = await launchRaw(daemon, '{"profile":');
    expect(refused.status).toBe(400);
    expect(refused.body).toContain('not valid JSON');
    expect(await sessionIds(daemon)).toEqual(before);
  });

  it('answers a body over the limit with 413 and starts nothing', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        { name: 'quick', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false },
      ]),
    });
    const before = await sessionIds(daemon);
    const pad = 'x'.repeat(1_100_000);
    const refused = await launchRaw(daemon, `{"profile":"quick","pad":"${pad}"}`);
    expect(refused.status).toBe(413);
    expect(refused.body).toContain('too large');
    expect(await sessionIds(daemon)).toEqual(before);
  });
});

describe('the launch takes JSON, and audits why it refuses', () => {
  it('accepts application/json with a charset, and refuses jsonp or no type', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        { name: 'quick', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false },
      ]),
    });
    const before = await sessionIds(daemon);

    const withCharset = await launch(daemon, { profile: 'quick' }, {
      'content-type': 'application/json; charset=utf-8',
    });
    expect(withCharset.status).toBe(200);

    const jsonp = await launch(daemon, { profile: 'quick' }, {
      'content-type': 'application/jsonp',
    });
    expect(jsonp.status).toBe(415);

    const headers = launchHeaders(daemon);
    delete headers['content-type'];
    const missing = await raw(
      daemon.port,
      'POST',
      '/dashboard/launch',
      headers,
      JSON.stringify({ profile: 'quick' }),
    );
    expect(missing.status).toBe(415);

    expect(await sessionIds(daemon)).toHaveLength(before.length + 1);
  });

  it('records a missing or foreign Origin apart from a bad fetch site', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        { name: 'quick', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false },
      ]),
    });
    const before = await sessionIds(daemon);

    const noOrigin = launchHeaders(daemon);
    delete noOrigin['origin'];
    const absent = await raw(
      daemon.port,
      'POST',
      '/dashboard/launch',
      noOrigin,
      JSON.stringify({ profile: 'quick' }),
    );
    expect(absent.status).toBe(403);

    const foreign = await launch(
      daemon,
      { profile: 'quick' },
      { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    );
    expect(foreign.status).toBe(403);

    const sameSite = await launch(daemon, { profile: 'quick' }, { 'sec-fetch-site': 'same-site' });
    expect(sameSite.status).toBe(403);

    expect(await sessionIds(daemon)).toEqual(before);
    expect(refusalReasons(daemon.home)).toEqual(['origin', 'origin', 'fetch-site']);
  });
});

describe('concurrent launches respect both caps', () => {
  it('starts exactly eight of twelve simultaneous launches', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        { name: 'quick', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false },
      ]),
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => launch(daemon, { profile: 'quick' })),
    );
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(8);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    expect(await sessionIds(daemon)).toHaveLength(8);
  });

  it('does not spend rate slots on refused launches', async () => {
    const daemon = await startLaunchDaemon({
      launcher: profilesOf([
        { name: 'quick', command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false },
      ]),
    });
    const refused = await Promise.all(
      Array.from({ length: 12 }, () => launch(daemon, { profile: 'nope' })),
    );
    expect(refused.every((result) => result.status === 400)).toBe(true);

    const started = await Promise.all(
      Array.from({ length: 8 }, () => launch(daemon, { profile: 'quick' })),
    );
    expect(started.map((result) => result.status)).toEqual(Array.from({ length: 8 }, () => 200));
  });

  it('starts exactly maxSessions of ten simultaneous launches', async () => {
    const daemon = await startLaunchDaemon({
      policy: { mode: 'allow-all', maxSessions: 2 },
      launcher: profilesOf([
        {
          name: 'quiet',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
        },
      ]),
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => launch(daemon, { profile: 'quiet' })),
    );
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(2);
    expect(statuses.filter((status) => status === 403)).toHaveLength(8);
    expect(await sessionIds(daemon)).toHaveLength(2);
  });
});

describe('the environment names are the ones actually copied', () => {
  it('names only the variables it copied, in the response and the audit', async () => {
    const copied = 'SP_LAUNCH_COPIED';
    const unset = 'SP_LAUNCH_UNSET';
    process.env[copied] = 'value';
    try {
      const daemon = await startLaunchDaemon({
        launcher: profilesOf([
          {
            name: 'envnames',
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            shell: false,
            envFromDaemon: [copied, unset],
          },
        ]),
      });
      const started = await launch(daemon, { profile: 'envnames' });
      expect(started.status).toBe(200);
      expect((JSON.parse(started.body) as Record<string, unknown>)['envFromDaemon']).toEqual([
        copied,
      ]);
      const entry = auditEntries(daemon.home).find(
        (line) => line['actor'] === 'dashboard' && line['action'] === 'start',
      );
      expect((entry?.['meta'] as Record<string, unknown> | undefined)?.['envFromDaemon']).toEqual([
        copied,
      ]);
    } finally {
      delete process.env[copied];
    }
  });
});
