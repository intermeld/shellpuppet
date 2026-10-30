/**
 * Browser detection runs in the daemon while it serves (design §5), and
 * chrome-launcher's lookup is synchronous: on macOS it shells out to a
 * LaunchServices query that took 5.7 s and 9.7 s on CI runners. These pin
 * that the lookup runs in a child process, so the event loop stays free
 * however long it takes, and that detection still gives the answer
 * chrome-launcher's own ranking gives.
 *
 * A stand-in module plays chrome-launcher (`test/fixtures/browser-lookup.mjs`),
 * so a slow lookup can be produced on any platform. The macOS timing itself is
 * what the macOS CI legs exercise, with the real library.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Launcher } from 'chrome-launcher';
import { detectBrowser, wellKnownChromePaths } from '../../src/daemon/viewerLauncher.js';
import type { BrowserDetection } from '../../src/daemon/viewerLauncher.js';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'browser-lookup.mjs',
);

/** The stand-in module's URL, behaving as `mode` says and reporting `found`. */
function lookup(mode: string, found = ''): string {
  const url = pathToFileURL(fixture);
  url.searchParams.set('mode', mode);
  url.searchParams.set('found', found);
  return url.href;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-detect-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** A file that exists, standing in for an installed browser. */
function installed(name: string): string {
  const file = path.join(tempDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

const missing = path.join(tempDir, 'not-installed', 'browser.exe');

function detection(overrides: Partial<BrowserDetection>): BrowserDetection {
  return { wellKnown: [], lookupModule: '', lookupTimeoutMs: 30_000, extra: [], ...overrides };
}

describe('detectBrowser', () => {
  it(
    'runs a slow lookup without holding the event loop',
    async () => {
      // The stand-in holds its thread for two seconds, as `lsregister -dump`
      // does. Run in this process, it would stop the timer below for those two
      // seconds; in a child process the timer keeps its beat.
      const browser = installed('slow/browser.exe');
      let last = Date.now();
      let longestGap = 0;
      const beat = setInterval(() => {
        const now = Date.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
      }, 10);
      const started = Date.now();
      try {
        const found = await detectBrowser(
          detection({ wellKnown: [missing], lookupModule: lookup('slow', browser) }),
        );
        expect(found).toBe(browser);
      } finally {
        clearInterval(beat);
      }
      // The lookup really ran, and took its two seconds...
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      // ...while the event loop went on turning.
      expect(longestGap).toBeLessThan(500);
    },
    20_000,
  );

  it('takes a well-known path without running the lookup', async () => {
    const browser = installed('known/chrome.exe');
    const found = await detectBrowser(
      detection({
        wellKnown: [missing, browser],
        lookupModule: lookup('found', installed('from-lookup/chrome.exe')),
        extra: [installed('extra/msedge.exe')],
      }),
    );
    expect(found).toBe(browser);
  });

  it('prefers what the lookup reports to the supplementary list', async () => {
    const fromLookup = installed('lookup-wins/chrome.exe');
    const found = await detectBrowser(
      detection({
        wellKnown: [missing],
        lookupModule: lookup('found', fromLookup),
        extra: [installed('lookup-wins/msedge.exe')],
      }),
    );
    expect(found).toBe(fromLookup);
  });

  it('falls back to the supplementary list when the lookup finds nothing, fails or overruns', async () => {
    const edge = installed('fallback/msedge.exe');
    for (const [mode, timeoutMs] of [
      ['empty', 30_000],
      ['throw', 30_000],
      ['hang', 1_000],
    ] as const) {
      const found = await detectBrowser(
        detection({
          wellKnown: [missing],
          lookupModule: lookup(mode, installed('fallback/chrome.exe')),
          lookupTimeoutMs: timeoutMs,
          extra: [missing, edge],
        }),
      );
      expect(found, mode).toBe(edge);
    }
  }, 30_000);

  it('answers null when nothing is installed anywhere', async () => {
    expect(
      await detectBrowser(
        detection({ wellKnown: [missing], lookupModule: lookup('empty'), extra: [missing] }),
      ),
    ).toBeNull();
  });
});

describe('wellKnownChromePaths', () => {
  it('lists the overrides first, then the two macOS bundles chrome-launcher checks before its query', () => {
    expect(
      wellKnownChromePaths('darwin', { CHROME_PATH: '/opt/c', LIGHTHOUSE_CHROMIUM_PATH: '/opt/l' }),
    ).toEqual([
      '/opt/c',
      '/opt/l',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
  });

  it('lists only the overrides on Linux, whose lookup has to run', () => {
    expect(wellKnownChromePaths('linux', { CHROME_PATH: '/opt/c' })).toEqual(['/opt/c']);
    expect(wellKnownChromePaths('linux', {})).toEqual([]);
  });

  describe('on Windows, against chrome-launcher itself', () => {
    const names = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'CHROME_PATH', 'LIGHTHOUSE_CHROMIUM_PATH'];
    // Read as the file is collected, before any test changes them.
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    afterEach(() => {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    /**
     * Lay out a machine: each root gets the installs named, then the env
     * points chrome-launcher and detection at those roots alone.
     */
    function layout(
      label: string,
      installs: Partial<Record<'local' | 'pf' | 'pf86', ('Chrome' | 'Chrome SxS')[]>>,
      chromePath?: string,
    ): void {
      const root = path.join(tempDir, 'win', label);
      const roots = { local: path.join(root, 'local'), pf: path.join(root, 'pf'), pf86: path.join(root, 'pf86') };
      for (const [key, channels] of Object.entries(installs)) {
        for (const channel of channels) {
          installed(path.join('win', label, key, 'Google', channel, 'Application', 'chrome.exe'));
        }
      }
      process.env['LOCALAPPDATA'] = roots.local;
      process.env['PROGRAMFILES'] = roots.pf;
      process.env['PROGRAMFILES(X86)'] = roots.pf86;
      delete process.env['LIGHTHOUSE_CHROMIUM_PATH'];
      if (chromePath === undefined) delete process.env['CHROME_PATH'];
      else process.env['CHROME_PATH'] = chromePath;
    }

    it.runIf(process.platform === 'win32')(
      'gives the first answer chrome-launcher gives, with no lookup at all',
      async () => {
        const machines: [string, Parameters<typeof layout>[1], string?][] = [
          ['x86-only', { pf86: ['Chrome'] }],
          ['canary-and-stable', { local: ['Chrome SxS'], pf: ['Chrome'] }],
          ['stable-everywhere', { local: ['Chrome'], pf: ['Chrome'], pf86: ['Chrome'] }],
          ['override', { pf: ['Chrome'] }, installed('override/my-chrome.exe')],
          ['override-missing', { pf: ['Chrome'] }, missing],
          ['none', {}],
        ];
        for (const [label, installs, chromePath] of machines) {
          layout(label, installs, chromePath);
          const expected = Launcher.getInstallations()[0] ?? null;
          const found = await detectBrowser(
            detection({ wellKnown: wellKnownChromePaths('win32', process.env) }),
          );
          expect(found, label).toBe(expected);
        }
      },
    );
  });
});
