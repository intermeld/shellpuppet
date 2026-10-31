/**
 * Viewer window launching. A unit test must not put browser windows
 * on the machine running it, so the spawn itself is not exercised here and
 * these pin the decisions AROUND the spawn: what counts as a browser, and the
 * launcher's inert default, which keeps an in-process test daemon from
 * opening anything unless it opts in.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  defaultBrowserCommand,
  findBrowser,
  launchDashboard,
  launchViewer,
  resetBrowserCache,
} from '../../src/daemon/viewerLauncher.js';
import type { DefaultBrowserCommand } from '../../src/daemon/viewerLauncher.js';
import { NULL_LOGGER } from '../../src/core/types.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-launcher-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('findBrowser', () => {
  it('accepts an explicit browser path that exists', async () => {
    const fake = path.join(tempDir, 'my-browser.exe');
    fs.writeFileSync(fake, '');
    expect(await findBrowser(fake)).toBe(fake);
  });

  it('returns null for an explicit path that does not exist, rather than falling back', async () => {
    // An operator who named a binary meant that binary. Silently detecting a
    // different browser would launch something they did not choose, into a
    // profile they did not choose, and look like the override had worked.
    expect(await findBrowser(path.join(tempDir, 'not-here.exe'))).toBeNull();
  });

  it('resolves to null or a path that really exists, never a guess', { timeout: 30_000 }, async () => {
    // A check which cannot fail is worse than no check, and a conditional
    // assertion (`if (found !== null) expect(...)`) would execute nothing on a
    // headless CI runner, the machine where detection matters MOST. The
    // assertion below always runs, and fails if detection ever returns a path
    // that is not there.
    // 30 s timeout, not the 5 s default: chrome-launcher's macOS detection
    // took 5.7 s and 9.7 s on macOS CI runners.
    const found = await findBrowser();
    expect(found === null || fs.existsSync(found)).toBe(true);
  });

  it('memoises detection so only the first caller pays for it', { timeout: 30_000 }, async () => {
    // The cache exists because detection costs seconds on macOS; this proves it
    // is actually a cache and not a comment. The second call must not repeat
    // the work, and must give the same answer.
    resetBrowserCache();
    const firstStart = process.hrtime.bigint();
    const first = await findBrowser();
    const firstMs = Number(process.hrtime.bigint() - firstStart) / 1e6;

    const secondStart = process.hrtime.bigint();
    const second = await findBrowser();
    const secondMs = Number(process.hrtime.bigint() - secondStart) / 1e6;

    expect(second).toBe(first);
    // Generous, because a fast machine can detect in single-digit ms and then
    // this asserts nothing useful. The point is that the second call cannot
    // be doing an LSRegister query.
    expect(secondMs).toBeLessThan(Math.max(firstMs, 50));
  });

  it('offers real absolute candidate paths on this platform', async () => {
    // The deterministic half, which does not depend on what is installed:
    // whatever the supplementary list contains, every entry must be an
    // absolute path. A bare name would resolve against PATH, and PATH is
    // attacker-influenced on a shared machine. This is the check that would
    // catch someone "simplifying" a path to a command name.
    const { extraBrowserCandidates } = await import('../../src/daemon/viewerLauncher.js');
    const candidates = extraBrowserCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(path.isAbsolute(candidate)).toBe(true);
    }
  });
});

describe('launchViewer', () => {
  it('does nothing when no launch mode is configured', async () => {
    // The launcher's own default is inert, so an in-process test daemon
    // cannot open a window by forgetting to opt out. The product default
    // (isolated-app) comes from the entry point, and test homes opt out in
    // config.
    const result = await launchViewer('http://127.0.0.1:1/view/s1', tempDir, {}, NULL_LOGGER);
    expect(result.launched).toBe(false);
    expect(result.mode).toBe('none');
    expect(result.reason).toContain('none');
  });

  it('does nothing when explicitly set to none', async () => {
    const result = await launchViewer(
      'http://127.0.0.1:1/view/s1',
      tempDir,
      { launchMode: 'none' },
      NULL_LOGGER,
    );
    expect(result.launched).toBe(false);
  });

  // The daemon tells the caller the human needs no link when a window opened,
  // so "opened" has to be the truth. Node stands in for a browser or an opener
  // here, so nothing real opens on the machine running the suite. The opener's
  // settle time is lengthened: a loaded runner can take longer than the product
  // default to start Node, and the test is about the exit code, not the clock.
  const url = 'http://127.0.0.1:1/view?s=s1&vt=0123abcd';
  const exitWith =
    (code: number) =>
    (): DefaultBrowserCommand => ({
      command: process.execPath,
      args: ['-e', `process.exit(${String(code)})`],
      windowsVerbatimArguments: false,
    });

  it('reports nothing opened when neither the named browser nor the opener can be executed', async () => {
    // `spawn` reports ENOENT, EACCES and a directory asynchronously, after it
    // has returned, so a launcher that trusted the call returning would say a
    // window opened and the daemon would hand the caller no link. A directory
    // stands in for a broken path, and the injected opener fails the same way.
    const directory = path.join(tempDir, 'not-a-browser');
    fs.mkdirSync(directory, { recursive: true });
    const result = await launchViewer(
      url,
      tempDir,
      { launchMode: 'isolated-app', browserPath: directory },
      NULL_LOGGER,
      { opener: () => ({ command: directory, args: [], windowsVerbatimArguments: false }) },
    );
    expect(result.launched).toBe(false);
    expect(result.mode).toBe('isolated-app');
    expect(result.reason).toMatch(/ENOENT|EACCES|EISDIR|EINVAL|EPERM|UNKNOWN|spawn/);
  });

  it('counts a directly spawned browser as opened once its process started', async () => {
    // Node exits at once over the unknown --app= option, as a Chromium that
    // handed its URL to a running instance of the profile exits at once with
    // 0. A direct spawn's exit is not judged; its start is.
    const result = await launchViewer(
      url,
      tempDir,
      { launchMode: 'isolated-app', browserPath: process.execPath },
      NULL_LOGGER,
    );
    expect(result.launched).toBe(true);
    expect(result.browser).toBe(process.execPath);
  });

  it('believes the system opener when it exits with failure', async () => {
    const result = await launchViewer(
      url,
      tempDir,
      { launchMode: 'default-browser' },
      NULL_LOGGER,
      { opener: exitWith(3), openerSettleMs: 20_000 },
    );
    expect(result.launched).toBe(false);
    expect(result.reason).toContain('exited with code 3');
  });

  it('counts the viewer as opened when the system opener exits with success', async () => {
    const result = await launchViewer(
      url,
      tempDir,
      { launchMode: 'default-browser' },
      NULL_LOGGER,
      { opener: exitWith(0), openerSettleMs: 20_000 },
    );
    expect(result).toEqual({ launched: true, mode: 'default-browser' });
  });

  it('carries the fallback reason beside a window the default browser opened', async () => {
    const result = await launchViewer(
      url,
      tempDir,
      { launchMode: 'isolated-app', browserPath: path.join(tempDir, 'absent.exe') },
      NULL_LOGGER,
      { opener: exitWith(0), openerSettleMs: 20_000 },
    );
    expect(result.launched).toBe(true);
    expect(result.reason).toBe('fell back: no Chromium-family browser found');
  });

  it('keeps the fallback reason when the opener fails too', async () => {
    const result = await launchViewer(
      url,
      tempDir,
      { launchMode: 'isolated-app', browserPath: path.join(tempDir, 'absent.exe') },
      NULL_LOGGER,
      { opener: exitWith(4), openerSettleMs: 20_000 },
    );
    expect(result.launched).toBe(false);
    expect(result.reason).toBe(
      `${path.basename(process.execPath)} exited with code 4; fell back: no Chromium-family browser found`,
    );
  });
});

describe('launchDashboard', () => {
  const dashboardUrl = 'http://127.0.0.1:1/dashboard?dt=0123abcd';

  it('opens the isolated window even when the viewer is set to the default browser', async () => {
    // `shellpuppet dashboard` exists to open a window. A launch mode meant for
    // automatic viewer windows must not turn it into a hand-off to the
    // person's browser, whose extensions would then hold the grant.
    let openerCalls = 0;
    const result = await launchDashboard(
      dashboardUrl,
      tempDir,
      { launchMode: 'default-browser', browserPath: process.execPath },
      NULL_LOGGER,
      {
        opener: () => {
          openerCalls += 1;
          return { command: process.execPath, args: ['-e', 'process.exit(0)'], windowsVerbatimArguments: false };
        },
      },
    );
    expect(result).toEqual({ launched: true, mode: 'isolated-app', browser: process.execPath });
    expect(openerCalls).toBe(0);
  });

  it('reports no window and never falls back when no browser is found', async () => {
    // The viewer degrades to the system's opener here; the dashboard must not,
    // because the opener is the person's default browser. The recording
    // opener proves the failure path did not reach it.
    let openerCalls = 0;
    const result = await launchDashboard(
      dashboardUrl,
      tempDir,
      { launchMode: 'isolated-app', browserPath: path.join(tempDir, 'absent.exe') },
      NULL_LOGGER,
      {
        opener: () => {
          openerCalls += 1;
          return { command: process.execPath, args: ['-e', 'process.exit(0)'], windowsVerbatimArguments: false };
        },
      },
    );
    expect(result.launched).toBe(false);
    expect(result.mode).toBe('isolated-app');
    expect(result.reason).toBe('no Chromium-family browser found');
    expect(openerCalls).toBe(0);
  });

  it('reports no window when the isolated profile cannot be created', async () => {
    // A file where the profile directory should be is a profile the launcher
    // cannot make. The dashboard fails rather than finding another profile.
    const notADirectory = path.join(tempDir, 'profile-is-a-file');
    fs.writeFileSync(notADirectory, '');
    const result = await launchDashboard(
      dashboardUrl,
      tempDir,
      { browserPath: process.execPath, profileDir: notADirectory },
      NULL_LOGGER,
    );
    expect(result.launched).toBe(false);
    expect(result.mode).toBe('isolated-app');
    expect(result.reason).toBe('profile directory unavailable');
  });
});

describe('defaultBrowserCommand', () => {
  const viewerUrl = 'http://127.0.0.1:1/view?s=s1&vt=0123abcd';

  it('hands the URL to macOS and Linux as a single argument', () => {
    expect(defaultBrowserCommand(viewerUrl, 'darwin')).toEqual({
      command: '/usr/bin/open',
      args: [viewerUrl],
      windowsVerbatimArguments: false,
    });
    expect(defaultBrowserCommand(viewerUrl, 'linux')).toEqual({
      command: '/usr/bin/xdg-open',
      args: [viewerUrl],
      windowsVerbatimArguments: false,
    });
  });

  it('refuses on Windows a URL holding a character cmd acts on inside quotes', () => {
    for (const url of [
      `${viewerUrl}%PATH%`,
      `${viewerUrl}!PATH!`,
      `${viewerUrl}"`,
      `${viewerUrl}\r\nexit`,
    ]) {
      expect(() => defaultBrowserCommand(url, 'win32', 'cmd.exe')).toThrow(/cmd would act on/);
    }
  });

  /**
   * Run the command `defaultBrowserCommand` builds for `url` through the real
   * cmd, with `echo` in place of `start`: cmd parses the line the same way
   * before either builtin runs, and echo prints what start would have been
   * handed instead of opening a browser. A `vt.cmd` planted in the working
   * directory records a run, which is what an `&` splitting the URL would
   * cause: cmd would take `vt=<grant>` as a command of its own. On a user's
   * machine cmd looks for commands in the working directory first, so this
   * does too.
   */
  function echoThroughCmd(url: string): { stdout: string; plantedRan: boolean } {
    const dir = fs.mkdtempSync(path.join(tempDir, 'cmd-'));
    const marker = path.join(dir, 'vt-ran.txt');
    fs.writeFileSync(path.join(dir, 'vt.cmd'), `@echo %* > "${marker}"\r\n`);
    const env = { ...process.env };
    delete env['NoDefaultCurrentDirectoryInExePath'];

    const { command, args, windowsVerbatimArguments } = defaultBrowserCommand(url);
    const at = args.indexOf('start');
    expect(at).toBeGreaterThanOrEqual(0);
    const echoed = [...args.slice(0, at), 'echo', ...args.slice(at + 1)];
    const run = spawnSync(command, echoed, { cwd: dir, env, encoding: 'utf8', windowsVerbatimArguments });
    return { stdout: run.stdout, plantedRan: fs.existsSync(marker) };
  }

  // Each run below spawns a real cmd, and a Windows machine under load takes
  // several hundred milliseconds per spawn, so these two carry their own
  // budget rather than the unit project's five seconds.
  const CMD_BUDGET_MS = 30_000;

  it.runIf(process.platform === 'win32')(
    'passes the whole viewer URL through cmd on Windows, and runs nothing named after its query',
    () => {
      const { stdout, plantedRan } = echoThroughCmd(viewerUrl);
      expect(stdout).toContain(viewerUrl);
      expect(plantedRan).toBe(false);
    },
    CMD_BUDGET_MS,
  );

  it.runIf(process.platform === 'win32')(
    'keeps every character cmd treats specially outside quotes inside the URL',
    () => {
      for (const special of ['&', '&&', '|', '<', '>', '^', '(', ')', ',', ';', '=', ' ']) {
        const url = `http://127.0.0.1:1/view?s=s1&x=a${special}b&vt=0123abcd`;
        const { stdout, plantedRan } = echoThroughCmd(url);
        expect(stdout, special).toContain(url);
        expect(plantedRan, special).toBe(false);
      }
    },
    CMD_BUDGET_MS,
  );
});
