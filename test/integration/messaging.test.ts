import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

const execFileAsync = promisify(execFile);
const marker = 'peer-marker-4f0b6a';

describe('session messaging over a real daemon', () => {
  it('limits claim creation and ignores a stale claim on a new claim request', async () => {
    let now = 100_000;
    const td = await startTestDaemon({ messaging: { enabled: true, allow: [] }, now: () => now });
    try {
      const claims = [];
      for (let i = 0; i < 8; i++) {
        const response = await api(td.port, td.token, '/messages/claims', { body: { name: `claim${i}` } });
        expect(response.status).toBe(201);
        claims.push(response);
      }
      const limited = await api(td.port, td.token, '/messages/claims', { body: { name: 'claim8' } });
      expect(limited.status).toBe(429);
      expect(limited.body['error']).toMatch(/rate/i);
      now += 60_001;
      const fresh = await api(td.port, td.token, '/messages/claims', {
        body: { name: 'claim8' }, headers: {
          'x-shellpuppet-claim': String(claims[0]?.body['claimId']),
          'x-shellpuppet-claim-secret': 'stale',
        },
      });
      expect(fresh.status).toBe(201);
      for (let i = 9; i < 64; i++) {
        now += 60_001;
        expect((await api(td.port, td.token, '/messages/claims', {
          body: { name: `claim${i}` },
        })).status).toBe(201);
      }
      now += 60_001;
      const capped = await api(td.port, td.token, '/messages/claims', { body: { name: 'claim64' } });
      expect(capped.status).toBe(429);
      expect(capped.body['error']).toMatch(/limit/i);
    } finally { await td.stop(); }
  });

  it('gives a session the absolute daemon home and a CLI connected to that daemon', async () => {
    const absoluteHome = makeTempHome('message-relative-home-');
    const relativeHome = path.relative(process.cwd(), absoluteHome);
    const td = await startTestDaemon({ home: relativeHome,
      messaging: { enabled: true, allow: [] }, sessionEnv: 'passthrough' });
    try {
      const code = "const h=process.env.SHELLPUPPET_HOME;console.log('HOME:'+h);if(h===process.argv[1]){const c=require('node:child_process');try{c.execFileSync(process.execPath,[process.env.SHELLPUPPET_CLI,'msg','directory','--json'],{encoding:'utf8'});console.log('CLI_OK')}catch{console.log('CLI_FAILED')}}setInterval(()=>{},1000)";
      const response = await api(td.port, td.token, '/sessions', { body: {
        command: process.execPath, args: ['-e', code, absoluteHome], shell: false,
        env: { shellpuppet_home: 'wrong-home' }, openViewer: false,
      } });
      expect(response.status).toBe(200);
      const id = String(response.body['id']);
      await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('CLI_OK'));
      const screen = String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']);
      expect(screen).toContain(`HOME:${absoluteHome}`);
      expect(screen).toContain('CLI_OK');
    } finally { await td.stop(); }
  }, 60_000);
  it('limits log text to the caller even when an outside claim cannot message either party', async () => {
    const td = await startTestDaemon({ messaging: { enabled: true, allow: [
      { group: 'chairs', members: ['chair1', 'chair2'] },
    ] } });
    try {
      const claims = await Promise.all(['chair1', 'chair2', 'outsider'].map((name) =>
        api(td.port, td.token, '/messages/claims', { body: { name } })));
      const headers = claims.map((claim) => ({
        'x-shellpuppet-claim': String(claim.body['claimId']),
        'x-shellpuppet-claim-secret': String(claim.body['secret']),
      }));
      expect((await api(td.port, td.token, '/messages', {
        body: { to: 'chair2', text: 'chairs-private-text' }, headers: headers[0],
      })).status).toBe(201);
      const outsider = await api(td.port, td.token, '/messages/log', { headers: headers[2] });
      expect(outsider.status).toBe(200);
      expect(outsider.body['messages']).toEqual([]);
      const filtered = await api(td.port, td.token,
        `/messages/log?participant=${String(claims[0]?.body['claimId'])}`, { headers: headers[2] });
      expect(filtered.status).toBe(403);
      expect(JSON.stringify(filtered.body)).not.toContain('chairs-private-text');
      expect((await api(td.port, td.token, '/messages/log', { headers: headers[0] })).body['messages'])
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: 'chairs-private-text' })]));
    } finally { await td.stop(); }
  });
  it('uses verified parent identity, group policy, claims, waiting and text-free audit', async () => {
    const audit: unknown[] = [];
    const logs: unknown[] = [];
    const td = await startTestDaemon({
      messaging: { enabled: true, allow: [
        'parent-child', { group: 'chairs', members: ['chair1', 'chair2', 'outside'] },
      ] },
      logger: { debug: (...data) => logs.push(data), info: (...data) => logs.push(data),
        warn: (...data) => logs.push(data), error: (...data) => logs.push(data) },
      audit: { captureContent: true, record: (...data) => { audit.push(data); } },
    });
    const events: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${String(td.port)}/events?token=${td.token}`);
    socket.on('message', (data) => events.push(
      Array.isArray(data) ? Buffer.concat(data).toString('utf8') :
        data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data.toString('utf8'),
    ));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const start = async (label: string, headers: Record<string, string> = {}) => {
      const response = await api(td.port, td.token, '/sessions', { body: {
        command: process.execPath, args: ['-e',
          "console.log('TOKEN:'+process.env.SHELLPUPPET_SESSION_TOKEN);console.log('HOME:'+process.env.SHELLPUPPET_HOME);setInterval(()=>{},1000)"],
        shell: false, label, openViewer: false,
      }, headers });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const id = String(response.body['id']);
      await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes(`HOME:${td.home}`));
      const screen = String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']);
      expect(screen).toContain(`HOME:${td.home}`);
      const token = /TOKEN:([A-Za-z0-9_-]+)/.exec(screen)?.[1];
      expect(token).toBeDefined();
      return { id, headers: { 'x-shellpuppet-session': id, 'x-shellpuppet-session-token': token! } };
    };
    try {
      const parent = await start('parent');
      const child = await start('child', parent.headers);
      const chair1 = await start('chair1');
      const chair2 = await start('chair2');
      const reserved = await start('s99');
      const list = await api(td.port, td.token, '/sessions');
      expect(list.body['sessions']).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: child.id, parent: parent.id, name: 'child' }),
        expect.objectContaining({ id: chair1.id, name: 'chair1' }),
        expect.objectContaining({ id: reserved.id, name: reserved.id }),
      ]));
      for (const route of ['/messages/inbox', '/messages/outbox', '/messages/directory',
        '/messages/wait?timeoutMs=1', '/messages/log']) {
        expect((await api(td.port, td.token, route)).status).toBe(403);
      }
      expect((await api(td.port, td.token, '/messages', {
        body: { to: 'parent', text: marker },
      })).status).toBe(403);
      const forged = await api(td.port, td.token, '/messages', { body: {
        to: 'parent', text: marker, from: 'chair1',
      }, headers: child.headers });
      expect(forged.status).toBe(201);
      const inbox = await api(td.port, td.token, '/messages/inbox', { headers: parent.headers });
      const inboxEntries = inbox.body['messages'] as { text: string; from: { id: string; name: string } }[];
      expect(inboxEntries).toHaveLength(1);
      expect(inboxEntries[0]).toMatchObject({ text: marker, from: { id: child.id, name: 'child' } });
      expect((await api(td.port, td.token, '/messages', {
        body: { to: 'parent', text: marker }, headers: child.headers,
      })).status).toBe(201);
      expect((await api(td.port, td.token, '/messages/inbox?markRead=false', {
        headers: parent.headers,
      })).body['messages']).toEqual(expect.arrayContaining([expect.objectContaining({ text: marker })]));
      expect(JSON.stringify(audit)).toContain('"source":"inbox"');
      expect(JSON.stringify(audit)).toContain('"count":1');
      const denied = await api(td.port, td.token, '/messages', { body: { to: 'chair1', text: marker }, headers: child.headers });
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain(marker);
      const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'outside' } });
      expect(claim.status).toBe(201);
      const claimHeaders = { 'x-shellpuppet-claim': String(claim.body['claimId']),
        'x-shellpuppet-claim-secret': String(claim.body['secret']) };
      const wrongClaim = await api(td.port, td.token, '/messages/directory', {
        headers: { ...claimHeaders, 'x-shellpuppet-claim-secret': 'wrong' },
      });
      expect(wrongClaim.status).toBe(403);
      const directory = await api(td.port, td.token, '/messages/directory', { headers: claimHeaders });
      expect(directory.body['participants']).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: chair1.id, name: 'chair1' }),
        expect.objectContaining({ id: chair2.id, name: 'chair2' }),
      ]));
      const pending = api(td.port, td.token, '/messages/wait?timeoutMs=3000', { headers: chair2.headers });
      expect((await api(td.port, td.token, '/messages', { body: { to: 'chair2', text: marker }, headers: chair1.headers })).status).toBe(201);
      expect((await pending).body['message']).toEqual(expect.objectContaining({ text: marker }));
      expect((await api(td.port, td.token, '/messages/wait?from=none&timeoutMs=10', { headers: chair2.headers })).body['message']).toBeNull();
      expect((await api(td.port, td.token, '/messages', {
        body: { to: 'chair1', text: marker }, headers: chair2.headers,
      })).status).toBe(201);
      expect((await api(td.port, td.token, '/messages/inbox', { headers: chair1.headers })).body['messages'])
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: marker })]));
      expect((await api(td.port, td.token, '/messages/log', { headers: chair1.headers })).body['messages'])
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: marker })]));
      expect(JSON.stringify(audit)).toContain('msg-log');
      const fromClaim = await api(td.port, td.token, '/messages', {
        body: { to: 'chair2', text: marker }, headers: claimHeaders,
      });
      expect(fromClaim.status).toBe(201);
      expect((await api(td.port, td.token, `/sessions/${chair2.id}`, { method: 'DELETE' })).status).toBe(200);
      expect((await api(td.port, td.token, '/messages/outbox', { headers: claimHeaders })).body['messages'])
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: fromClaim.body['id'], state: 'not-delivered' })]));
      const toClaim = await api(td.port, td.token, '/messages', { body: { to: 'outside', text: marker }, headers: chair1.headers });
      expect(toClaim.status).toBe(201);
      expect((await api(td.port, td.token, `/messages/claims/${String(claim.body['claimId'])}`, {
        method: 'DELETE', headers: claimHeaders,
      })).status).toBe(200);
      expect((await api(td.port, td.token, '/messages/outbox', { headers: chair1.headers })).body['messages'])
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: toClaim.body['id'], state: 'not-delivered' })]));
      const cliClaim = await api(td.port, td.token, '/messages/claims', { body: { name: 'outside' } });
      const cliEnv = { ...process.env, SHELLPUPPET_HOME: td.home,
        SHELLPUPPET_CLAIM: `${String(cliClaim.body['claimId'])}:${String(cliClaim.body['secret'])}` };
      const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
      const sent = await execFileAsync(process.execPath, [cli, 'msg', 'send', 'chair1', marker], { env: cliEnv });
      expect(sent.stdout).toContain('"id"');
      const cliOutbox = await execFileAsync(process.execPath, [cli, 'msg', 'outbox'], { env: cliEnv });
      expect(cliOutbox.stdout).toContain(marker);
      const cliInbox = await execFileAsync(process.execPath, [cli, 'inbox'], { env: cliEnv });
      expect(cliInbox.stdout).toContain('messages');
      const controlText = '\u001b[2J\u001b[H\u001b[8mhidden\u001b[0m\u001b]0;title\u0007\rswap\u0000';
      expect((await api(td.port, td.token, '/messages', {
        body: { to: 'outside', text: controlText }, headers: chair1.headers,
      })).status).toBe(201);
      const exact = await api(td.port, td.token, '/messages/inbox?markRead=false', {
        headers: { 'x-shellpuppet-claim': String(cliClaim.body['claimId']),
          'x-shellpuppet-claim-secret': String(cliClaim.body['secret']) },
      });
      expect((exact.body['messages'] as { text: string }[]).some((entry) => entry.text === controlText)).toBe(true);
      const printed = await execFileAsync(process.execPath, [cli, 'msg', 'log'], { env: cliEnv });
      expect(printed.stdout).not.toContain('\u001b');
      expect(printed.stdout).not.toContain('\r');
      expect(printed.stdout).toContain('\\\\u001b');
      const claimCommand = await execFileAsync(process.execPath, [cli, 'msg', 'claim', 'temporary'], {
        env: { ...process.env, SHELLPUPPET_HOME: td.home, SHELLPUPPET_CLAIM: '' },
      });
      const exported = /SHELLPUPPET_CLAIM=(claim_[a-f0-9]{32}:[A-Za-z0-9_-]+)/.exec(claimCommand.stdout)?.[1];
      expect(exported).toBeDefined();
      const released = await execFileAsync(process.execPath, [cli, 'msg', 'release'], {
        env: { ...process.env, SHELLPUPPET_HOME: td.home, SHELLPUPPET_CLAIM: exported },
      });
      expect(released.stdout).toContain('released');
      expect(JSON.stringify(audit)).not.toContain(marker);
      expect(JSON.stringify(logs)).not.toContain(marker);
      expect(events.some((event) => event.includes('"type":"message"'))).toBe(true);
      expect(events.some((event) => event.includes('"type":"message-state"'))).toBe(true);
      expect(JSON.stringify(events)).not.toContain(marker);
      expect(JSON.stringify(audit)).toContain('msg-undelivered');
      expect(JSON.stringify(audit)).toContain('msg-read');
    } finally { socket.close(); await td.stop(); }
  }, 180_000);

  it('refuses every messaging route while disabled', async () => {
    const td = await startTestDaemon();
    try {
      for (const route of ['/messages/inbox', '/messages/outbox', '/messages/directory',
        '/messages/wait', '/messages/log']) {
        const response = await api(td.port, td.token, route);
        expect(response.status).toBe(403);
        expect(response.body['error']).toMatch(/off/i);
      }
      const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'chair' } });
      expect(claim.status).toBe(403);
      expect(claim.body['error']).toMatch(/off/i);
      const send = await api(td.port, td.token, '/messages', { body: { to: 'chair', text: marker } });
      expect(send.status).toBe(403);
      expect(send.body['error']).toMatch(/off/i);
      const release = await api(td.port, td.token, '/messages/claims/claim_00000000000000000000000000000000', {
        method: 'DELETE',
      });
      expect(release.status).toBe(403);
      expect(release.body['error']).toMatch(/off/i);
    } finally { await td.stop(); }
  });
});
