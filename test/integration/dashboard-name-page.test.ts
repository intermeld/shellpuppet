import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, makeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let daemon: TestDaemon;
let browser: string | null;
let dashboardUrl = '';

beforeAll(async () => {
  browser = await findBrowser();
  const home = makeTempHome('dashboard-name-page-');
  const profiles = parseDaemonConfig({ launcher: { profiles: [{ name: 'lead', command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], shell: false },
    { name: 'resume', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', '--'],
      resume: ['--resume', '{id}'], shell: false }] } }).config.launcher;
  daemon = await startTestDaemon({
    home, audit: createAuditor(home), launchProfiles: profiles,
    viewer: { launchMode: 'no-window' },
    launcher: (url) => { dashboardUrl = url; return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' }); },
  });
}, 60_000);
afterAll(async () => { await daemon.stop(); }, 120_000);

describe('dashboard naming controls', () => {
  it('starts with the Name box and renames a pane through the page', async (context) => {
    if (!browser) { context.skip(); return; }
    const opened = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
    expect(opened.status).toBe(200);
    const result = await captureDashboard({ browser, viewerUrl: dashboardUrl, width: 1280, height: 720,
      drive: true, timeoutMs: 90_000, probeOnly: true,
      probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
        document.getElementById('session-name')?.value === 'lead' &&
        document.getElementById('start')?.disabled === false)()`,
      interact: async (page) => page.evaluate(`new Promise((resolve) => {
        const name = document.getElementById('session-name');
        const field = document.getElementById('resume-field');
        const profile = document.querySelector('#launcher select');
        if (!field.hidden) { resolve('unexpected resume field'); return; }
        profile.value = 'resume';
        profile.dispatchEvent(new Event('change'));
        if (field.hidden) { resolve('missing resume field'); return; }
        document.getElementById('resume-id').value = 'from-browser-42';
        name.value = 'from-page';
        document.getElementById('start').click();
        const deadline = Date.now() + 30000;
        const poll = () => {
          const pane = [...document.querySelectorAll('.pane')].find((item) => item.querySelector('.pane-label')?.textContent === 'from-page');
          if (!pane) { if (Date.now() < deadline) setTimeout(poll, 100); else resolve('launch timeout'); return; }
          pane.querySelector('button[aria-label="Rename"]').click();
          const input = pane.querySelector('input[aria-label="New session name"]');
          input.value = 'renamed-page';
          input.closest('form').requestSubmit();
          const renamed = () => {
            if (pane.querySelector('.pane-label')?.textContent === 'renamed-page') resolve(JSON.stringify({
              nameBox: name.value, label: pane.querySelector('.pane-label').textContent,
              role: pane.dataset.role }));
            else if (Date.now() < deadline) setTimeout(renamed, 100);
            else resolve('rename timeout');
          };
          renamed();
        };
        poll();
      })`),
    });
    expect(readFileSync(join(daemon.home, 'audit.log'), 'utf8')).toContain('from-browser-42');
    expect(JSON.parse(String(result.probe))).toMatchObject({ nameBox: 'from-page', label: 'renamed-page', role: 'delegate' });
  }, 120_000);
});
