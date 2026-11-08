import * as path from 'node:path';
import { expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import type { FeedFrame } from '../../src/daemon/sessionFeed.js';
import { captureDashboard } from './dashboardCapture.js';
import { api, eventually, repoRoot, startTestDaemon } from './helpers.js';

it('shows and clears a provider stall in the feed, dashboard badge and shared pane', async context => {
  const browser = await findBrowser();
  if (browser === null) { context.skip(); return; }
  let url = '';
  const td = await startTestDaemon({ launcher: value => {
    url = value;
    return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' });
  } });
  const frames: FeedFrame[] = [];
  const unsubscribe = td.daemon.subscribeDashboardFeed(frame => frames.push(frame));
  try {
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [path.join(repoRoot, 'test/fixtures/stalled-screen.mjs')],
      shell: false, agent: 'mimo', cols: 120, rows: 30, hold: true, openViewer: false,
    } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const id = String(started.body['id']);
    await eventually(() => frames.some(frame => frame.type === 'session-updated' && frame.session.id === id && frame.changed.includes('stalled')));
    await api(td.port, td.token, '/dashboard/open', { method: 'POST', body: {} });
    const result = await captureDashboard({ browser, viewerUrl: url, width: 1100, height: 700, drive: true, probeOnly: true, timeoutMs: 60_000,
      probe: `(() => { const card = document.querySelector('[data-session="${id}"]'); return card?.querySelector('.xterm-screen') ? true : null; })()`,
      interact: async page => {
        await page.evaluate('new Promise(resolve => setTimeout(resolve, 1500))');
        const before = await page.evaluate(`(() => { const card = document.querySelector('[data-session="${id}"]'); return { badge: card.querySelector('.badge').textContent, notice: card.querySelector('.pane-prompt').textContent, hidden: card.querySelector('.pane-prompt').hidden }; })()`);
        await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'b' } });
        await eventually(async () => await page.evaluate(`document.querySelector('[data-session="${id}"] .badge').textContent === ''`) === true);
        const after = await page.evaluate(`document.querySelector('[data-session="${id}"] .pane-prompt').hidden`);
        return { before, after };
      },
    });
    expect(result.probe).toMatchObject({ before: { badge: '● Stalled', hidden: false }, after: true });
    const before = (result.probe as { before: { notice: string } }).before;
    expect(before.notice).toContain('provider-refused');
    expect(before.notice).toContain('The model provider refused the turn.');
    expect(before.notice).not.toContain('content safety filter');
    const updates = frames.filter(frame => frame.type === 'session-updated' && frame.changed.includes('stalled'));
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ session: { id } });
    if (updates[1]?.type === 'session-updated') expect(updates[1].session.stalled).toBeUndefined();
  } finally { unsubscribe(); await td.stop(); }
}, 120_000);
