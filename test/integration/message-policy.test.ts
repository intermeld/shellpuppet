import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createAuditor } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let daemon: TestDaemon;
let now = 0;
const execFileAsync = promisify(execFile);
let sender: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  const home = makeTempHome('message-policy-');
  daemon = await startTestDaemon({
    home,
    audit: createAuditor(home),
    now: () => now,
    messaging: { enabled: true, claimIdleMinutes: 1,
      allow: [{ group: 'outside', members: ['sender', 'outside', 'idle-target'] }] },
    viewer: { launchMode: 'no-window' },
    idleCheckIntervalMs: 600_000,
  });
  sender = await claim('sender');
});
afterAll(async () => { await daemon.stop(); }, 120_000);

async function claim(name: string): Promise<{ id: string; headers: Record<string, string> }> {
  const response = await api(daemon.port, daemon.token, '/messages/claims', { body: { name } });
  expect(response.status).toBe(201);
  return { id: String(response.body['claimId']), headers: {
    'x-shellpuppet-claim': String(response.body['claimId']),
    'x-shellpuppet-claim-secret': String(response.body['secret']),
  } };
}

describe('message delivery and claims over HTTP', () => {
  it('distinguishes a forbidden live recipient from an absent name', async () => {
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      shell: false, openViewer: false, label: 'helper',
    } });
    expect(started.status).toBe(200);
    const reserved = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      shell: false, openViewer: false, label: 'outside',
    } });
    expect(reserved.status).toBe(200);
    const listed = await api(daemon.port, daemon.token, '/sessions');
    const reservedId = String(reserved.body['id']);
    expect((listed.body['sessions'] as { id: string; name: string; label: string; role: string }[])
      .find((summary) => summary.id === reservedId)).toMatchObject({ name: reservedId, label: reservedId, role: 'delegate' });
    const forbidden = await api(daemon.port, daemon.token, '/messages', { body: { to: 'helper', text: 'hi' }, headers: sender.headers });
    expect(forbidden.status).toBe(403);
    expect(String(forbidden.body['error'])).toContain('sender');
    expect(String(forbidden.body['error'])).toContain('helper');
    const missing = await api(daemon.port, daemon.token, '/messages', { body: { to: 'missing', text: 'hi' }, headers: sender.headers });
    expect(missing.status).toBe(404);
  }, 60_000);

  it('refuses presented session signals but accepts and audits an unmarked member claim', async () => {
    const identityFile = path.join(daemon.home, 'claim-caller.json');
    const code = "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({id:process.env.SHELLPUPPET_SESSION,token:process.env.SHELLPUPPET_SESSION_TOKEN}));setInterval(()=>{},1000)";
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', code, identityFile], shell: false, openViewer: false,
    } });
    expect(started.status).toBe(200);
    await eventually(() => fs.existsSync(identityFile), 15_000);
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8')) as { id: string; token: string };
    const marked = await api(daemon.port, daemon.token, '/messages/claims', {
      body: { name: 'outside' }, headers: { 'x-shellpuppet-inside-session': '1' },
    });
    expect(marked.status).toBe(409);
    expect(String(marked.body['error'])).toMatch(/^This request is marked as coming from inside a ShellPuppet session/);
    expect(String(marked.body['error'])).not.toMatch(/already holds a messaging claim/);
    const second = await api(daemon.port, daemon.token, '/messages/claims', {
      body: { name: 'another' }, headers: sender.headers,
    });
    expect(second.status).toBe(409);
    expect(String(second.body['error'])).toMatch(/^This client already holds a messaging claim/);
    expect(String(second.body['error'])).not.toMatch(/marked as coming from inside/);
    const both = await api(daemon.port, daemon.token, '/messages/claims', {
      body: { name: 'another' }, headers: { ...sender.headers, 'x-shellpuppet-inside-session': '1' },
    });
    expect(both.status).toBe(409);
    expect(String(both.body['error'])).toMatch(/already holds a messaging claim.*marked as coming from inside/);
    const verified = await api(daemon.port, daemon.token, '/messages/claims', {
      body: { name: 'outside' }, headers: {
        'x-shellpuppet-session': identity.id, 'x-shellpuppet-session-token': identity.token,
      },
    });
    expect(verified.status).toBe(409);
    expect(verified.body['error']).toBe('This session already messages under its own name.');
    const unmarked = await api(daemon.port, daemon.token, '/messages/claims', { body: { name: 'outside' } });
    expect(unmarked.status).toBe(201);
    const directory = await api(daemon.port, daemon.token, '/messages/directory', { headers: sender.headers });
    expect(directory.body['participants']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unmarked.body['claimId'], name: 'outside', kind: 'claim' }),
    ]));
    const sent = await api(daemon.port, daemon.token, '/messages', {
      body: { to: 'outside', text: 'visible' }, headers: sender.headers,
    });
    expect(sent.status).toBe(201);
    const audit = fs.readFileSync(path.join(daemon.home, 'audit.log'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { action: string; meta?: Record<string, unknown> });
    const memberClaim = audit.find((entry) => entry.action === 'msg-claim' && entry.meta?.['fromName'] === 'outside');
    expect(memberClaim?.meta?.['member']).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(String(unmarked.body['secret']));
  }, 60_000);

  it('lapses an idle claim, frees its name and reports not delivered', async () => {
    const outside = await claim('idle-target');
    const sent = await api(daemon.port, daemon.token, '/messages', {
      body: { to: 'idle-target', text: 'unread' }, headers: sender.headers,
    });
    expect(sent.status).toBe(201);
    expect(sent.body['state']).toBe('waiting');
    now = 30_000;
    expect((await api(daemon.port, daemon.token, '/messages/directory', { headers: sender.headers })).status).toBe(200);
    now = 60_001;
    const outbox = await api(daemon.port, daemon.token, '/messages/outbox', { headers: sender.headers });
    expect(outbox.status).toBe(200);
    expect((outbox.body['messages'] as { state: string }[]).at(-1)?.state).toBe('not-delivered');
    expect(fs.readFileSync(path.join(daemon.home, 'audit.log'), 'utf8')).toContain('"action":"msg-undelivered"');
    const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
    const cliEnv: NodeJS.ProcessEnv = { ...process.env, SHELLPUPPET_HOME: daemon.home,
      SHELLPUPPET_CLAIM: `${sender.id}:${sender.headers['x-shellpuppet-claim-secret']}` };
    delete cliEnv['SHELLPUPPET_SESSION'];
    delete cliEnv['SHELLPUPPET_SESSION_TOKEN'];
    delete cliEnv['SHELLPUPPET_DAEMON_INSTANCE'];
    const printed = await execFileAsync(process.execPath, [cli, 'msg', 'outbox', '--json'], {
      env: cliEnv,
    });
    expect(printed.stdout).toContain('"not-delivered"');
    const inSessionEnv: NodeJS.ProcessEnv = { ...process.env, SHELLPUPPET_HOME: daemon.home,
      SHELLPUPPET_SESSION: 's-without-proof', SHELLPUPPET_CLAIM: '' };
    delete inSessionEnv['SHELLPUPPET_SESSION_TOKEN'];
    delete inSessionEnv['SHELLPUPPET_DAEMON_INSTANCE'];
    await expect(execFileAsync(process.execPath, [cli, 'msg', 'claim', 'never'], { env: inSessionEnv }))
      .rejects.toThrow(/own name/);
    const missingSessionEnv: NodeJS.ProcessEnv = { ...inSessionEnv,
      SHELLPUPPET_SESSION_TOKEN: 'session-proof-without-id' };
    delete missingSessionEnv['SHELLPUPPET_SESSION'];
    await expect(execFileAsync(process.execPath, [cli, 'msg', 'claim', 'still-never'], {
      env: missingSessionEnv,
    })).rejects.toThrow(/own name/);
    const absent = await api(daemon.port, daemon.token, '/messages', {
      body: { to: 'idle-target', text: 'late' }, headers: sender.headers,
    });
    expect(absent.status).toBe(404);
    expect((await claim('idle-target')).id).not.toBe(outside.id);
  });
});
