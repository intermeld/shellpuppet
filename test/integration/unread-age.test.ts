import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Mailbox } from '../../src/core/mailbox.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { captureDashboard } from './dashboardCapture.js';
import { api, repoRoot, startTestDaemon } from './helpers.js';

const execFileAsync = promisify(execFile);

function page(target: string, headers: Record<string, string>): Promise<{ status: number; body: string; cookie: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(target, { headers }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body,
        cookie: String(response.headers['set-cookie']?.[0] ?? '').split(';')[0]! }));
    });
    request.on('error', reject);
  });
}

describe('owner unread-by-age view', () => {
  it('returns only aged unread metadata and refuses participant and unproved access', async () => {
    let now = 1_000_000;
    const audit: unknown[] = [];
    const logs: unknown[] = [];
    const urls: string[] = [];
    const marker = 'private-message-text-72a9';
    const td = await startTestDaemon({
      now: () => now,
      messaging: { enabled: true, allow: [{ group: 'team', members: ['sender', 'recipient', 'other'] }] },
      audit: { captureContent: true, record: (...entry) => { audit.push(entry); } },
      logger: { debug: (...entry) => { logs.push(entry); }, info: (...entry) => { logs.push(entry); },
        warn: (...entry) => { logs.push(entry); }, error: (...entry) => { logs.push(entry); } },
      launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    });
    try {
      const mailbox = (td.daemon as unknown as { mailbox: Mailbox }).mailbox;
      const sender = mailbox.claim('sender');
      const recipient = mailbox.claim('recipient');
      const other = mailbox.claim('other');
      const first = mailbox.send(sender.claimId, 'recipient', marker);
      mailbox.markNudged([first.id]);
      now += 15_000;
      const second = mailbox.send(sender.claimId, 'recipient', 'another-secret');
      const read = mailbox.send(sender.claimId, 'other', 'already-read-secret');
      mailbox.inbox(other.claimId);
      now += 5_000;

      const owner = await fetch(`http://127.0.0.1:${String(td.port)}/messages/unread-age`, {
        headers: { authorization: `Bearer ${td.token}` },
      });
      const raw = await owner.text();
      expect(owner.status).toBe(200);
      expect(owner.headers.get('cache-control')).toBe('no-store');
      expect(raw).not.toContain(marker);
      expect(raw).not.toContain('another-secret');
      expect(raw).not.toContain('already-read-secret');
      expect(raw).not.toContain('text');
      expect(JSON.parse(raw)).toEqual({ messages: [
        { id: first.id, from: { id: sender.claimId, name: 'sender' },
          to: { id: recipient.claimId, name: 'recipient' },
          state: 'nudged', sentAt: 1_000_000, ageMs: 20_000 },
        { id: second.id, from: { id: sender.claimId, name: 'sender' },
          to: { id: recipient.claimId, name: 'recipient' },
          state: 'waiting', sentAt: 1_015_000, ageMs: 5_000 },
      ] });
      expect(read.id).not.toEqual(first.id);

      const participant = { 'x-shellpuppet-claim': sender.claimId, 'x-shellpuppet-claim-secret': sender.secret };
      expect((await api(td.port, td.token, '/messages/unread-age', { headers: participant })).status).toBe(403);
      expect((await api(td.port, td.token, '/messages/unread-age', {
        headers: { 'x-shellpuppet-inside-session': '1' },
      })).status).toBe(403);
      const started = await api(td.port, td.token, '/sessions', { body: {
        command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
        shell: false, openViewer: false,
      } });
      expect(started.status).toBe(200);
      const sessionId = String(started.body['id']);
      const identity = (td.daemon as unknown as { manager: {
        identities: Map<string, { token: string }>;
      } }).manager.identities.get(sessionId)!;
      expect((await api(td.port, td.token, '/messages/unread-age', { headers: {
        'x-shellpuppet-session': sessionId, 'x-shellpuppet-session-token': identity.token,
      } })).status).toBe(403);
      expect((await api(td.port, null, '/messages/unread-age')).status).toBe(401);

      expect((await api(td.port, td.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
      const grant = await page(urls.at(-1)!, {
        'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none',
      });
      expect(grant.status).toBe(303);
      const cookie = grant.cookie;
      const openedPage = await page(`http://127.0.0.1:${String(td.port)}/dashboard`, {
        cookie, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin',
      });
      const proof = /<meta name="sp-csrf" content="([^"]+)">/.exec(openedPage.body)?.[1];
      expect(proof).toMatch(/^[0-9a-f]{64}$/);
      const dashboardPath = `http://127.0.0.1:${String(td.port)}/dashboard/messages/unread-age`;
      const headers = { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty', 'x-shellpuppet-csrf': proof! };
      const dashboard = await fetch(dashboardPath, { headers });
      expect(dashboard.status).toBe(200);
      expect(await dashboard.json()).toEqual(JSON.parse(raw));
      expect((await fetch(dashboardPath, { headers: { ...headers, 'x-shellpuppet-csrf': '' } })).status).toBe(403);
      expect((await fetch(dashboardPath, { headers: { ...headers, origin: 'https://elsewhere.example' } })).status).toBe(403);
      expect((await fetch(dashboardPath, { headers: { cookie: 'sp_view=fake' } })).status).toBe(401);
      expect(JSON.stringify(audit)).not.toContain(marker);
      expect(JSON.stringify(logs)).not.toContain(marker);
    } finally { await td.stop(); }
  }, 60_000);

  it('prints only metadata through the owner CLI', async () => {
    const td = await startTestDaemon({ messaging: { enabled: true,
      allow: [{ group: 'team', members: ['sender', 'recipient'] }] } });
    try {
      const mailbox = (td.daemon as unknown as { mailbox: Mailbox }).mailbox;
      const sender = mailbox.claim('sender');
      mailbox.claim('recipient');
      const sent = mailbox.send(sender.claimId, 'recipient', 'private-cli-text-018');
      const env: NodeJS.ProcessEnv = { ...process.env, SHELLPUPPET_HOME: td.home };
      for (const key of ['SHELLPUPPET_SESSION', 'SHELLPUPPET_SESSION_TOKEN',
        'SHELLPUPPET_DAEMON_INSTANCE', 'SHELLPUPPET_CLAIM']) delete env[key];
      const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
      const json = await execFileAsync(process.execPath, [cli, 'messages', 'unread', '--json'], { env });
      expect(json.stdout).not.toContain('private-cli-text-018');
      expect(JSON.parse(json.stdout)).toEqual({ messages: [expect.objectContaining({ id: sent.id, state: 'waiting' })] });
      const plain = await execFileAsync(process.execPath, [cli, 'messages', 'unread'], { env });
      expect(plain.stdout).toContain(sent.id);
      expect(plain.stdout).toContain('Age (s)');
      expect(plain.stdout).not.toContain('private-cli-text-018');
    } finally { await td.stop(); }
  }, 60_000);

  it('shows the age list without message text in the dashboard', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const urls: string[] = [];
    const td = await startTestDaemon({ messaging: { enabled: true,
      allow: [{ group: 'team', members: ['sender', 'recipient'] }] },
      launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    });
    try {
      const mailbox = (td.daemon as unknown as { mailbox: Mailbox }).mailbox;
      const sender = mailbox.claim('sender');
      mailbox.claim('recipient');
      const sent = mailbox.send(sender.claimId, 'recipient', 'private-dashboard-text-62b');
      expect((await api(td.port, td.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
      const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 900, height: 650,
        drive: true, timeoutMs: 60_000,
        probe: `(() => {
          const view = document.getElementById('messages-view');
          if (view.hidden) document.getElementById('messages-toggle')?.click();
          const tab = document.getElementById('messages-unread-age');
          if (tab.getAttribute('aria-pressed') !== 'true') tab.click();
          const list = document.getElementById('messages-list');
          const row = list.querySelector('.unread-age-row');
          if (!row || !row.textContent.includes(${JSON.stringify(sent.id)})) return null;
          return JSON.stringify({ row: row.textContent, list: list.textContent,
            detailHidden: document.getElementById('messages-detail').hidden,
            filterHidden: document.getElementById('messages-filter-wrap').hidden });
        })()`,
      });
      const observed = JSON.parse(String(shot.probe)) as { row: string; list: string;
        detailHidden: boolean; filterHidden: boolean };
      expect(observed.row).toContain('sender');
      expect(observed.row).toContain('recipient');
      expect(observed.row).toContain('waiting');
      expect(observed.list).not.toContain('private-dashboard-text-62b');
      expect(observed.detailHidden).toBe(true);
      expect(observed.filterHidden).toBe(true);
    } finally { await td.stop(); }
  }, 90_000);
});
