import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let daemon: TestDaemon;
let browser: string | null;
let dashboardUrl = '';

beforeAll(async () => {
  browser = await findBrowser();
  const home = makeTempHome('dashboard-name-page-');
  const profiles = parseDaemonConfig({ launcher: { profiles: [{ name: 'lead', label: 'desk', command: process.execPath,
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
    const responses: { action: string; status: number }[] = [];
    const launches: { profile: string; name: string; resumed: boolean }[] = [];
    const labelFact = (value: unknown) => {
      if (value === undefined) return 'absent';
      return typeof value === 'string' && ['lead', 'resume', 'from-page', 'renamed-page', 'desk'].includes(value) ? value : 'other';
    };
    type Pane = { id: string; label: string; role: string };
    const paneFacts = (panes: { id: string; label: string }[]) => panes.slice(-8).map(({ id, label }) => ({
      id: /^s\d{1,5}$/.test(id) ? id : 'other', label: labelFact(label),
    }));
    let phase = 'opening dashboard';
    let panes: Pane[] = [];
    let sessionFacts: ReturnType<typeof paneFacts> | undefined;
    let pageErrorShown: boolean | undefined;
    const result = await captureDashboard({ browser, viewerUrl: dashboardUrl, width: 1280, height: 720,
      drive: true, timeoutMs: 90_000, probeOnly: true,
      failureFacts: () => ({ phase, launches, responses, sessions: sessionFacts, panes: paneFacts(panes), pageErrorShown }),
      probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
        document.getElementById('session-name')?.value === 'lead' &&
        document.getElementById('start')?.disabled === false)()`,
      interact: async ({ evaluate, onEvent, send }) => {
        onEvent('Network.requestWillBeSent', event => {
          const request = event['request'] as { url: string; postData?: string };
          if (new URL(request.url).pathname === '/dashboard/launch' && request.postData) {
            try {
              const { profile, name, resumeId } = JSON.parse(request.postData) as Record<string, unknown>;
              launches.push({ profile: labelFact(profile), name: labelFact(name), resumed: resumeId === 'from-browser-42' });
            } catch { launches.push({ profile: 'unreadable', name: 'unreadable', resumed: false }); }
            if (launches.length > 8) launches.shift();
          }
        });
        onEvent('Network.responseReceived', event => {
          const response = event['response'] as { url: string; status: number };
          const path = new URL(response.url).pathname;
          if (path === '/dashboard/launch' || path.endsWith('/rename')) {
            responses.push({ action: path.endsWith('/rename') ? 'rename' : 'launch', status: response.status });
            if (responses.length > 8) responses.shift();
          }
        });
        await send('Network.enable');
        const cards = `[...document.querySelectorAll('.pane')].map(card => ({ id: card.dataset.session,
          label: card.querySelector('.pane-label')?.textContent, role: card.dataset.role }))`;
        const waitForPane = async (description: string, matches: (pane: Pane) => boolean) => {
          phase = description;
          try {
            await eventually(async () => {
              const observed = await evaluate(cards);
              if (!Array.isArray(observed)) return false;
              panes = observed as Pane[];
              return panes.some(matches);
            }, 30_000, 100, description);
          } catch {
            const listed = await api(daemon.port, daemon.token, '/sessions');
            const rows = listed.body['sessions'] as { id: string; label: string }[] | undefined;
            if (Array.isArray(rows)) sessionFacts = paneFacts(rows);
            const shown = await evaluate("!!document.getElementById('error-message')?.textContent").catch(() => undefined);
            pageErrorShown = typeof shown === 'boolean' ? shown : undefined;
            throw new Error('Dashboard pane wait failed.');
          }
          return panes.find(matches)!;
        };

        await evaluate("document.getElementById('start').click()");
        phase = 'waiting for default session name';
        let leadId: string | undefined;
        await eventually(async () => {
          const listed = await api(daemon.port, daemon.token, '/sessions');
          leadId = (listed.body['sessions'] as { id: string; name: string }[]).find(session => session.name === 'lead')?.id;
          return leadId !== undefined;
        }, 15_000, 100, 'the default session name', () => ({ launches, responses }));
        await waitForPane('the first launch to appear in this window', pane => pane.id === leadId);
        expect(await evaluate("document.getElementById('resume-field').hidden")).toBe(true);
        await evaluate(`(() => {
          const profile = document.querySelector('#launcher select');
          profile.value = 'resume';
          profile.dispatchEvent(new Event('change'));
        })()`);
        expect(await evaluate("document.getElementById('resume-field').hidden")).toBe(false);
        await evaluate(`(() => {
          document.getElementById('resume-id').value = 'from-browser-42';
          document.getElementById('session-name').value = 'from-page';
          document.getElementById('start').click();
        })()`);
        const launched = await waitForPane('the pane labelled from-page', pane => pane.label === 'from-page');
        await evaluate(`(() => {
          const pane = document.querySelector('.pane[data-session="' + ${JSON.stringify(launched.id)} + '"]');
          pane.querySelector('button[aria-label="Rename"]').click();
          const input = pane.querySelector('input[aria-label="New session name"]');
          input.value = 'renamed-page';
          input.closest('form').requestSubmit();
        })()`);
        const renamed = await waitForPane('the renamed pane', pane => pane.id === launched.id && pane.label === 'renamed-page');
        return { label: labelFact(renamed.label), role: renamed.role === 'delegate' ? 'delegate' : 'other',
          nameBox: labelFact(await evaluate("document.getElementById('session-name').value")) };
      },
    });
    expect(readFileSync(join(daemon.home, 'audit.log'), 'utf8').includes('from-browser-42')).toBe(true);
    expect(result.probe).toMatchObject({ nameBox: 'from-page', label: 'renamed-page', role: 'delegate' });
  }, 120_000);
});
