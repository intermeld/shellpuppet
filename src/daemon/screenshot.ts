/**
 * A picture of the viewer, as a browser draws it (design §5).
 *
 * The daemon's text snapshot is what the agent reads; the viewer is what the
 * human sees, and the two can disagree: when the renderer is right and only
 * the page is wrong, no text tool can tell. This module opens the real viewer
 * page in the same Chromium the isolated viewer window uses, headless, drives
 * it over the DevTools protocol and returns the pixels plus the text of each
 * row xterm drew. It uses the WebSocket client the daemon already depends on,
 * and no bundled browser (viewerLauncher.ts says why).
 *
 * The page is opened in capture mode (`capture=1`): chrome hidden, the grid
 * held at the daemon's geometry, never a resize sent and a flag raised once
 * the first snapshot has been drawn, which is what this waits on. A
 * screenshot must not change what the program sees.
 *
 * Daemon-side only; logging through the injected logger.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { NULL_LOGGER } from '../core/types.js';
import type { Logger } from '../core/types.js';
import { QUIET_BROWSER_SWITCHES } from './viewerLauncher.js';

export interface CaptureOptions {
  /** A Chromium-family binary, as `findBrowser()` reports it. */
  browser: string;
  /** The viewer URL, viewer grant included. Capture mode is added here. */
  viewerUrl: string;
  /** Browser window size in CSS pixels; the grid scales its font to fill it. */
  width: number;
  height: number;
  /** Viewport rows the reasoning filter hid; covered before the picture is taken. */
  hiddenRows?: readonly number[];
  /** Budget for the whole capture, browser start to screenshot. */
  timeoutMs?: number;
  /**
   * Open the page as a viewer that may drive the grid, as a human's window
   * does, rather than in capture mode. Readiness is then the probe below,
   * which such a call should always give.
   */
  drive?: boolean;
  /**
   * An expression evaluated in the page, whose value comes back as `probe`.
   * The picture waits for it to be truthy: after the first paint in capture
   * mode, as the whole of readiness when driving.
   */
  probe?: string;
  /** Script installed before navigation, for browser integration probes. */
  beforeNavigateScript?: string;
  /**
   * The folder the capture's own browser profile is made in, created when
   * absent. The daemon passes `captureProfileRoot(home)`, which it sweeps of
   * leftovers; a direct caller that gives none gets the system's temporary
   * folder.
   */
  profileRoot?: string;
  logger?: Logger;
}

/**
 * A capture's browser profile is a fresh folder named with this prefix and
 * the six characters `mkdtemp` adds. A sweep removes only folders with
 * exactly that name, so it never touches anything ShellPuppet did not make.
 */
const PROFILE_PREFIX = 'shellpuppet-capture-';
const PROFILE_NAME = /^shellpuppet-capture-[A-Za-z0-9]{6}$/;

/** Where the daemon makes capture profiles: a folder of its own in its home. */
export function captureProfileRoot(home: string): string {
  return path.join(home, 'capture-profiles');
}

/**
 * When a profile folder that could not be removed as its capture ended is
 * tried again. On Windows a browser's last child processes can hold files in
 * it for a while after the browser itself has exited, longer under load.
 */
export const PROFILE_RETRY_DELAYS_MS = [30_000, 300_000];

/**
 * How old a leftover profile folder must be before a sweep removes it: far
 * longer than a capture can run (`MAX_CAPTURE_TIMEOUT_MS`, plus the wait for
 * the browser to exit), so a capture still running is never swept.
 */
export const STALE_PROFILE_AGE_MS = 10 * 60_000;

/**
 * Remove a capture's profile folder. One that cannot be removed yet is tried
 * again after each of `retryDelaysMs`, on timers that never keep the process
 * alive, and one still there after the last is left for the sweep at the next
 * daemon start. Resolves with whether the first attempt removed it.
 */
export async function removeCaptureProfile(
  profileDir: string,
  logger: Logger,
  retryDelaysMs: readonly number[] = PROFILE_RETRY_DELAYS_MS,
  remove: (dir: string) => Promise<void> = (dir) =>
    fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }),
): Promise<boolean> {
  const attempt = async (left: readonly number[]): Promise<boolean> => {
    try {
      await remove(profileDir);
      return true;
    } catch (error) {
      const [delay, ...rest] = left;
      if (delay === undefined) {
        logger.warn('capture profile not removed; the next daemon start removes it', {
          profileDir,
          error: String(error),
        });
        return false;
      }
      setTimeout(() => void attempt(rest), delay).unref();
      return false;
    }
  };
  return attempt(retryDelaysMs);
}

/**
 * Remove the capture profiles left in `root`: only folders named as a capture
 * names them, and only those untouched for `minAgeMs`. Resolves with how many
 * were removed. Nothing here throws: a folder that cannot be removed now is
 * left for the next sweep.
 */
export async function sweepCaptureProfiles(
  root: string,
  logger: Logger,
  minAgeMs: number = STALE_PROFILE_AGE_MS,
  now: number = Date.now(),
): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return 0; // No captures yet.
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROFILE_NAME.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const { mtimeMs } = await fs.promises.stat(dir);
      if (now - mtimeMs < minAgeMs) continue;
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch (error) {
      logger.warn('leftover capture profile not removed', { profileDir: dir, error: String(error) });
    }
  }
  if (removed > 0) logger.info('removed leftover capture profiles', { root, removed });
  return removed;
}

export interface Capture {
  png: Buffer;
  /** The picture's dimensions, read from the PNG itself. */
  width: number;
  height: number;
  /** What `probe` evaluated to, when one was given. */
  probe?: unknown;
  /**
   * The text of each viewport row as xterm drew it: right-trimmed, trailing
   * blank rows dropped. That is the same shape as the daemon snapshot's lines,
   * so the two can be compared directly.
   */
  rows: string[];
}

/**
 * Budget for a whole capture: starting the browser, connecting to DevTools,
 * loading the page, waiting for its first snapshot and the screenshot
 * itself. Cold starts dominate the figure and vary widely: a capture that
 * worked took 20.8 s on a cold Windows CI runner. So the default is 45 s,
 * about twice that.
 */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 45_000;
/** The range a caller may ask for instead. */
export const MIN_CAPTURE_TIMEOUT_MS = 1_000;
export const MAX_CAPTURE_TIMEOUT_MS = 120_000;
const POLL_MS = 100;

/**
 * The smallest DevTools client this needs: request ids in, results out.
 * Exported for its unit test only.
 */
export class DevTools {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly ws: WebSocket,
    private readonly deadline: number,
  ) {
    ws.on('message', (data: Buffer | string) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return; // an event; none are needed
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error.message ?? 'DevTools error'));
      } else {
        waiter.resolve(message.result);
      }
    });
    ws.on('close', () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error('DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // Every call shares the capture's deadline: a browser that accepts the
      // connection and then never answers, as a wedged renderer does, fails
      // the capture at the deadline rather than holding the agent's tool call
      // open.
      const timer = setTimeout(
        () => {
          if (this.pending.delete(id)) {
            reject(new Error(`DevTools did not answer ${method} in time.`));
          }
        },
        Math.max(0, this.deadline - Date.now()),
      );
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          (resolve as (result: unknown) => void)(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chromium announces its DevTools endpoint by writing `DevToolsActivePort`
 * into the profile directory: the port on line one, the browser target's
 * path on line two. `--remote-debugging-port=0` leaves the port to the OS.
 */
async function waitForDevTools(
  profileDir: string,
  child: ChildProcess,
  deadline: number,
): Promise<string> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The browser exited before it was ready (code ${String(child.exitCode)}).`);
    }
    try {
      const [port, target] = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (port !== undefined && port !== '' && target !== undefined && target.startsWith('/')) {
        return `ws://127.0.0.1:${port}${target}`;
      }
    } catch {
      // Not written yet.
    }
    await sleep(POLL_MS);
  }
  throw new Error('The browser did not expose DevTools in time.');
}

function connect(endpoint: string, deadline: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, { perMessageDeflate: false });
    const timer = setTimeout(
      () => {
        ws.terminate();
        reject(new Error('DevTools did not accept the connection in time.'));
      },
      Math.max(0, deadline - Date.now()),
    );
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Rows as the daemon snapshot shapes them: right-trimmed, blank tail dropped. */
function normaliseRows(value: unknown): string[] {
  const rows = Array.isArray(value)
    ? value.map((row) =>
        String(row).split(String.fromCharCode(0xa0)).join(' ').replace(/\s+$/, ''),
      )
    : [];
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/**
 * How the capture browser is started: headless, DevTools on a port the OS
 * picks, its own profile, and the switches that keep the browser's own
 * background requests off (`QUIET_BROWSER_SWITCHES`).
 */
export function captureBrowserArgs(profileDir: string, width: number, height: number): string[] {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${String(width)},${String(height)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    ...QUIET_BROWSER_SWITCHES,
    'about:blank',
  ];
}

/**
 * Open the viewer page headless, wait for its first snapshot to be drawn,
 * and return the pixels and the rows. Throws when the browser will not start,
 * DevTools will not answer or the page does not paint within the budget.
 */
export async function captureViewer(options: CaptureOptions): Promise<Capture> {
  const logger = options.logger ?? NULL_LOGGER;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
  const profileRoot = options.profileRoot ?? os.tmpdir();
  fs.mkdirSync(profileRoot, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(profileRoot, PROFILE_PREFIX));
  const child = spawn(
    options.browser,
    captureBrowserArgs(profileDir, options.width, options.height),
    { stdio: 'ignore', windowsHide: true },
  );
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });

  let ws: WebSocket | null = null;
  try {
    const endpoint = await waitForDevTools(profileDir, child, deadline);
    ws = await connect(endpoint, deadline);
    const cdp = new DevTools(ws, deadline);

    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    if (options.beforeNavigateScript !== undefined) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',
        { source: options.beforeNavigateScript }, sessionId);
    }
    // The window size is an OUTER size, and Chromium enforces a minimum of
    // its own, so a window size alone gives a picture smaller than asked for
    // or, below the minimum, a different shape altogether (200×200 asked,
    // 504×104 drawn). The viewport is set directly instead, at one CSS pixel
    // per device pixel.
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    const url =
      options.drive === true
        ? options.viewerUrl
        : `${options.viewerUrl}${options.viewerUrl.includes('?') ? '&' : '?'}capture=1${options.hiddenRows === undefined ? '' : '&redact=1'}`;
    await cdp.send('Page.navigate', { url }, sessionId);

    const evaluate = async (expression: string): Promise<unknown> => {
      const evaluated = await cdp.send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        sessionId,
      );
      return evaluated.result.value;
    };

    // The page raises the flag once the daemon's snapshot has been parsed and
    // drawn. That, not the load event, is the picture being ready. A driving
    // page never raises it (the flag exists for pictures), so there the probe
    // is what says the page has settled.
    let probed: unknown;
    for (;;) {
      const painted =
        options.drive === true ||
        (await evaluate('window.__shellpuppetPainted === true')) === true;
      probed = options.probe === undefined ? undefined : await evaluate(options.probe);
      if (painted && (options.probe === undefined || Boolean(probed))) break;
      if (Date.now() >= deadline) throw new Error('The viewer did not paint in time.');
      await sleep(POLL_MS);
    }

    const rows = await cdp.send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      {
        expression:
          "Array.from(document.querySelectorAll('.xterm-rows > div')).map((row) => row.textContent || '')",
        returnByValue: true,
      },
      sessionId,
    );
    if (options.hiddenRows !== undefined && options.hiddenRows.length > 0) {
      await evaluate(`window.__shellpuppetCoverRows(${JSON.stringify(options.hiddenRows)})`);
    }
    const shot = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId,
    );
    await cdp.send('Browser.close').catch(() => undefined);
    const png = Buffer.from(shot.data, 'base64');
    return {
      png,
      // IHDR is always the first chunk: width and height at bytes 16 and 20.
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      rows: normaliseRows(rows.result.value),
      ...(probed === undefined ? {} : { probe: probed }),
    };
  } finally {
    ws?.close();
    if (child.exitCode === null) child.kill();
    // The profile can be removed once the browser has let go of it; one it
    // still holds is tried again later (removeCaptureProfile).
    await Promise.race([exited, sleep(3_000)]);
    await removeCaptureProfile(profileDir, logger);
  }
}
