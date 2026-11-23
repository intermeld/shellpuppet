import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from '../../src/client/http.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { daemonLogPath } from '../../src/daemon/paths.js';
import { api, connectWs, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const home = makeTempHome('shellpuppet-identity-');
const execFileAsync = promisify(execFile);
let td: TestDaemon;

// Each child publishes its complete report with one rename. Seeing the final
// name means the write has finished, including in the nested CLI session.
const publishIdentity = `
  const fs = require('node:fs'), file = process.argv[1];
  fs.writeFileSync(file + '.tmp', JSON.stringify({ id: process.env.SHELLPUPPET_SESSION,
    token: process.env.SHELLPUPPET_SESSION_TOKEN, instance: process.env.SHELLPUPPET_DAEMON_INSTANCE,
    cli: process.env.SHELLPUPPET_CLI }));
  fs.renameSync(file + '.tmp', file);
`;
const liveReporter = publishIdentity + 'setInterval(() => {}, 200);';

beforeAll(async () => {
  td = await startTestDaemon({ home, policy: { mode: 'allow-all' },
    logger: createFileLogger(daemonLogPath(home)), audit: createAuditor(home) });
});
afterAll(async () => { await td.stop(); }, 120_000);

async function startReporter(file: string, headers: Record<string, string> = {}) {
  const started = await api(td.port, td.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', liveReporter, file], shell: false,
  }, headers });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await eventually(() => fs.existsSync(file), 15_000);
  const env = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    id: string; token: string; instance: string; cli: string;
  };
  return { id: started.body['id'] as string, env, response: started.body };
}

function upgradeStatus(route: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(td.port)}${route}`, { headers });
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.once('error', reject);
  });
}

function auditEntries(): { actor: string; action: string; session?: string; callerSession?: string;
  meta?: { chars?: number } }[] {
  return fs.readFileSync(path.join(home, 'audit.log'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { actor: string; action: string; session?: string;
      callerSession?: string; meta?: { chars?: number } });
}

describe('session identity', () => {
  it('checks client-token WebSocket identity and attributes later input frames', async () => {
    const caller = await startReporter(path.join(home, 'ws-caller.json'));
    const target = await startReporter(path.join(home, 'ws-target.json'));
    const proof = { 'x-shellpuppet-session': caller.id,
      'x-shellpuppet-session-token': caller.env.token };
    const eventsRoute = `/events?token=${td.token}`;
    const streamRoute = `/sessions/${target.id}/stream?token=${td.token}`;
    for (const route of [eventsRoute, streamRoute]) {
      expect(await upgradeStatus(route, { ...proof, 'x-shellpuppet-session-token': 'wrong' })).toBe(403);
      expect(await upgradeStatus(route, { 'x-shellpuppet-session': caller.id })).toBe(403);
      expect(await upgradeStatus(route, { ...proof, 'x-shellpuppet-session': 's999999' })).toBe(403);
      expect(await upgradeStatus(route)).toBe(101);
    }
    const events = new WebSocket(`ws://127.0.0.1:${String(td.port)}${eventsRoute}`, { headers: proof });
    try {
      await new Promise<void>((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
      const stream = await connectWs(td.port, target.id, td.token, proof);
      try {
        stream.ws.send('identity frame');
        await eventually(() => auditEntries().some((entry) => entry.action === 'input'
          && entry.session === target.id && entry.meta?.chars === 'identity frame'.length));
        expect(auditEntries().some((entry) => entry.action === 'events-connect'
          && entry.callerSession === caller.id)).toBe(true);
        expect(auditEntries().some((entry) => entry.action === 'ws-connect'
          && entry.session === target.id && entry.callerSession === caller.id)).toBe(true);
        expect(auditEntries().some((entry) => entry.action === 'input'
          && entry.session === target.id && entry.callerSession === caller.id
          && entry.meta?.chars === 'identity frame'.length)).toBe(true);
      } finally { stream.close(); }
    } finally { events.close(); }
    await api(td.port, td.token, `/sessions/${caller.id}`, { method: 'DELETE' });
    expect(await upgradeStatus(eventsRoute, proof)).toBe(403);
    expect(await upgradeStatus(streamRoute, proof)).toBe(403);
    expect(fs.readFileSync(path.join(home, 'audit.log'), 'utf8')).not.toContain(caller.env.token);
  }, 90_000);

  it('keeps later daemon stall audits clear and concurrent input callers distinct', async () => {
    const first = await startReporter(path.join(home, 'audit-caller-one.json'));
    const second = await startReporter(path.join(home, 'audit-caller-two.json'));
    const firstProof = { 'x-shellpuppet-session': first.id,
      'x-shellpuppet-session-token': first.env.token };
    const secondProof = { 'x-shellpuppet-session': second.id,
      'x-shellpuppet-session-token': second.env.token };
    const started = await api(td.port, td.token, '/sessions', { headers: firstProof, body: {
      command: process.execPath, args: [path.join(repoRoot, 'test/fixtures/stalled-screen.mjs')],
      shell: false, agent: 'mimo', cols: 120, rows: 30, openViewer: false,
    } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = String(started.body['id']);
    await eventually(() => auditEntries().some((entry) => entry.action === 'session-stalled'
      && entry.session === target), 15_000);
    expect(auditEntries().find((entry) => entry.action === 'session-stalled'
      && entry.session === target)?.callerSession).toBeUndefined();
    const [a, b] = await Promise.all([
      api(td.port, td.token, `/sessions/${target}/input`, { headers: firstProof, body: { data: 'a' } }),
      api(td.port, td.token, `/sessions/${target}/input`, { headers: secondProof, body: { data: 'bb' } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const input = auditEntries().filter((entry) => entry.action === 'input' && entry.session === target);
    expect(input.find((entry) => entry.meta?.chars === 1)?.callerSession).toBe(first.id);
    expect(input.find((entry) => entry.meta?.chars === 2)?.callerSession).toBe(second.id);
    await eventually(() => auditEntries().some((entry) => entry.action === 'session-stall-clear'
      && entry.session === target), 15_000);
    expect(auditEntries().find((entry) => entry.action === 'session-stall-clear'
      && entry.session === target)?.callerSession).toBeUndefined();
  }, 90_000);
  it('refuses the identity of a naturally exited session still in the list', async () => {
    const file = path.join(home, 'exited.json');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', publishIdentity, file], shell: false, openViewer: false,
    } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await eventually(() => fs.existsSync(file));
    const identity = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; token: string };
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return (listed.body['sessions'] as { id: string; exited: boolean }[])
        .some((session) => session.id === identity.id && session.exited);
    });
    const refused = await api(td.port, td.token, '/sessions', { headers: {
      'x-shellpuppet-session': identity.id,
      'x-shellpuppet-session-token': identity.token,
    } });
    expect(refused.status).toBe(403);
  }, 30_000);

  it('starts a child through the CLI from inside a session with its own identity', async () => {
    const parentFile = path.join(home, 'nested-parent.json');
    const childFile = path.join(home, 'nested-child.json');
    const parentCode = liveReporter + "require('node:child_process').spawn(process.execPath,[process.env.SHELLPUPPET_CLI,'start','--no-viewer','--no-shell','--json',process.execPath,'-e',process.argv[3],process.argv[2]],{env:process.env,stdio:'ignore'});";
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', parentCode, parentFile, childFile, liveReporter],
      shell: false, openViewer: false, env: { SHELLPUPPET_HOME: home },
    } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await eventually(() => fs.existsSync(parentFile) && fs.existsSync(childFile), 30_000);
    const parent = JSON.parse(fs.readFileSync(parentFile, 'utf8')) as { id: string; token: string };
    const child = JSON.parse(fs.readFileSync(childFile, 'utf8')) as { id: string; token: string; instance: string };
    expect(parent.id).toBe(started.body['id']);
    expect(child.id).not.toBe(parent.id);
    expect(child.token).not.toBe(parent.token);
    expect(child.instance).toBe((await api(td.port, td.token, '/health')).body['instanceId']);
    const listed = await api(td.port, td.token, '/sessions');
    expect((listed.body['sessions'] as { id: string; parent?: string }[])
      .find((entry) => entry.id === child.id)?.parent).toBe(parent.id);
    let feedParent: string | undefined;
    const unsubscribe = td.daemon.subscribeDashboardFeed((frame) => {
      if (frame.type === 'snapshot') {
        feedParent = frame.sessions.find((session) => session.id === child.id)?.parent;
      }
    });
    unsubscribe();
    expect(feedParent).toBe(parent.id);

    const cli = path.resolve('dist/cli/index.js');
    const cliEnv = { ...process.env, SHELLPUPPET_HOME: home };
    const textList = await execFileAsync(process.execPath, [cli, 'list'], { env: cliEnv, encoding: 'utf8' });
    expect(textList.stdout).toContain(`parent:${parent.id}`);
    const jsonResult = await execFileAsync(process.execPath, [cli, 'list', '--json'],
      { env: cliEnv, encoding: 'utf8' });
    const jsonList = JSON.parse(jsonResult.stdout) as { sessions: { id: string; parent?: string }[] };
    expect(jsonList.sessions.find((session) => session.id === child.id)?.parent).toBe(parent.id);
  }, 60_000);

  it('gives every start its own secret, verifies calls, and records parent and caller', async () => {
    const first = await startReporter(path.join(home, 'first.json'));
    expect(first.env.id).toBe(first.id);
    expect(first.env.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.env.cli).toBe(path.resolve('dist/cli/index.js'));
    const health = await api(td.port, td.token, '/health');
    expect(first.env.instance).toBe(health.body['instanceId']);
    const headers = { 'x-shellpuppet-session': first.id, 'x-shellpuppet-session-token': first.env.token };

    const anonymous = await api(td.port, td.token, '/sessions');
    expect(anonymous.status).toBe(200);
    const recognised = await api(td.port, td.token, '/sessions', { headers });
    expect(recognised.status).toBe(200);
    const child = await startReporter(path.join(home, 'child.json'), headers);
    expect(child.env.id).toBe(child.id);
    expect(child.env.token).not.toBe(first.env.token);
    const listed = await api(td.port, td.token, '/sessions');
    expect((listed.body['sessions'] as { id: string; parent?: string }[])
      .find((entry) => entry.id === child.id)?.parent).toBe(first.id);

    const refusalsBefore = fs.readFileSync(path.join(home, 'audit.log'), 'utf8')
      .split('\n').filter((line) => line.includes('"reason":"session identity not recognised"')).length;

    for (const bad of [
      { 'x-shellpuppet-session': first.id, 'x-shellpuppet-session-token': first.env.token.slice(0, 5) },
      { 'x-shellpuppet-session': 's999999', 'x-shellpuppet-session-token': first.env.token },
      { 'x-shellpuppet-session': first.id },
    ] as Record<string, string>[]) {
      const refused = await api(td.port, td.token, '/sessions', { headers: bad });
      expect(refused.status).toBe(403);
      expect(refused.body['error']).toBe('Session identity was not recognised.');
      expect(JSON.stringify(refused.body)).not.toContain(first.env.token);
    }

    const audit = fs.readFileSync(path.join(home, 'audit.log'), 'utf8');
    const entries = audit.trim().split('\n').map((line) => JSON.parse(line) as {
      actor: string; action: string; callerSession?: string; meta?: { reason?: string };
    });
    expect(entries.some((entry) => entry.action === 'start' && entry.callerSession === first.id)).toBe(true);
    expect(entries.filter((entry) => entry.action === 'refuse'
      && entry.meta?.reason === 'session identity not recognised')).toHaveLength(refusalsBefore + 3);
    expect(audit).not.toContain(first.env.token);
    expect(audit).not.toContain(child.env.token);
    const log = fs.readFileSync(daemonLogPath(home), 'utf8');
    expect(log).not.toContain(first.env.token);
    expect(log).not.toContain(child.env.token);
    expect(JSON.stringify(listed.body)).not.toContain(first.env.token);
    expect(JSON.stringify(first.response)).not.toContain(first.env.token);
    expect(JSON.stringify(child.response)).not.toContain(child.env.token);

    await api(td.port, td.token, `/sessions/${first.id}`, { method: 'DELETE' });
    const ended = await api(td.port, td.token, '/sessions', { headers });
    expect(ended.status).toBe(403);
  }, 90_000);

  it('sends identity only to the matching daemon instance', async () => {
    const previous = Object.fromEntries(['SHELLPUPPET_SESSION', 'SHELLPUPPET_SESSION_TOKEN',
      'SHELLPUPPET_DAEMON_INSTANCE'].map((key) => [key, process.env[key]]));
    const seen: Headers[] = [];
    const originalFetch = globalThis.fetch;
    const connection = { port: td.port, token: td.token, pid: process.pid, version: 'test',
      instanceId: 'matching', warnings: [] };
    try {
      process.env['SHELLPUPPET_SESSION'] = 's1';
      process.env['SHELLPUPPET_SESSION_TOKEN'] = 'private';
      process.env['SHELLPUPPET_DAEMON_INSTANCE'] = 'matching';
      globalThis.fetch = (_url, init) => {
        seen.push(new Headers(init?.headers));
        return Promise.resolve(new Response('{}', { status: 200 }));
      };
      await request(connection, 'GET', '/sessions');
      expect(seen[0]?.get('x-shellpuppet-session')).toBe('s1');
      expect(seen[0]?.get('x-shellpuppet-session-token')).toBe('private');
      connection.instanceId = 'other';
      await request(connection, 'GET', '/sessions');
      expect(seen[1]?.get('x-shellpuppet-session')).toBeNull();
      expect(seen[1]?.get('x-shellpuppet-session-token')).toBeNull();
      connection.instanceId = 'matching';
      delete process.env['SHELLPUPPET_SESSION_TOKEN'];
      await request(connection, 'GET', '/sessions');
      expect(seen[2]?.get('x-shellpuppet-session')).toBeNull();
      expect(seen[2]?.get('x-shellpuppet-session-token')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
