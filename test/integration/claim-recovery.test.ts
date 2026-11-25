import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAuditor } from '../../src/daemon/audit.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon, type TestDaemon } from './helpers.js';

const exec = promisify(execFile);
const minute = 60_000;
const refusal = 'Messaging claim was not recognised.';
const launchRefusal = 'Session launch permission required.';
const hint = 'Claim the name again, using --replace if it is still held.';
const heldName = 'That participant name is already held.';

function headersFor(body: Record<string, unknown>) {
  return { 'x-shellpuppet-claim': String(body['claimId']), 'x-shellpuppet-claim-secret': String(body['secret']) };
}

function events(td: TestDaemon, headers?: Record<string, string>) {
  return new WebSocket(`ws://127.0.0.1:${String(td.port)}/events?token=${td.token}`, { headers });
}

async function refusedUpgrade(td: TestDaemon, headers: Record<string, string>) {
  const ws = events(td, headers);
  return new Promise<{ status?: number; reason?: string; hint?: string | string[] }>((resolve, reject) => {
    ws.on('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      ws.terminate();
      resolve({ status: res.statusCode, reason: res.statusMessage, hint: res.headers['x-shellpuppet-hint'] });
    });
    ws.once('open', () => { ws.terminate(); reject(new Error('Expected the claim to be refused.')); });
  });
}

function fixture() {
  const home = makeTempHome();
  const settings = {
    viewer: { launchMode: 'no-window' },
    messaging: { enabled: true, allow: [{ group: 'sample', members: ['peer', 'desk'] }] },
    launcher: { sessionLaunch: ['desk', 'spare'], profiles: [
      { name: 'sample', command: process.execPath, args: ['-e', '0'], cwd: home, shell: false },
    ] },
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(settings));
  const { config, problems } = parseDaemonConfig(settings);
  expect(problems).toEqual([]);
  let now = Date.UTC(2026, 0, 1);
  const options = { home, idleCheckIntervalMs: 600_000, now: () => now, messaging: config.messaging, viewer: config.viewer,
    launchProfiles: config.launcher, audit: createAuditor(home) };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('SHELLPUPPET_')) env[key] = value;
  }
  env['SHELLPUPPET_HOME'] = home;
  const cli = (args: string[], proof?: string) => exec(process.execPath,
    [join(repoRoot, 'dist', 'cli', 'index.js'), ...args],
    { env: { ...env, SHELLPUPPET_CLAIM: proof ?? '' } });
  return { home, options, env, cli, advance: (ms: number) => { now += ms; } };
}

it('keeps a CLI claim active through 31 minutes of messaging silence', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  try {
    const result = await f.cli(['msg', 'claim', 'desk']);
    const proof = /^SHELLPUPPET_CLAIM=(\S+)$/m.exec(result.stdout)?.[1];
    expect(typeof proof).toBe('string');
    for (const elapsed of [0, 15, 16]) {
      f.advance(elapsed * minute);
      const launched = await f.cli(['launch', 'sample'], proof);
      expect(launched.stdout).toMatch(/Started session/);
    }
  } finally { await td.stop(); }
}, 180_000);

it('recovers a lost CLI code and restores only the replacement after restart', async () => {
  const f = fixture();
  let td = await startTestDaemon(f.options);
  try {
    const original = await f.cli(['msg', 'claim', 'desk']);
    const first = /^SHELLPUPPET_CLAIM=(\S+)$/m.exec(original.stdout)?.[1];
    expect(typeof first).toBe('string');
    const conflict = await api(td.port, td.token, '/messages/claims', { body: { name: 'desk' } });
    expect(conflict.status).toBe(409);
    const recovered = await f.cli(['msg', 'claim', 'desk', '--replace']);
    const second = /^SHELLPUPPET_CLAIM=(\S+)$/m.exec(recovered.stdout)?.[1];
    expect(typeof second).toBe('string');
    expect(first === second).toBe(false);
    expect(recovered.stdout.includes('--replace')).toBe(true);
    expect(recovered.stdout.includes('PowerShell:')).toBe(true);
    expect(recovered.stdout.includes('POSIX shell:')).toBe(true);
    expect(conflict.body).toEqual({ error: heldName, hint: 'Recover it with msg claim desk --replace or replace: true on session_claim.' });

    const [oldId, oldSecret] = first!.split(':') as [string, string];
    const [newId, newSecret] = second!.split(':') as [string, string];
    const audit = readFileSync(join(f.home, 'audit.log'), 'utf8');
    const replacement = audit.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
      action: string; actor: string; meta: Record<string, unknown> }).find(row => row.action === 'msg-replace');
    expect(replacement).toMatchObject({ actor: 'cli', meta: { name: 'desk', oldClaimId: oldId, newClaimId: newId } });
    const saved = readFileSync(join(f.home, 'launcher-claims.json'), 'utf8');
    const records = JSON.parse(saved) as { id: string; digest: string }[];
    expect(records.map(row => row.id)).toEqual([newId]);
    expect(records[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect([oldSecret, newSecret].some(secret => (saved + audit).includes(secret))).toBe(false);

    const launch = (id: string, secret: string) => api(td.port, td.token, '/launcher/launch', {
      headers: { 'x-shellpuppet-claim': id, 'x-shellpuppet-claim-secret': secret }, body: { profile: 'sample' },
    });
    expect((await launch(oldId, oldSecret)).status).toBe(403);
    f.advance(20 * minute);
    expect((await launch(newId, newSecret)).status).toBe(200);
    await td.daemon.stop();
    f.advance(11 * minute);
    td = await startTestDaemon(f.options);
    expect((await launch(oldId, oldSecret)).status).toBe(403);
    expect((await launch(newId, newSecret)).status).toBe(200);
    await f.cli(['msg', 'release'], second);
    expect(JSON.parse(readFileSync(join(f.home, 'launcher-claims.json'), 'utf8'))).toEqual([]);
  } finally { await td.stop(); }
}, 180_000);

it('returns the original launch and release results for an expired ordinary MCP claim', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const client = new Client({ name: 'sample-client', version: '1' });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(repoRoot, 'dist', 'mcp', 'index.js')], env: f.env, stderr: 'pipe' }));
    expect((await call('session_claim', { name: 'desk' })).isError).toBeFalsy();
    f.advance(30 * minute);
    const launch = await call('terminal_start', { profile: 'sample' });
    expect(launch.isError).toBe(true);
    expect((launch.content as { text: string }[])[0]).toEqual({ type: 'text', text: launchRefusal });
    const release = await call('session_release');
    expect(release.isError).toBe(true);
    expect((release.content as { text: string }[])[0]).toEqual({ type: 'text', text: 'Not a messaging participant.' });
    expect((await call('session_release')).content).toEqual([{ type: 'text', text: 'No claim is held.' }]);
  } finally {
    try { await client.close(); } finally { await td.stop(); }
  }
}, 120_000);

const comparisonAdapter = process.env['SHELLPUPPET_TEST_MCP_ENTRY'];
const adapters = [{ label: 'current', entry: join(repoRoot, 'dist', 'mcp', 'index.js') }];
if (comparisonAdapter) adapters.push({ label: 'comparison', entry: comparisonAdapter });

it.each(adapters)('clears an expired ordinary claim before release with the $label MCP adapter', async ({ entry }) => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const client = new Client({ name: 'sample-client', version: '1' });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: f.env, stderr: 'pipe' }));
    expect((await call('session_claim', { name: 'desk' })).isError).toBeFalsy();
    f.advance(30 * minute);
    const directory = await call('session_directory');
    expect(directory.isError).toBe(true);
    expect((directory.content as { text: string }[])[0]).toEqual({ type: 'text', text: 'Not a messaging participant.' });
    const release = await call('session_release');
    expect(release.isError).toBeFalsy();
    expect(release.content).toEqual([{ type: 'text', text: 'No claim is held.' }]);
  } finally {
    try { await client.close(); } finally { await td.stop(); }
  }
}, 120_000);

it('uses an MCP replacement from memory for launches and gives a fixed recovery hint', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const client = new Client({ name: 'sample-client', version: '1' });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(repoRoot, 'dist', 'mcp', 'index.js')], env: f.env, stderr: 'pipe' }));
    await f.cli(['msg', 'claim', 'desk']);
    const conflict = await call('session_claim', { name: 'desk' });
    const recovered = await call('session_claim', { name: 'desk', replace: true });
    expect(recovered.isError).toBeFalsy();
    expect(conflict).toMatchObject({ isError: true, content: [
      { type: 'text', text: heldName }, { type: 'text', text: 'Recover it with msg claim desk --replace or replace: true on session_claim.' },
    ] });
    expect(recovered.content).toEqual([{ type: 'text', text: 'Claimed desk.' }]);
    expect((await call('terminal_start', { profile: 'sample' })).isError).toBeFalsy();
    f.advance(30 * minute);
    const lapsed = await call('terminal_start', { profile: 'sample' });
    expect(lapsed.isError).toBe(true);
    expect(lapsed.content).toEqual([{ type: 'text', text: launchRefusal }, { type: 'text', text: hint }]);
    expect((await call('session_claim', { name: 'ordinary' })).isError).toBeFalsy();
    const refused = await call('terminal_start', { profile: 'sample' });
    expect(refused.content).toEqual([{ type: 'text', text: 'Session launch permission required.' }]);
    expect((await call('session_release')).isError).toBeFalsy();
  } finally {
    try { await client.close(); } finally { await td.stop(); }
  }
}, 120_000);

it('requires an outside caller, protects session names and applies the creation limits to replacements', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const claim = (name: string, replace = false, headers?: Record<string, string>) =>
    api(td.port, td.token, '/messages/claims', { body: { name, replace }, headers });
  try {
    const original = await claim('desk');
    expect(original.status).toBe(201);
    const headers = { 'x-shellpuppet-claim': String(original.body['claimId']),
      'x-shellpuppet-claim-secret': String(original.body['secret']) };
    const wrong = { ...headers, 'x-shellpuppet-claim-secret': 'incorrect-private-proof' };
    for (const route of ['/messages/inbox', '/launcher/previous']) {
      const refused = await api(td.port, td.token, route, { headers: wrong });
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: route.startsWith('/launcher/') ? launchRefusal : refusal, code: 'invalid-claim', hint });
      expect(String(refused.body['error']).includes(wrong['x-shellpuppet-claim-secret'])).toBe(false);
    }
    expect((await claim('desk', true, headers)).status).toBe(409);
    expect((await claim('desk', true, { 'x-shellpuppet-inside-session': '1' })).status).toBe(409);
    expect((await claim('desk', true, { 'x-shellpuppet-session': 'absent' })).status).toBe(403);
    const session = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: ['-e',
        "try { require('node:child_process').execFileSync(process.execPath, [process.env.SHELLPUPPET_CLI, " +
        "'msg', 'claim', 'desk', '--replace'], {stdio:'pipe'}) } catch (e) { console.log(String(e.stderr)) } " +
        "setInterval(() => {}, 1000)"], label: 'station',
      shell: false, openViewer: false,
    } });
    expect(session.status).toBe(200);
    const id = String(session.body['id']);
    await eventually(async () => {
      const snap = await api(td.port, td.token, `/sessions/${id}/snapshot`);
      return String(snap.body['screen']).includes('This session already messages under its own name');
    });
    const held = await claim('station', true);
    expect(held.status).toBe(409);
    expect(held.body).toEqual({ error: heldName, hint: 'That participant name is unavailable.' });
    expect((await claim(id, true)).status).toBe(400);

    for (let i = 0; i < 7; i++) expect((await claim('desk', true)).status).toBe(201);
    const throttled = await claim('desk', true);
    expect(throttled.status).toBe(429);
    expect(throttled.body['error']).toMatch(/rate/);
    for (let i = 1; i < 64; i++) {
      if ((i - 1) % 8 === 0) f.advance(minute);
      expect((await claim(`slot-${String(i)}`)).status).toBe(201);
    }
    f.advance(minute);
    const capped = await claim('desk', true);
    expect(capped.status).toBe(429);
    expect(capped.body['error']).toMatch(/64 live claims/);
  } finally { await td.stop(); }
}, 120_000);

it('refreshes on previous-session lookup and events admission, then revokes the old event stream', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  let ws: WebSocket | undefined;
  try {
    const original = await api(td.port, td.token, '/messages/claims', { body: { name: 'desk' } });
    const headers = { 'x-shellpuppet-claim': String(original.body['claimId']),
      'x-shellpuppet-claim-secret': String(original.body['secret']) };
    f.advance(20 * minute);
    expect((await api(td.port, td.token, '/launcher/previous', { headers })).status).toBe(409);
    f.advance(20 * minute);
    ws = new WebSocket(`ws://127.0.0.1:${String(td.port)}/events?token=${td.token}`, { headers });
    await once(ws, 'open');
    f.advance(20 * minute);
    const conflict = await api(td.port, td.token, '/messages/claims', { body: { name: 'desk' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body['hint']).toContain('msg claim desk --replace');
    const closed = once(ws, 'close');
    const replacement = await api(td.port, td.token, '/messages/claims', { body: { name: 'desk', replace: true } });
    expect(replacement.status).toBe(201);
    await closed;
    const stale = await api(td.port, td.token, '/messages/inbox', { headers });
    expect(stale.status).toBe(403);
    expect(stale.body['error']).toBe(refusal);
  } finally { ws?.terminate(); await td.stop(); }
});

it('leaves the saved proof, unread inbox and live stream intact when the required audit append fails', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const issue = (name: string, replace = false) => api(td.port, td.token, '/messages/claims', { body: { name, replace } });
  const audit = join(f.home, 'audit.log');
  const saved = join(f.home, 'launcher-claims.json');
  let ws: WebSocket | undefined;
  try {
    const old = headersFor((await issue('desk')).body);
    const peer = headersFor((await issue('peer')).body);
    const send = (text: string) => api(td.port, td.token, '/messages', { headers: peer, body: { to: 'desk', text } });
    expect((await send('before')).status).toBe(201);
    ws = events(td, old);
    const delivered = new Set<string>();
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as { type: string; id?: string };
      if (frame.type === 'message' && frame.id) delivered.add(frame.id);
    });
    await once(ws, 'open');
    const diskBefore = readFileSync(saved, 'utf8');
    renameSync(audit, audit + '.saved');
    mkdirSync(audit);
    try {
      for (const name of ['desk', 'peer']) {
        const response = await issue(name, true);
        expect(response.status).toBe(503);
        expect(response.body['error']).toMatch(/audit record/);
        expect(response.body).not.toHaveProperty('secret');
      }
    } finally {
      rmdirSync(audit);
      renameSync(audit + '.saved', audit);
    }
    expect(readFileSync(saved, 'utf8')).toBe(diskBefore);
    expect(readFileSync(audit, 'utf8')).not.toContain('"msg-replace"');
    const sent = await send('after');
    expect(sent.status).toBe(201);
    await eventually(() => delivered.has(String(sent.body['id'])));
    const inbox = await api(td.port, td.token, '/messages/inbox?markRead=false', { headers: old });
    expect(inbox.body['messages']).toMatchObject([{ text: 'before' }, { text: 'after' }]);
    const closed = once(ws, 'close');
    const fresh = await issue('desk', true);
    expect(fresh.status).toBe(201);
    await closed;
    expect((await api(td.port, td.token, '/messages/inbox', { headers: old })).status).toBe(403);
    expect((await api(td.port, td.token, '/messages/inbox', { headers: headersFor(fresh.body) })).body['messages'])
      .toMatchObject([{ text: 'before' }, { text: 'after' }]);
  } finally { ws?.terminate(); await td.stop(); }
}, 120_000);

it('gives the same refusal for every unverified claim on messaging, launch, previous and events', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const claim = async (name: string) => headersFor((await api(td.port, td.token, '/messages/claims', { body: { name } })).body);
  try {
    const expired = await claim('earlier');
    f.advance(15 * minute);
    const live = await claim('desk');
    td.daemon['mailbox'].register({ kind: 'session', id: 's71', name: 'station' });
    f.advance(15 * minute);
    const id = 'x-shellpuppet-claim';
    for (const headers of [expired, { ...expired, [id]: live[id] }, { ...expired, [id]: 's71' },
      { ...expired, [id]: 'claim_00000000000000000000000000000000' }]) {
      for (const path of ['/messages/inbox', '/launcher/previous', '/launcher/launch']) {
        const result = await api(td.port, td.token, path, { headers, body: path.endsWith('launch') ? { profile: 'sample' } : undefined });
        expect(result.status).toBe(403);
        expect(result.body).toEqual({ error: path.startsWith('/launcher/') ? launchRefusal : refusal, code: 'invalid-claim', hint });
      }
      expect(await refusedUpgrade(td, headers)).toEqual({ status: 403, reason: 'Forbidden', hint });
    }
    const mismatch = await api(td.port, td.token, '/messages/claims/other', { headers: live, method: 'DELETE' });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body).toEqual({ error: 'The matching claim is required.', hint });
  } finally { await td.stop(); }
});

it('accepts marked messaging and events, refuses marked launch and leaves the idle deadline intact', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  let ws: WebSocket | undefined;
  try {
    const releasable = await api(td.port, td.token, '/messages/claims', { body: { name: 'spare' } });
    f.env['SHELLPUPPET_SESSION'] = 's71';
    const cliProof = `${String(releasable.body['claimId'])}:${String(releasable.body['secret'])}`;
    expect((await f.cli(['msg', 'release'], cliProof)).stdout).toContain('released');
    expect((await api(td.port, td.token, '/messages/claims', { body: { name: 'spare' } })).status).toBe(201);
    const proof = headersFor((await api(td.port, td.token, '/messages/claims', { body: { name: 'desk' } })).body);
    const headers = { ...proof, 'x-shellpuppet-inside-session': '1' };
    f.advance(29 * minute);
    expect((await api(td.port, td.token, '/messages/inbox', { headers })).status).toBe(200);
    expect((await api(td.port, td.token, '/messages/wait?timeoutMs=1', { headers })).status).toBe(200);
    ws = events(td, headers);
    await once(ws, 'open');
    for (const path of ['/launcher/launch', '/launcher/previous']) {
      const result = await api(td.port, td.token, path, { headers, body: path.endsWith('launch') ? { profile: 'sample' } : undefined });
      expect(result.status).toBe(403);
      expect(result.body['error']).toBe(launchRefusal);
    }
    const creation = await api(td.port, td.token, '/messages/claims', { headers, body: { name: 'desk', replace: true } });
    expect(creation.status).toBe(409);
    f.advance(minute);
    const closed = once(ws, 'close');
    expect((await api(td.port, td.token, '/messages/inbox', { headers: proof })).status).toBe(403);
    await closed;
  } finally { ws?.terminate(); await td.stop(); }
}, 120_000);

it('counts failed ordinary and replacement writes towards the original creation rate', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const issue = (name: string, replace = false) => api(td.port, td.token, '/messages/claims', { body: { name, replace } });
  const file = join(f.home, 'launcher-claims.json');
  try {
    const old = headersFor((await issue('desk')).body);
    f.advance(minute);
    renameSync(file, file + '.saved');
    mkdirSync(file);
    try {
      for (let i = 0; i < 4; i++) {
        expect((await issue('spare')).status).toBe(500);
        expect((await issue('desk', true)).status).toBe(500);
      }
    } finally {
      rmdirSync(file);
      renameSync(file + '.saved', file);
    }
    expect((await issue('spare')).status).toBe(429);
    expect((await issue('desk', true)).status).toBe(429);
    expect((await api(td.port, td.token, '/messages/inbox', { headers: old })).status).toBe(200);
    f.advance(minute);
    expect((await issue('spare')).status).toBe(201);
  } finally { await td.stop(); }
}, 120_000);

it('checks expiry after a slow claim body only for replacement and leaves token-only upgrades passive', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  const issue = (name: string) => api(td.port, td.token, '/messages/claims', { body: { name } });
  let observer: WebSocket | undefined;
  let holder: WebSocket | undefined;
  // Deliver the headers before the deadline and the body exactly at the deadline.
  async function acrossDeadline(replace: boolean) {
    const arrived = once(td.daemon['server'], 'request');
    const req = request({ hostname: '127.0.0.1', port: td.port, path: '/messages/claims', method: 'POST',
      headers: { authorization: `Bearer ${td.token}`, 'content-type': 'application/json' } });
    const response = once(req, 'response');
    try {
      req.flushHeaders();
      await arrived;
      f.advance(minute);
      req.end(JSON.stringify({ name: 'desk', replace }));
      const [res] = await response as [import('node:http').IncomingMessage];
      res.resume();
      await once(res, 'end');
      return res.statusCode;
    } finally { req.destroy(); }
  }
  try {
    const desk = headersFor((await issue('desk')).body);
    const peer = headersFor((await issue('peer')).body);
    const first = await api(td.port, td.token, '/messages', { headers: peer, body: { to: 'desk', text: 'pending' } });
    holder = events(td, desk);
    await once(holder, 'open');
    f.advance(29 * minute);
    expect(await acrossDeadline(false)).toBe(409);
    observer = events(td);
    await once(observer, 'open');
    const box = td.daemon['mailbox'];
    expect(box.log().find(m => m.id === first.body['id'])?.state).toBe('waiting');
    expect(box.participant(desk['x-shellpuppet-claim'])).toBeDefined();
    const closed = once(holder, 'close');
    expect((await issue('desk')).status).toBe(201);
    await closed;
    expect(box.log().find(m => m.id === first.body['id'])?.state).toBe('not-delivered');

    const sender = headersFor((await issue('peer')).body);
    const second = await api(td.port, td.token, '/messages', { headers: sender, body: { to: 'desk', text: 'later' } });
    f.advance(29 * minute);
    expect(await acrossDeadline(true)).toBe(201);
    expect(box.log().find(m => m.id === second.body['id'])?.state).toBe('not-delivered');
  } finally { observer?.terminate(); holder?.terminate(); await td.stop(); }
}, 120_000);

it('prints the named option and accepts either spelling for names beginning with a hyphen', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  try {
    for (const name of ['-desk', '--desk']) {
      const original = await f.cli(['msg', 'claim', '--', name]);
      const oldProof = /^SHELLPUPPET_CLAIM=(\S+)$/m.exec(original.stdout)?.[1];
      expect(typeof oldProof).toBe('string');
      const conflict = await api(td.port, td.token, '/messages/claims', { body: { name } });
      const command = `msg claim --replace --name=${name}`;
      expect(conflict.body['hint']).toContain(command);
      const { stdout } = await f.cli(command.split(' '));
      expect(stdout.includes(command)).toBe(true);
      const fresh = /^SHELLPUPPET_CLAIM=(\S+)$/m.exec(stdout)?.[1];
      expect(typeof fresh).toBe('string');
      expect((await f.cli(['msg', 'release'], fresh)).stdout).toContain('released');
      const stderr = await f.cli(['msg', 'inbox'], oldProof).then(() => '', (error: { stderr: string }) => error.stderr);
      expect(stderr).toContain(`${refusal}\n${hint}`);
    }
  } finally { await td.stop(); }
}, 120_000);

it.skipIf(process.platform !== 'win32')('recovers --desk through the installed PowerShell and cmd shims', async () => {
  const f = fixture();
  const td = await startTestDaemon(f.options);
  try {
    const prefix = join(f.home, 'npm-prefix');
    await exec('cmd.exe', ['/d', '/c', 'npm.cmd link --offline --ignore-scripts --no-audit --no-fund'], {
      cwd: repoRoot, env: { ...f.env, npm_config_prefix: prefix, npm_config_cache: join(f.home, 'npm-cache'),
        npm_config_update_notifier: 'false' },
    });
    const powershell = await exec('where.exe', ['pwsh.exe']).then(() => 'pwsh.exe', () => 'powershell.exe');
    const original = await f.cli(['msg', 'claim', '--name=--desk']);
    const command = /run shellpuppet (msg claim \S+ \S+) to obtain/.exec(original.stdout)?.[1];
    expect(command).toBe('msg claim --replace --name=--desk');
    const stderr = await f.cli(['msg', 'claim', '--name=--desk']).then(() => '', (error: { stderr: string }) => error.stderr);
    expect(stderr).toContain(`${heldName}\nRecover it with ${command}`);
    const options = { cwd: prefix, env: f.env };
    const ps = await exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
      '-Command', `.\\shellpuppet.ps1 ${command}; exit $LASTEXITCODE`], options);
    expect(ps.stdout.includes(`shellpuppet ${command}`)).toBe(true);
    const cmd = await exec('cmd.exe', ['/d', '/c', `.\\shellpuppet.cmd ${command}`], options);
    const proof = /^SHELLPUPPET_CLAIM=(\S+)$/m.exec(cmd.stdout)?.[1];
    expect(typeof proof).toBe('string');
    expect((await f.cli(['msg', 'release'], proof)).stdout).toContain('released');
  } finally { await td.stop(); }
}, 120_000);
