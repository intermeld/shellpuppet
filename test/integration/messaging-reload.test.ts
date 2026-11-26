import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createAuditor } from '../../src/daemon/audit.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import type { TestDaemon } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { readDaemonState } from '../../src/daemon/paths.js';
import { api, eventually, makeTempHome, removeTempHome, repoRoot, distDaemonEntry, startTestDaemon } from './helpers.js';

it('applies group addition and removal to the same connected caller, claims and live session', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  const save = (both: boolean, enabled = true) => {
    fs.writeFileSync(file + '.new', JSON.stringify({ viewer: { launchMode: 'no-window' },
      messaging: { enabled, allow: [{ group: 'work', members: both ? ['desk', 'peer'] : ['peer'] }] } }));
    fs.renameSync(file + '.new', file);
  };
  save(false);
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined && !e[0].toUpperCase().startsWith('SHELLPUPPET_')));
  env['SHELLPUPPET_HOME'] = home;
  const child = spawn(process.execPath, [distDaemonEntry], { env, stdio: 'ignore', windowsHide: true });
  const ended = once(child, 'exit');
  const client = new Client({ name: 'reload-test', version: '1' });
  try {
    await eventually(() => readDaemonState(home) !== null);
    const state = readDaemonState(home)!;
    const { port, token } = state;
    const start = await api(port, token, '/sessions', { body: { command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], shell: false, openViewer: false } });
    expect(start.status).toBe(200);
    const claim = async (name: string) => {
      const response = await api(port, token, '/messages/claims', { body: { name } });
      expect(response.status).toBe(201);
      return { 'x-shellpuppet-claim': String(response.body['claimId']), 'x-shellpuppet-claim-secret': String(response.body['secret']) };
    };
    const desk = await claim('desk');
    const peer = await claim('peer');
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'dist/cli/index.js'), 'mcp'],
      env: { ...env, SHELLPUPPET_CLAIM: desk['x-shellpuppet-claim'] + ':' + desk['x-shellpuppet-claim-secret'] } }));
    const directory = async () => JSON.stringify((await client.callTool({ name: 'session_directory', arguments: {} })).content);
    const send = () => client.callTool({ name: 'session_send', arguments: { to: 'peer', text: 'hello' } });
    const inbox = () => api(port, token, '/messages/inbox?markRead=false', { headers: peer });
    expect(await directory()).not.toContain('peer');
    expect((await send()).isError).toBe(true);
    save(true);
    await eventually(async () => (await directory()).includes('peer'), 3000);
    expect((await send()).isError).not.toBe(true);
    expect((await inbox()).body['messages']).toMatchObject([{ text: 'hello' }]);
    fs.writeFileSync(file, JSON.stringify({ messaging: { enabled: false }, mcp: { untrustedFraming: 'invalid' } }));
    await eventually(async () => ((await api(port, token, '/environment')).body['configReload'] as { outcome: string }).outcome === 'rejected');
    const attached = new Client({ name: 'attached-test', version: '1' });
    try {
      await attached.connect(new StdioClientTransport({ command: process.execPath,
        args: [join(repoRoot, 'dist/cli/index.js'), 'mcp'], env }));
      expect((await attached.listTools()).tools.some(tool => tool.name === 'session_directory')).toBe(true);
    } finally { await attached.close(); }
    save(false);
    await eventually(async () => !(await directory()).includes('peer'), 3000);
    expect(JSON.stringify((await send()).content)).toContain('not allowed by messaging.allow');
    expect((await inbox()).body['messages']).toEqual([]);
    save(true);
    await eventually(async () => JSON.stringify((await inbox()).body).includes('hello'), 3000);
    await api(port, token, '/messages/inbox', { headers: peer });
    const waiting = api(port, token, '/messages/wait?timeoutMs=6000', { headers: peer });
    save(true, false);
    expect((await waiting).status).toBe(403);
    expect((await inbox()).status).toBe(403);
    expect((await api(port, token, '/messages/claims/' + peer['x-shellpuppet-claim'], { method: 'DELETE', headers: peer })).status).toBe(200);
    expect(readDaemonState(home)).toMatchObject({ instanceId: state.instanceId, pid: child.pid });
    expect((await api(port, token, '/sessions')).body['sessions']).toMatchObject([{ id: start.body['id'] }]);
  } finally {
    await client.close();
    const state = readDaemonState(home);
    if (state) await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } });
    else child.kill();
    await ended;
    removeTempHome(home);
  }
}, 90_000);

it('revokes an already allowed pair and settles its filtered waiter on the same proofs', async () => {
  const messaging = { enabled: true, allow: [{ group: 'work', members: ['first', 'second'] }] };
  const home = makeTempHome();
  const file = join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ messaging }));
  const td = await startTestDaemon({ home, messaging });
  try {
    const claims = await Promise.all(['first', 'second'].map(async name => {
      const { body } = await api(td.port, td.token, '/messages/claims', { body: { name } });
      return { 'x-shellpuppet-claim': String(body['claimId']), 'x-shellpuppet-claim-secret': String(body['secret']) };
    }));
    const send = () => api(td.port, td.token, '/messages', { headers: claims[0], body: { to: 'second', text: 'queued' } });
    expect((await send()).status).toBe(201);
    const waiting = api(td.port, td.token, '/messages/wait?from=second&timeoutMs=6000', { headers: claims[0] });
    void waiting.catch(() => undefined);
    fs.writeFileSync(file, JSON.stringify({ messaging: { enabled: true, allow: [] } }));
    await eventually(async () => {
      const { body } = await api(td.port, td.token, '/messages/directory', { headers: claims[0] });
      return Array.isArray(body['participants']) && body['participants'].length === 0;
    }, 3000);
    expect((await send()).status).toBe(403);
    expect((await waiting).body['message']).toBe(null);
    expect((await api(td.port, td.token, '/messages/log', { headers: claims[1] })).body['messages']).toEqual([]);
  } finally { await td.stop(); }
});

it('shares the rolling allowance and pending reservations across both launch routes, and suspends outside grants on disable', async () => {
  const home = makeTempHome();
  const file = join(home, 'config.json');
  const profile = { name: 'sample', command: process.execPath, args: ['-e', '0'], shell: false };
  const settings = (rate: number, enabled = true, claimIdleMinutes = 30) => ({ launcher: { profiles: [profile], sessionLaunch: ['desk'], launchesPerMinute: rate },
    messaging: { enabled, claimIdleMinutes, allow: [{ group: 'work', members: ['desk'] }] } });
  const save = (rate: number, enabled = true, ttl = 30) => fs.writeFileSync(file, JSON.stringify(settings(rate, enabled, ttl)));
  save(2);
  const { config } = parseDaemonConfig(settings(2));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let created = 0;
  let now = 1000;
  const td: TestDaemon = await startTestDaemon({ home, messaging: config.messaging, launchProfiles: config.launcher, now: () => now,
    audit: createAuditor(home),
    dashboardSessionFactory: options => {
      const session = td.daemon['manager'].create(options);
      if (++created === 1) {
        const original = session.startedProgramPid.bind(session);
        session.startedProgramPid = async () => { await gate; return original(); };
      }
      return session;
    },
  });
  const tokens = td.daemon['tokens'];
  const cookie = 'sp_dash=' + tokens.redeemDashboardGrant(tokens.mintDashboardGrant())!.token;
  const proof = tokens.issueDashboardProof()!;
  const origin = 'http://127.0.0.1:' + String(td.port);
  const dashboardHeaders = { cookie, origin, 'x-shellpuppet-csrf': proof, 'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/dashboard/events', ['sp-csrf.' + proof],
    { headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket' } });
  const changes: Record<string, unknown>[] = [];
  socket.on('message', data => {
    const frame = JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>;
    if (frame['type'] === 'messaging-updated') changes.push(frame);
  });
  try {
    await once(socket, 'open');
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'desk' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']), 'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const outside = () => api(td.port, td.token, '/launcher/launch', { headers, body: { profile: 'sample' } });
    const dashboard = () => api(td.port, null, '/dashboard/launch', { headers: dashboardHeaders, body: { profile: 'sample' } });
    const first = dashboard();
    await eventually(() => td.daemon['pendingProfileStarts'].size === 1);
    save(1);
    await eventually(() => td.daemon['launchesPerMinute'] === 1, 3000);
    expect((await outside()).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await dashboard()).status).toBe(429);
    save(2);
    await eventually(() => td.daemon['launchesPerMinute'] === 2, 3000);
    expect((await outside()).status).toBe(200);
    expect((await dashboard()).status).toBe(429);
    save(2, false);
    await eventually(() => changes.length === 1, 3000);
    expect(Object.keys(changes[0]!).sort()).toEqual(['at', 'type']);
    expect((await api(td.port, null, '/dashboard/messages', { headers: dashboardHeaders })).body).toMatchObject({ enabled: false, counts: {} });
    expect((await outside()).status).toBe(403);
    expect((await api(td.port, td.token, '/launcher/previous', { headers })).status).toBe(403);
    now += 60_001;
    save(2, true, 1);
    await eventually(() => changes.length === 2, 3000);
    expect((await api(td.port, td.token, '/messages/directory', { headers })).status).toBe(403);
    expect(JSON.parse(fs.readFileSync(join(home, 'launcher-claims.json'), 'utf8'))).toEqual([]);
    expect(fs.readFileSync(join(home, 'audit.log'), 'utf8')).toContain('msg-lapse');
  } finally { release(); socket.terminate(); await td.stop(); }
}, 90_000);
