/**
 * Opening the viewer in its own browser window.
 *
 * Two problems with handing the URL to the default browser
 * (`launchMode: "default-browser"`), which opens it in the user's normal
 * profile:
 *
 * 1. The viewer then shares a browsing context with every other page that
 *    profile has open: cookie jar, storage and history. Loopback is not a boundary
 *    against the browser itself. The daemon's Host/Origin checks and bearer
 *    auth (§4.2) are what holds this; a separate profile removes the exposure
 *    rather than defending it.
 * 2. The viewer grant is in the URL, so it lands in that profile's history.
 *
 * **Why no bundled browser.** The viewer IS a web page: a browser is already a
 * hard prerequisite for ShellPuppet to be usable at all. Bundling one
 * (Playwright's ~130 MB download, or Electron) adds a very large dependency to
 * solve a problem every user already has a browser for. Playwright is the
 * wrong shape besides, being built to DRIVE a page while here a human does.
 * So: detect an installed Chromium-family browser, and degrade gracefully when
 * there is none. `chrome-launcher` (Apache-2.0, ~140 KB) does the fiddly
 * cross-platform detection, which is exactly the part that would otherwise
 * be machine-specific guesswork: the install folders on Windows,
 * LaunchServices on macOS, `.desktop` files and PATH on Linux. On macOS and
 * Linux the part of that search which shells out runs in a child process,
 * never in the daemon (`detectBrowser`); on Windows the paths checked by
 * file access are the whole search, so the child is not run. A lookup that
 * times out, crashes or returns something other than a JSON list is logged
 * once. We spawn the browser ourselves, because the detachment discipline
 * below is not negotiable.
 *
 * Nothing here may ever fail a session start. A browser that will not launch is
 * an inconvenience: the launcher reports that nothing opened, the daemon hands
 * the caller the URL instead, and the human can open it themselves. That report
 * has to be truthful, because the caller is told the human needs no link when a
 * window opened: a spawn settles on the child's `spawn` or `error` event, and
 * the system's opener (`start`, `open`, `xdg-open`) on its exit code.
 */

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NULL_LOGGER, type Logger } from '../core/types.js';

export type ViewerLaunchMode = 'isolated-app' | 'default-browser' | 'none';

export interface ViewerLaunchConfig {
  launchMode?: ViewerLaunchMode;
  /** Explicit browser binary, overriding detection entirely. */
  browserPath?: string;
  /** Where the isolated profile lives. Defaults to <home>/viewer-profile. */
  profileDir?: string;
}

export interface ViewerLaunchResult {
  launched: boolean;
  mode: ViewerLaunchMode;
  /** The browser used, when one was detected. */
  browser?: string;
  /**
   * Why nothing opened, when nothing did; or, beside `launched: true`, why the
   * default browser was used instead of the isolated window.
   */
  reason?: string;
}

/**
 * Chromium-family browsers that `chrome-launcher` does NOT look for, checked
 * after it. Edge earns its place: it ships with Windows, so including it means
 * a Windows machine effectively always has a usable browser even with no
 * Chrome installed. Paths only, never a bare name, because a bare name would
 * resolve against PATH and PATH is attacker-influenced on a shared machine.
 */
export function extraBrowserCandidates(): string[] {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES(X86)'], env['PROGRAMFILES'], env['LOCALAPPDATA']].filter(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    const relative = [
      path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join('Vivaldi', 'Application', 'vivaldi.exe'),
    ];
    return roots.flatMap((root) => relative.map((rel) => path.join(root, rel)));
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    ];
  }
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/usr/bin/vivaldi',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

/**
 * The Chrome installations `chrome-launcher` checks by file access alone,
 * before any lookup that shells out, in the order it ranks them: the
 * `CHROME_PATH` and `LIGHTHOUSE_CHROMIUM_PATH` overrides first everywhere; on
 * Windows its whole search, which is these paths and nothing else; on macOS
 * the two `/Applications` bundles its own `getFirstInstallation()` checks
 * before its LaunchServices query, which rank above anything that query
 * finds. Linux has only the overrides here: its lookup reads `.desktop` files
 * and PATH, which a fixed list cannot match.
 */
export function wellKnownChromePaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const overrides = [env['CHROME_PATH'], env['LIGHTHOUSE_CHROMIUM_PATH']].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  if (platform === 'win32') {
    const roots = [env['LOCALAPPDATA'], env['PROGRAMFILES'], env['PROGRAMFILES(X86)']].filter(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    const relative = [
      path.join('Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return [...overrides, ...roots.flatMap((root) => relative.map((rel) => path.join(root, rel)))];
  }
  if (platform === 'darwin') {
    return [
      ...overrides,
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return overrides;
}

/** Where browser detection looks, in the order it looks. */
export interface BrowserDetection {
  /** Checked first, by file access alone. */
  wellKnown: string[];
  /**
   * A module exporting chrome-launcher's `Launcher`, as a file URL. A child
   * process imports it and runs `Launcher.getInstallations()`. Empty skips
   * the lookup.
   */
  lookupModule: string;
  /** How long the child process may take before it is ended and counts as finding nothing. */
  lookupTimeoutMs: number;
  /** Checked last, by file access alone. */
  extra: string[];
}

/**
 * How long chrome-launcher's full lookup may take. Its macOS query took 5.7 s
 * and 9.7 s on macOS CI runners, so this leaves room for a slower machine.
 */
export const BROWSER_LOOKUP_TIMEOUT_MS = 30_000;

const nodeRequire = createRequire(import.meta.url);

/** The detection the daemon runs: chrome-launcher's, then the supplementary list. */
export function defaultBrowserDetection(): BrowserDetection {
  let lookupModule = '';
  // On Windows, `wellKnownChromePaths` is chrome-launcher's entire search,
  // so a child lookup cannot find a browser that list missed. macOS and
  // Linux search beyond a fixed list, and that lookup runs in a child.
  if (process.platform !== 'win32') {
    try {
      lookupModule = pathToFileURL(nodeRequire.resolve('chrome-launcher')).href;
    } catch {
      // Not installed: the well-known and supplementary paths still apply.
    }
  }
  return {
    wellKnown: wellKnownChromePaths(),
    lookupModule,
    lookupTimeoutMs: BROWSER_LOOKUP_TIMEOUT_MS,
    extra: extraBrowserCandidates(),
  };
}

/**
 * Find a Chromium-family browser, or null. Detection can never stop the
 * daemon from serving: nothing here throws, and no part of it holds the
 * daemon's event loop (see `detectBrowser`).
 */
export async function findBrowser(
  explicitPath?: string,
  logger: Logger = NULL_LOGGER,
): Promise<string | null> {
  if (explicitPath !== undefined && explicitPath !== '') {
    // Never cached: an operator who names a binary means that binary, and the
    // answer is a single file check anyway.
    return (await exists(explicitPath)) ? explicitPath : null;
  }
  // Detection is memoised for the daemon's lifetime because it is NOT cheap:
  // chrome-launcher's macOS lookup (a LaunchServices query) took 5.7 s and
  // 9.7 s on macOS CI runners. A session start waits for the launch, so the
  // daemon looks once as it starts (server.ts) and every start after that
  // finds the answer ready; it changes only when someone installs a browser.
  // A daemon restart re-detects.
  // The promise is memoised, not the value, so a caller that arrives while
  // detection is still running waits for the rest of it instead of starting
  // a second detection of its own.
  cachedDetection ??= detectBrowser(defaultBrowserDetection(), logger);
  return cachedDetection;
}

/** Memoised detection; `undefined` means "not looked yet". */
let cachedDetection: Promise<string | null> | undefined;

/** Test hook: forget the memoised browser so detection runs again. */
export function resetBrowserCache(): void {
  cachedDetection = undefined;
}

/**
 * Detect a browser without holding the daemon's event loop. chrome-launcher's
 * lookup is synchronous and shells out on macOS (`lsregister -dump`, seconds)
 * and Linux (`grep` over `.desktop` files, `which`). Run in the daemon, it
 * would stop `/health` and every other request being answered while it ran,
 * on macOS for long enough that a client gives up on a daemon it has just
 * started. So the paths chrome-launcher itself checks first are tried with
 * asynchronous file checks; only when none exists does its full lookup run,
 * in a child process; and the supplementary list is checked last. On Windows
 * the default detection leaves that lookup empty, because the well-known
 * paths are the whole search. The answer is the one chrome-launcher's own
 * ranking gives, then the first supplementary browser present. A lookup that
 * times out, crashes or prints something other than a JSON list is logged
 * once, through `logger`.
 */
export async function detectBrowser(
  detection: BrowserDetection = defaultBrowserDetection(),
  logger: Logger = NULL_LOGGER,
): Promise<string | null> {
  const known = await firstExisting(detection.wellKnown);
  if (known !== null) return known;
  if (detection.lookupModule !== '') {
    const found = await lookUpInChild(detection.lookupModule, detection.lookupTimeoutMs, logger);
    if (found !== null) return found;
  }
  return firstExisting(detection.extra);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * What the child process runs: import the module named by its one argument,
 * an absolute file URL, so nothing depends on the child's working directory,
 * and print what `getInstallations()` returns as JSON. A lookup that throws
 * (chrome-launcher's does on Linux when it finds nothing) prints an empty list.
 */
const LOOKUP_SCRIPT = [
  'let found = [];',
  'try {',
  '  const { Launcher } = await import(process.argv[1]);',
  '  found = Launcher.getInstallations();',
  '} catch {',
  '  found = [];',
  '}',
  'process.stdout.write(JSON.stringify(found));',
].join('\n');

function lookUpInChild(
  moduleUrl: string,
  timeoutMs: number,
  logger: Logger,
): Promise<string | null> {
  const fail = (reason: string, resolve: (value: string | null) => void): void => {
    logger.warn('browser lookup failed', { reason });
    resolve(null);
  };
  return new Promise((resolve) => {
    try {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', LOOKUP_SCRIPT, moduleUrl],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            fail(error.message, resolve);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(stdout);
            if (!Array.isArray(parsed)) {
              fail('unreadable output', resolve);
              return;
            }
            const first: unknown = parsed[0];
            // An empty list is a lookup that found nothing, not a failure.
            resolve(typeof first === 'string' && first !== '' ? first : null);
          } catch {
            fail('unreadable output', resolve);
          }
        },
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : 'lookup failed', resolve);
    }
  });
}

/**
 * Open `url` in a chromeless window backed by its own browser profile.
 *
 * `--app=` removes the address bar, tabs and navigation. A terminal viewer has
 * no use for them, and the address bar is where the viewer grant would
 * otherwise be on display. `--user-data-dir` is the isolation: its own cookie
 * jar, storage and history, invisible to the user's normal browsing and vice
 * versa.
 *
 * The profile directory is per-daemon rather than per-session, so window
 * position and the text-size preference persist across sessions. A per-session
 * profile would isolate marginally harder at the cost of a cold browser start
 * every time, which is the wrong trade for a window a human is meant to keep
 * open and glance at.
 */
export function isolatedWindowArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--new-window',
    // First-run flows would hijack the window with a sign-in wizard; the
    // default-browser prompt would ask to change a setting the user never
    // asked to change from a window they did not open.
    '--no-first-run',
    '--no-default-browser-check',
    ...QUIET_BROWSER_SWITCHES,
  ];
}

/**
 * Switches that ask a Chromium-family browser ShellPuppet starts, the viewer
 * window and the screenshot browser alike, to make no network requests of its
 * own: updates, reports and the services a browser contacts in the
 * background. Nothing leaves the machine unless a human sends it or switches
 * it on, and nobody asked these browsers to call anywhere. Each switch is
 * documented in Chromium's source, named beside it; none changes what a page
 * can do, so the viewer and its WebSocket to the daemon work as they would
 * without them.
 *
 * They ask, and they do not reach everything. A NetLog of a fresh Chrome
 * started with them, over its first minute, still showed its component
 * updater, a Safe Browsing key fetch, an account check and a search endpoint
 * contacted, none of which these switches turn off; a vendor's own services,
 * such as Edge's, may be beyond Chromium's switches too.
 */
export const QUIET_BROWSER_SWITCHES: readonly string[] = [
  // chrome/common/chrome_switches.h: "Disable several subsystems which run
  // network requests in the background."
  '--disable-background-networking',
  // chrome/common/chrome_switches.h: no updates for the components listed at
  // chrome://components.
  '--disable-component-update',
  // chrome/common/chrome_switches.h: "Disable default component extensions
  // with background pages."
  '--disable-component-extensions-with-background-pages',
  // chrome/common/chrome_switches.h: "Disables installation of default apps
  // on first run."
  '--disable-default-apps',
  // chrome/common/chrome_switches.h: "Disables Domain Reliability Monitoring."
  '--disable-domain-reliability',
  // components/sync/base/command_line_switches.h: "Disables syncing browser
  // data to a Google Account."
  '--disable-sync',
  // components/metrics/metrics_switches.h: "Enables the recording of metrics
  // reports but disables reporting."
  '--metrics-recording-only',
  // base/base_switches.h: "Disables the crash reporting."
  '--disable-breakpad',
  // components/variations/variations_switches.cc: "Disable fetching of
  // variations seed from the server."
  '--disable-variations-seed-fetch',
  // chrome/common/chrome_switches.h: "Don't use a proxy server, always make
  // direct connections." With the system's proxy detection on, a browser
  // looks for a `wpad` host on the local network. Both pages talk to
  // 127.0.0.1 alone, which Chromium never sends through a proxy.
  '--no-proxy-server',
  // base/base_switches.h: "Comma-separated list of feature names to disable."
  // One switch for every name, because Chromium keeps only the last. The
  // names are features in Chromium's source:
  // components/optimization_guide/core/optimization_guide_features.cc, the
  // Optimization Hints component's syncing and the prediction models a
  // browser downloads; components/network_time/network_time_tracker.cc, the
  // network time queries. A name a later Chromium no longer knows is ignored,
  // and that feature keeps its default.
  '--disable-features=OptimizationHints,OptimizationTargetPrediction,NetworkTimeServiceQuerying',
];

/**
 * What a test may inject in place of the platform's opener command, so the
 * default-browser path can be exercised without opening a browser.
 */
export interface LaunchDependencies {
  opener?: (url: string) => DefaultBrowserCommand;
  /** How long to wait for the opener's exit code; `OPENER_SETTLE_MS` by default. */
  openerSettleMs?: number;
}

export async function launchViewer(
  url: string,
  home: string,
  config: ViewerLaunchConfig,
  logger: Logger,
  deps: LaunchDependencies = {},
): Promise<ViewerLaunchResult> {
  const mode = config.launchMode ?? 'none';
  if (mode === 'none') return { launched: false, mode, reason: 'viewer.launchMode is "none"' };

  if (mode === 'isolated-app') {
    const browser = await findBrowser(config.browserPath, logger);
    if (browser === null) {
      // Degrade rather than fail: the system's opener is tried, and when
      // nothing opens the daemon hands the caller the URL.
      logger.warn('no Chromium-family browser found for the isolated viewer window', {
        hint: 'set viewer.browserPath, or viewer.launchMode to "default-browser"',
      });
      return openInDefaultBrowser(
        url,
        logger,
        'isolated-app',
        deps,
        'no Chromium-family browser found',
      );
    }
    const profileDir = config.profileDir ?? path.join(home, 'viewer-profile');
    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch (error) {
      logger.warn('could not create the viewer profile directory', {
        profileDir,
        error: String(error),
      });
      return openInDefaultBrowser(
        url,
        logger,
        'isolated-app',
        deps,
        'profile directory unavailable',
      );
    }

    // The browser is spawned directly, so "opened" means its process started.
    // Its exit is not judged: a Chromium launched beside a running instance of
    // the same profile hands the URL over and exits at once, with code 0, and
    // the window is in the other process.
    const outcome = await spawnDetached(browser, isolatedWindowArgs(url, profileDir));
    if (outcome.spawned) {
      logger.info('viewer window opened', { browser, profileDir });
      return { launched: true, mode, browser };
    }
    const error = outcome.error ?? 'the browser did not start';
    logger.warn('the viewer browser failed to launch', { browser, error });
    return openInDefaultBrowser(url, logger, 'isolated-app', deps, error);
  }

  return openInDefaultBrowser(url, logger, 'default-browser', deps);
}

/** How to hand a URL to the platform's default browser. */
export interface DefaultBrowserCommand {
  command: string;
  args: string[];
  /** Windows only: pass `args` to the command line exactly as written. */
  windowsVerbatimArguments: boolean;
}

/**
 * The command that opens `url` in the default browser.
 *
 * On Windows that is cmd's `start` builtin, so the URL passes through cmd's
 * command-line parser, where an unquoted `&` ends a command. The viewer URL
 * holds one (`?s=<id>&vt=<grant>`), and Node quotes an argument only when it
 * holds a space, so the URL goes over verbatim inside double quotes. Within
 * quotes cmd still expands `%NAME%`, and `!NAME!` where delayed expansion is
 * switched on in the registry; a `"` ends the quoting and a line break ends
 * the command. A URL holding any of those is refused rather than handed over.
 * The empty `""` is `start`'s window title, without which it would take the
 * quoted URL as the title. `/d` skips cmd's AutoRun commands.
 */
export function defaultBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env['COMSPEC'],
): DefaultBrowserCommand {
  if (platform === 'win32') {
    if (/["%!\r\n]/.test(url)) {
      throw new Error(
        'the URL holds a quote, a percent sign, an exclamation mark or a line break, which cmd would act on',
      );
    }
    return {
      command: comspec ?? 'cmd.exe',
      args: ['/d', '/c', 'start', '""', `"${url}"`],
      windowsVerbatimArguments: true,
    };
  }
  const command = platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open';
  return { command, args: [url], windowsVerbatimArguments: false };
}

/**
 * How long to wait for the system's opener to say whether it managed. `start`,
 * `open` and `xdg-open` return within a fraction of a second, with a non-zero
 * code when they could hand the URL to nothing (no display, no registered
 * browser). An opener still running after this is taken to have become the
 * browser itself, which `xdg-open` does on some desktops.
 */
export const OPENER_SETTLE_MS = 1500;

async function openInDefaultBrowser(
  url: string,
  logger: Logger,
  mode: ViewerLaunchMode,
  deps: LaunchDependencies,
  fallbackReason?: string,
): Promise<ViewerLaunchResult> {
  const withFallback = (reason: string): string =>
    fallbackReason === undefined ? reason : `${reason}; fell back: ${fallbackReason}`;
  let command: DefaultBrowserCommand;
  try {
    command = (deps.opener ?? defaultBrowserCommand)(url);
  } catch (error) {
    logger.warn('could not open the viewer in any browser', { error: String(error) });
    return { launched: false, mode, reason: withFallback(String(error)) };
  }
  const outcome = await spawnDetached(
    command.command,
    command.args,
    command.windowsVerbatimArguments,
    deps.openerSettleMs ?? OPENER_SETTLE_MS,
  );
  if (!outcome.spawned) {
    const error = outcome.error ?? 'the opener did not start';
    logger.warn('could not open the viewer in any browser', { error });
    return { launched: false, mode, reason: withFallback(error) };
  }
  if (outcome.exitCode !== undefined && outcome.exitCode !== 0) {
    const reason = `${path.basename(command.command)} exited with code ${String(outcome.exitCode ?? 'signal')}`;
    logger.warn('the default browser did not open the viewer', { reason, fallbackReason });
    return { launched: false, mode, reason: withFallback(reason) };
  }
  logger.info('viewer opened in the default browser', { fallbackReason });
  return {
    launched: true,
    mode,
    ...(fallbackReason !== undefined ? { reason: `fell back: ${fallbackReason}` } : {}),
  };
}

/** What became of a detached spawn. */
export interface SpawnOutcome {
  /** The process started. False when it could not be executed at all. */
  spawned: boolean;
  /** Why it could not start. */
  error?: string;
  /**
   * Its exit code, when `settleMs` was given and it ended within that time;
   * `null` means a signal ended it.
   */
  exitCode?: number | null;
}

/**
 * Spawn fully detached with `detached`, `stdio: 'ignore'` and `unref()`, the
 * same discipline the daemon's own auto-start requires (§2.2): a browser that
 * inherited this daemon's stdio, or that the daemon waited on, would tie a
 * long-lived GUI process to the daemon's lifetime and hang its shutdown.
 *
 * The promise settles when Node says whether the process started. `spawn`
 * reports a failure to execute, such as ENOENT, EACCES or a path that is a
 * directory, by emitting 'error' ASYNCHRONOUSLY, so a call that returned
 * without throwing has proved nothing, and a ChildProcess 'error' with no
 * listener is re-thrown by Node as an uncaught exception. With `settleMs`, it
 * also waits that long for the process to exit and reports the code, for an
 * opener whose exit code is its answer. Nothing here throws: the caller's
 * contract is that launching a viewer can never fail a session start.
 */
function spawnDetached(
  command: string,
  args: string[],
  windowsVerbatimArguments = false,
  settleMs = 0,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments,
      });
    } catch (error) {
      settle({ spawned: false, error: String(error) });
      return;
    }
    child.on('error', (error) => settle({ spawned: false, error: String(error) }));
    child.on('spawn', () => {
      if (settleMs <= 0) {
        settle({ spawned: true });
        return;
      }
      const timer = setTimeout(() => settle({ spawned: true }), settleMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        settle({ spawned: true, exitCode: code });
      });
    });
    child.unref();
  });
}
