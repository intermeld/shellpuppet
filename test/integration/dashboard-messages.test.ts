/** Owner-wide message history and its dashboard presentation. */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAuditor } from '../../src/daemon/audit.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import type { Mailbox } from '../../src/core/mailbox.js';
import { captureDashboard } from './dashboardCapture.js';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

type Fixture = TestDaemon & { urls: string[]; mailbox: Mailbox };
const running: Fixture[] = [];
async function fixture(enabled = true, members?: string[]): Promise<Fixture> {
  const home = makeTempHome('dash-messages-');
  const urls: string[] = [];
  const daemon = await startTestDaemon({
    home, audit: createAuditor(home),
    messaging: { enabled, allow: members ? [{ group: 'team', members }] : [
      { group: 'team', members: ['alpha', 'beta'] },
      { group: 'other', members: ['gamma', 'delta'] },
    ] },
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
  });
  const mailbox = (daemon.daemon as unknown as { mailbox: Mailbox }).mailbox;
  // These cases seed message history directly to exercise its presentation.
  // Permission and reserved-name rules have their own focused tests.
  const seeded = mailbox as unknown as { reservedNames: Set<string>; policy: () => boolean };
  seeded.reservedNames.clear();
  seeded.policy = () => true;
  const result = Object.assign(daemon, { urls, mailbox });
  running.push(result);
  return result;
}
afterEach(async () => { for (const daemon of running.splice(0)) await daemon.stop(); });

async function dashboardUrl(daemon: Fixture): Promise<string> {
  const opened = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
  expect(opened.status).toBe(200);
  return daemon.urls.at(-1)!;
}
async function credential(daemon: Fixture): Promise<{ cookie: string; proof: string }> {
  const url = await dashboardUrl(daemon);
  const raw = (target: string, headers: Record<string, string>): Promise<{ status: number; body: string; cookie: string }> =>
    new Promise((resolve, reject) => {
      const request = http.get(target, { headers }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body,
          cookie: String(response.headers['set-cookie']?.[0] ?? '').split(';')[0]! }));
      });
      request.on('error', reject);
    });
  const redeemed = await raw(url, {
    'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none',
  });
  expect(redeemed.status).toBe(303);
  const cookie = redeemed.cookie;
  const page = await raw(`http://127.0.0.1:${String(daemon.port)}/dashboard`, {
    cookie, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin',
  });
  const proof = /<meta name="sp-csrf" content="([^"]+)">/.exec(page.body)?.[1] ?? '';
  expect(proof).toMatch(/^[0-9a-f]{64}$/);
  return { cookie, proof };
}
function read(daemon: Fixture, headers: Record<string, string> = {}, summary = false): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(daemon.port)}/dashboard/messages${summary ? '?summary=1' : ''}`, {
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', ...headers },
  });
}
function addPeers(daemon: Fixture): void {
  daemon.mailbox.register({ kind: 'session', id: 's1', name: 'alpha' });
  daemon.mailbox.register({ kind: 'session', id: 's2', name: 'beta' });
}

describe('dashboard message access', () => {
  it('labels a member claim as outside in the Messages view', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const daemon = await fixture();
    daemon.mailbox.register({ kind: 'session', id: 's1', name: 'beta' });
    const claim = daemon.mailbox.claim('alpha');
    daemon.mailbox.send(claim.claimId, 'beta', 'hello');
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 900, height: 650,
      drive: true, timeoutMs: 60_000,
      probe: `(() => { if (document.getElementById('messages-view').hidden) document.getElementById('messages-toggle')?.click();
        const row = document.querySelector('#messages-list button');
        const options = [...document.querySelectorAll('#messages-filter option')].map(item => item.textContent);
        return row?.textContent.includes('alpha (outside claim)') &&
          options.some(label => label.includes('alpha (outside claim)')) || null; })()`,
    });
    expect(shot.probe).toBe(true);
  }, 90_000);

  it('keeps the badge response bounded at the mailbox limit', async () => {
    const names = ['alpha', ...Array.from({ length: 10 }, (_, index) => `peer${index}`)];
    const daemon = await fixture(true, names);
    for (const [index, name] of names.entries())
      daemon.mailbox.register({ kind: 'session', id: `s${index}`, name });
    for (let recipient = 1; recipient <= 10; recipient++)
      for (let index = 0; index < 200; index++) daemon.mailbox.send('s0', `peer${recipient - 1}`, 'sample');
    const { cookie, proof } = await credential(daemon);
    const started = performance.now();
    const response = await read(daemon, { cookie, 'x-shellpuppet-csrf': proof }, true);
    const body = await response.text();
    const elapsed = Math.round(performance.now() - started);
    expect(response.status).toBe(200);
    expect(Object.values((JSON.parse(body) as { counts: Record<string, number> }).counts))
      .toEqual(Array(10).fill(200));
    expect(Buffer.byteLength(body)).toBeLessThan(1024);
    console.info(`2,000-message badge summary: ${Buffer.byteLength(body)} bytes, ${elapsed} ms`);
  });

  it('keeps unrelated message metadata off session and anonymous client event sockets', async () => {
    const daemon = await fixture();
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      shell: false, openViewer: false, label: 'alpha',
    } });
    expect(started.status).toBe(200);
    const alphaId = String(started.body['id']);
    const identity = (daemon.daemon as unknown as { manager: {
      identities: Map<string, { token: string }>;
    } }).manager.identities.get(alphaId)!;
    for (const [id, name] of [['gamma-id', 'gamma'], ['delta-id', 'delta']])
      daemon.mailbox.register({ kind: 'session', id: id!, name: name! });
    const betaClaim = daemon.mailbox.claim('beta');
    const connect = async (headers: Record<string, string>) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(daemon.port)}/events?token=${daemon.token}`, { headers });
      const frames: Record<string, unknown>[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<string, unknown>));
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return { ws, frames };
    };
    const alpha = await connect({ 'x-shellpuppet-session': alphaId,
      'x-shellpuppet-session-token': identity.token });
    const anonymous = await connect({});
    await expect(connect({ 'x-shellpuppet-claim': betaClaim.claimId,
      'x-shellpuppet-claim-secret': 'wrong' })).rejects.toThrow('Unexpected server response: 403');
    const beta = await connect({ 'x-shellpuppet-claim': betaClaim.claimId,
      'x-shellpuppet-claim-secret': betaClaim.secret });
    try {
      const unrelated = daemon.mailbox.send('gamma-id', 'delta', 'unrelated');
      daemon.mailbox.markNudged([unrelated.id]);
      daemon.mailbox.inbox('delta-id');
      daemon.mailbox.send(alphaId, 'beta', 'related');
      daemon.mailbox.inbox(betaClaim.claimId);
      await eventually(() => alpha.frames.some((frame) => frame.type === 'message' &&
        (frame.from as { id: string } | undefined)?.id === alphaId));
      await eventually(() => beta.frames.some((frame) => frame.type === 'message-state'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alpha.frames.filter((frame) => frame.type === 'message')
        .map((frame) => (frame.from as { id: string } | undefined)?.id))
        .toEqual([alphaId]);
      // State changes of another pair's message never reach an unrelated participant.
      expect(alpha.frames.filter((frame) => frame.type === 'message-state' && frame.id === unrelated.id)).toEqual([]);
      expect(beta.frames.filter((frame) => frame.id === unrelated.id)).toEqual([]);
      expect(anonymous.frames.filter((frame) => frame.type === 'message' || frame.type === 'message-state'))
        .toEqual([]);
      expect(beta.frames.filter((frame) => frame.type === 'message').map((frame) => frame.id)).toEqual(['m2']);
      expect(beta.frames.filter((frame) => frame.type === 'message-state').map((frame) => frame.state))
        .toEqual(['read']);
      const closed = new Promise<void>((resolve) => beta.ws.once('close', resolve));
      const released = await api(daemon.port, daemon.token, `/messages/claims/${betaClaim.claimId}`, {
        method: 'DELETE', headers: { 'x-shellpuppet-claim': betaClaim.claimId,
          'x-shellpuppet-claim-secret': betaClaim.secret },
      });
      expect(released.status).toBe(200);
      await closed;
    } finally { alpha.ws.close(); anonymous.ws.close(); beta.ws.close(); }
  });
  it('reads all messages only with its cookie and proof, and audits count without text', async () => {
    const daemon = await fixture();
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      shell: false, openViewer: false, label: 'alpha',
    } });
    expect(started.status).toBe(200);
    const sessionId = String(started.body['id']);
    daemon.mailbox.register({ kind: 'session', id: 'peer-beta', name: 'beta' });
    daemon.mailbox.register({ kind: 'session', id: 'peer-gamma', name: 'gamma' });
    daemon.mailbox.register({ kind: 'session', id: 'peer-delta', name: 'delta' });
    const identity = (daemon.daemon as unknown as { manager: {
      identities: Map<string, { token: string }>;
    } }).manager.identities.get(sessionId)!;
    const claim = daemon.mailbox.claim('outsider');
    const secret = 'private message body';
    const otherSecret = 'another private body';
    daemon.mailbox.send(sessionId, 'beta', secret);
    daemon.mailbox.send('peer-gamma', 'delta', otherSecret);
    const { cookie, proof } = await credential(daemon);
    const accepted = await read(daemon, { cookie, 'x-shellpuppet-csrf': proof });
    expect(accepted.status).toBe(200);
    const body = await accepted.json() as { messages: { text: string }[]; groups: { group: string }[] };
    expect(body.messages.map((entry) => entry.text)).toEqual([secret, otherSecret]);
    expect(body.groups.map((group) => group.group)).toEqual(['team', 'other']);
    const summary = await read(daemon, { cookie, 'x-shellpuppet-csrf': proof }, true);
    const summaryBody = await summary.json() as { counts: Record<string, number>; messages?: unknown };
    expect(summaryBody.counts['peer-beta']).toBe(1);
    expect(summaryBody.counts['peer-delta']).toBe(1);
    expect(summaryBody.messages).toBeUndefined();
    expect(await read(daemon, { cookie, 'x-shellpuppet-csrf': proof }, true).then((response) => response.text()))
      .not.toContain(otherSecret);
    for (const headers of [
      {}, { 'x-shellpuppet-csrf': proof },
      { authorization: `Bearer ${daemon.token}`, 'x-shellpuppet-csrf': proof },
      { authorization: `Bearer ${daemon.token}`, 'x-shellpuppet-session': sessionId,
        'x-shellpuppet-session-token': identity.token, 'x-shellpuppet-csrf': proof },
      { authorization: `Bearer ${daemon.token}`, 'x-shellpuppet-claim': claim.claimId,
        'x-shellpuppet-claim-secret': claim.secret, 'x-shellpuppet-csrf': proof },
      { cookie: 'sp_dash=wrong', 'x-shellpuppet-csrf': proof },
      { cookie },
    ] as Record<string, string>[]) {
      const response = await read(daemon, headers);
      expect([401, 403]).toContain(response.status);
      expect(await response.text()).not.toContain(secret);
    }
    const audit = fs.readFileSync(path.join(daemon.home, 'audit.log'), 'utf8');
    const entries = audit.trim().split('\n').map((line) => JSON.parse(line) as {
      actor: string; action: string; meta?: Record<string, unknown>;
    }).filter((entry) => entry.action === 'msg-log');
    expect(entries.map(({ actor, action, meta }) => ({ actor, action, meta }))).toEqual(Array(3)
      .fill({ actor: 'dashboard', action: 'msg-log', meta: { count: 2 } }));
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain(otherSecret);
  });

  it('sends new and nudged or read states to the dashboard feed without text', async () => {
    const daemon = await fixture();
    addPeers(daemon);
    const { cookie, proof } = await credential(daemon);
    const ws = new WebSocket(`ws://127.0.0.1:${String(daemon.port)}/dashboard/events`, [`sp-csrf.${proof}`], {
      headers: { cookie, origin: `http://127.0.0.1:${String(daemon.port)}`,
        'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket' },
    });
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    try {
      const sent = daemon.mailbox.send('s1', 'beta', 'feed-secret');
      daemon.mailbox.markNudged([sent.id]);
      daemon.mailbox.inbox('s2');
      await eventually(() => frames.filter((frame) => frame.type === 'message-state').length === 2);
      expect(frames.filter((frame) => frame.type === 'message' || frame.type === 'message-state')
        .map((frame) => frame.type)).toEqual(['message', 'message-state', 'message-state']);
      expect(JSON.stringify(frames)).not.toContain('feed-secret');
    } finally { ws.close(); }
  });
});

describe('dashboard message presentation', () => {
  it('coalesces a burst of feed updates into a bounded number of history requests', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const daemon = await fixture();
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 800, height: 600,
      drive: true, timeoutMs: 60_000,
      beforeNavigateScript: `(() => {
        window.__messageFetches = 0;
        const original = window.fetch.bind(window);
        window.fetch = (...args) => {
          if (String(args[0]).startsWith('/dashboard/messages')) window.__messageFetches++;
          return original(...args);
        };
      })()`,
      probe: `(() => {
        const feed = window.__dashboardDiagnostics.streams.find(s => s.url.endsWith('/dashboard/events'));
        if (!feed || feed.snapshotIds === null || !window.__messageFetches) return null;
        if (!window.__burstAt) {
          window.__burstAt = Date.now();
          window.__burstBase = window.__messageFetches;
          for (let i = 0; i < 12; i++) feed.socket.onmessage({ data: JSON.stringify({ type: 'message', id: 'm' + i }) });
          return null;
        }
        return Date.now() - window.__burstAt >= 750 ? window.__messageFetches - window.__burstBase : null;
      })()`,
    });
    expect(Number(shot.probe)).toBeGreaterThanOrEqual(1);
    expect(Number(shot.probe)).toBeLessThanOrEqual(2);
  }, 90_000);

  it('restores the badge after reconnect and clears it on not-delivered while retaining the row', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const daemon = await fixture();
    const sender = daemon.mailbox.claim('alpha');
    const receiver = daemon.mailbox.claim('beta');
    const sent = daemon.mailbox.send(sender.claimId, 'beta', 'pending delivery');
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 800, height: 600,
      drive: true, timeoutMs: 60_000,
      probe: `(() => {
        const feeds = window.__dashboardDiagnostics.streams.filter(s => s.url.endsWith('/dashboard/events'));
        const feed = feeds.at(-1);
        if (!feed || feed.snapshotIds === null) return null;
        if (!feed.__injectedPeer) {
          feed.__injectedPeer = true;
          feed.socket.onmessage({ data: JSON.stringify({ type: 'snapshot', sessions: [
            { id: ${JSON.stringify(receiver.claimId)}, label: 'beta', cols: 80, rows: 24 }
          ] }) });
        }
        const badge = document.querySelector('[data-session=${JSON.stringify(receiver.claimId)}] .pane-message-count');
        if (!badge) return null;
        if (!window.__reconnected) {
          if (badge.hidden) return null;
          window.__reconnected = true;
          feed.socket.close();
          return null;
        }
        if (feeds.length < 2 || feeds.at(-1).snapshotIds === null) return null;
        if (!window.__released) {
          if (badge.hidden) return null;
          window.__released = true;
          badge.click();
          fetch('/messages/claims/${receiver.claimId}', { method: 'DELETE', headers: {
            authorization: 'Bearer ${daemon.token}',
            'x-shellpuppet-claim': '${receiver.claimId}',
            'x-shellpuppet-claim-secret': '${receiver.secret}'
          } }).then(response => { if (!response.ok) window.__releaseError = response.status; });
          return null;
        }
        if (window.__releaseError) return 'error: ' + window.__releaseError;
        const row = [...document.querySelectorAll('#messages-list button')]
          .find(item => item.textContent.includes('${sent.id}'));
        return badge.hidden && row?.textContent.includes('not-delivered') || null;
      })()`,
    });
    expect(shot.probe).toBe(true);
  }, 90_000);

  it('updates the pane count as messages arrive and are read', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const daemon = await fixture();
    const sender = daemon.mailbox.claim('alpha');
    const receiver = daemon.mailbox.claim('beta');
    const probe = `(() => {
      const entry = window.__dashboardDiagnostics.streams.find(s => s.url.endsWith('/dashboard/events'));
      if (!entry || entry.snapshotIds === null) return null;
      if (!window.__injectedPeer) {
        window.__injectedPeer = true;
        entry.socket.onmessage({ data: JSON.stringify({ type: 'snapshot', sessions: [
          { id: ${JSON.stringify(receiver.claimId)}, label: 'beta', cols: 80, rows: 24 }
        ] }) });
      }
      const badge = document.querySelector('[data-session=${JSON.stringify(receiver.claimId)}] .pane-message-count');
      if (!badge) return null;
      const headers = { authorization: 'Bearer ${daemon.token}', 'content-type': 'application/json' };
      if (!window.__messageStage) {
        window.__messageStage = 1;
        fetch('/messages', { method: 'POST', headers: { ...headers,
          'x-shellpuppet-claim': ${JSON.stringify(sender.claimId)},
          'x-shellpuppet-claim-secret': ${JSON.stringify(sender.secret)} },
          body: JSON.stringify({ to: 'beta', text: 'live badge' }) })
          .then(response => { if (!response.ok) window.__messageError = response.status; })
          .catch(error => { window.__messageError = String(error); });
        return null;
      }
      if (window.__messageError) return 'error: ' + window.__messageError;
      if (window.__messageStage === 1 && !badge.hidden && badge.textContent === '1 message') {
        window.__messageStage = 2;
        fetch('/messages/inbox', { headers: { ...headers,
          'x-shellpuppet-claim': ${JSON.stringify(receiver.claimId)},
          'x-shellpuppet-claim-secret': ${JSON.stringify(receiver.secret)} } })
          .then(response => { if (!response.ok) window.__messageError = response.status; })
          .catch(error => { window.__messageError = String(error); });
        return null;
      }
      return window.__messageStage === 2 && badge.hidden || null;
    })()`;
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 900, height: 650,
      drive: true, timeoutMs: 60_000, probe });
    expect(shot.probe).toBe(true);
  }, 90_000);

  it('lists history, renders hostile text inert, and filters from the unread badge', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const daemon = await fixture();
    addPeers(daemon);
    const hostile = '<img src=x onerror="window.__messageRan=1"><script>window.__messageRan=2</script>\u001b[31m https://example.invalid/path';
    const sent = daemon.mailbox.send('s1', 'beta', hostile);
    daemon.mailbox.markNudged([sent.id]);
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 900, height: 650,
      drive: true, timeoutMs: 60_000,
      probe: `(() => {
        const entry = window.__dashboardDiagnostics.streams.find(s => s.url.endsWith('/dashboard/events'));
        const feed = entry?.socket;
        if (!feed || entry.snapshotIds === null || !document.querySelector('#messages-toggle')) return null;
        if (!window.__injectedPeers) {
          window.__injectedPeers = true;
          feed.onmessage({ data: JSON.stringify({ type: 'snapshot', sessions: [
            { id: 's1', label: 'alpha', cols: 80, rows: 24 },
            { id: 's2', label: 'beta', cols: 80, rows: 24 }
          ] }) });
        }
        const badge = document.querySelector('[data-session="s2"] .pane-message-count');
        if (!badge || badge.hidden || badge.textContent !== '1 message') return null;
        if (document.getElementById('messages-view').hidden) badge.click();
        const row = document.querySelector('#messages-list button');
        if (!row) return null;
        if (!row.textContent.includes('nudged')) return null;
        row.click();
        const detail = document.getElementById('messages-detail');
        if (!detail.textContent.includes('\\\\u001b[31m')) return null;
        const text = detail.textContent;
        const html = detail.querySelector('img,script,a')?.tagName || null;
        const ran = window.__messageRan || 0;
        const filter = document.getElementById('messages-filter').value;
        document.getElementById('messages-filter').value = 'group:team';
        document.getElementById('messages-filter').dispatchEvent(new Event('change'));
        return JSON.stringify({ filter, groupCount: document.querySelectorAll('#messages-list button').length,
          count: document.querySelectorAll('#messages-list button').length,
          text, html, ran });
      })()`,
    });
    const observed = JSON.parse(String(shot.probe)) as { filter: string; groupCount: number; count: number; text: string; html: string | null; ran: number };
    expect(observed.filter).toBe('session:s2');
    expect(observed.groupCount).toBe(1);
    expect(observed.count).toBe(1);
    expect(observed.text).toContain('<img src=x onerror=');
    expect(observed.text).toContain('\\u001b[31m');
    expect(observed.text).toContain('https://example.invalid/path');
    expect(observed.html).toBeNull();
    expect(observed.ran).toBe(0);
    daemon.mailbox.inbox('s2');
    const cleared = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 900, height: 650,
      drive: true, timeoutMs: 60_000,
      probe: `(() => {
        const entry = window.__dashboardDiagnostics.streams.find(s => s.url.endsWith('/dashboard/events'));
        if (!entry || entry.snapshotIds === null) return null;
        if (!window.__injectedPeers) {
          window.__injectedPeers = true;
          entry.socket.onmessage({ data: JSON.stringify({ type: 'snapshot', sessions: [
            { id: 's1', label: 'alpha', cols: 80, rows: 24 },
            { id: 's2', label: 'beta', cols: 80, rows: 24 }
          ] }) });
        }
        const badge = document.querySelector('[data-session="s2"] .pane-message-count');
        return badge && badge.hidden || null;
      })()`,
    });
    expect(cleared.probe).toBe(true);
  }, 90_000);

  it('shows the empty state when messaging is on', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const daemon = await fixture();
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 800, height: 600,
      drive: true, timeoutMs: 60_000,
      probe: `(() => { if (document.getElementById('messages-view').hidden) document.getElementById('messages-toggle')?.click();
        return !document.getElementById('messages-empty').hidden &&
          document.getElementById('messages-empty').textContent === 'No messages yet.' || null; })()`,
    });
    expect(shot.probe).toBe(true);
  }, 90_000);

  it('shows a plain off message', async (context) => {
    const browser = await findBrowser();
    if (!browser) { context.skip(); return; }
    const daemon = await fixture(false);
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(daemon), width: 800, height: 600,
      drive: true, timeoutMs: 60_000,
      probe: `(() => { if (document.getElementById('messages-view').hidden) document.getElementById('messages-toggle')?.click();
        const off = document.getElementById('messages-off');
        return off && !off.hidden && off.textContent.includes('Messaging is off.') &&
          off.querySelector('a')?.href.includes('configuration.md') || null; })()`,
    });
    expect(shot.probe).toBe(true);
  }, 90_000);
});
