/** The any-folder controls in a headless dashboard document. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let daemon: TestDaemon;
let url = '';
let rootPath = '';
const chosen = 'C:\\picked\\folder';

beforeAll(async () => {
  browser = await findBrowser();
  if (!browser) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-any-page-'));
  fs.mkdirSync(path.join(root, 'child'));
  rootPath = path.join(root, 'child');
  const { config, problems } = parseDaemonConfig({ launcher: { profiles: [
    { name: 'open', command: process.execPath, cwd: 'ask', folders: 'any', folderRoots: [root] },
  ] } });
  expect(problems).toEqual([]);
  const opened: string[] = [];
  daemon = await startTestDaemon({
    launchProfiles: config.launcher,
    folderPicker: () => Promise.resolve(chosen),
    launcher: (value) => { opened.push(value); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  url = opened.at(-1) ?? '';
}, 60_000);
afterAll(async () => {
  if (daemon) await daemon.stop();
  if (rootPath) fs.rmSync(path.dirname(rootPath), { recursive: true, force: true });
}, 120_000);

describe('any-folder dashboard controls', () => {
  it('shows one path box and Browse, fills from the picker, and sends a typed path', async (context) => {
    if (!browser) { context.skip(); return; }
    const shot = await captureDashboard({
      browser, viewerUrl: url, width: 1200, height: 800, drive: true, timeoutMs: 120_000,
      beforeNavigateScript: `(() => {
        window.__launchBodies = [];
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (target, options) => {
          if (String(target) === '/dashboard/launch') {
            window.__launchBodies.push(JSON.parse(options.body));
            return Promise.resolve(new Response(JSON.stringify({ id: 'fake', open: 'grid', profile: 'open' }),
              { status: 200, headers: { 'content-type': 'application/json' } }));
          }
          return nativeFetch(target, options);
        };
      })()`,
      probe: `(() => document.getElementById('profile')?.value === 'open' ? true : null)()`,
      interact: async ({ evaluate }) => evaluate(`(async () => {
        const box = document.getElementById('folder-path');
        const browse = document.getElementById('browse-folder');
        const visible = !document.getElementById('any-folder').hidden &&
          document.getElementById('bounded-folder').hidden && !browse.hidden;
        browse.click();
        for (let index = 0; index < 40 && !box.value; index++)
          await new Promise(resolve => setTimeout(resolve, 50));
        const picked = box.value;
        box.value = 'C:\\\\typed\\\\folder';
        document.getElementById('start').click();
        await new Promise(resolve => setTimeout(resolve, 100));
        const rootPath = ${JSON.stringify(rootPath)};
        const rootOffered = [...document.querySelectorAll('#folder-path-options option')]
          .some(option => option.value === rootPath);
        box.value = rootPath;
        document.getElementById('start').click();
        await new Promise(resolve => setTimeout(resolve, 100));
        return { visible, picked, bodies: window.__launchBodies,
          recent: JSON.parse(localStorage.getItem('shellpuppet.dashboard.recentFolders') || '{}').open,
          rootPath, rootOffered };
      })()`),
    });
    const result = shot.probe as { visible: boolean; picked: string; bodies: { folderPath?: string; folder?: string; rootIndex?: number }[]; recent: string[]; rootPath: string; rootOffered: boolean };
    expect(result.visible).toBe(true);
    expect(result.picked).toBe(chosen);
    expect(result.bodies[0]?.folderPath).toBe('C:\\typed\\folder');
    expect(result.recent).toContain('C:\\typed\\folder');
    expect(result.rootPath).toBe(rootPath);
    expect(result.rootOffered).toBe(true);
    expect(result.bodies[1]).toEqual({ profile: 'open', folder: 'child', rootIndex: 0 });
    expect(result.recent).toContain(rootPath);
  });
});
