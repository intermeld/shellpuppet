import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Daemon } from '../../src/daemon/server.js';
import { readDaemonState } from '../../src/daemon/paths.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import { api, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

async function withLiveProfile(run: (ctx: {
  options: ConstructorParameters<typeof Daemon>[0];
  active: Awaited<ReturnType<typeof startTestDaemon>>;
  headers: Record<string, string>;
  replace: () => Promise<Awaited<ReturnType<typeof startTestDaemon>>>;
}) => Promise<void>) {
  const config = parseDaemonConfig({ launcher: { sessionLaunch: ['chair'], profiles: [
    { name: 'worker', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false },
  ] } }).config;
  const options = { home: makeTempHome(), logger: NULL_LOGGER, launchProfiles: config.launcher,
    messaging: { enabled: true, allow: [] } };
  let owner = await startTestDaemon(options);
  try {
    const claim = (await api(owner.port, owner.token, '/messages/claims', { body: { name: 'chair' } })).body;
    const headers = { 'x-shellpuppet-claim': String(claim['claimId']), 'x-shellpuppet-claim-secret': String(claim['secret']) };
    expect((await api(owner.port, owner.token, '/launcher/launch', { headers, body: { profile: 'worker' } })).status).toBe(200);
    await run({ options, active: owner, headers, replace: async () => owner = await startTestDaemon(options) });
  } finally { await owner.stop(); }
}

it('allows a fresh starter to retry recovery if the first successor fails to publish its live discovery record', async () => {
  await withLiveProfile(async ({ options, active, headers, replace }) => {
    await active.daemon.stop({ restart: true });
    const record = join(active.home, 'previous-sessions.json');
    const saved = fs.readFileSync(record, 'utf8');
    const target = join(active.home, 'daemon.json');
    const snapshot = JSON.parse(saved) as { outgoingInstanceId: string };
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ restartFrom: snapshot.outgoingInstanceId });
    const link = fs.linkSync;
    const rename = fs.renameSync;
    let injected = 0;
    const contender = new Daemon(options);
    try {
      fs.linkSync = (source, destination) => {
        if (String(destination) === target && !fs.existsSync(target) && !injected) {
          injected++;
          throw Object.assign(new Error('Simulated one-off publication I/O failure'), { code: 'EIO' });
        }
        return link(source, destination);
      };
      fs.renameSync = (source, destination) => {
        if (String(destination) === target && !injected) {
          injected++;
          throw Object.assign(new Error('Simulated one-off publication I/O failure'), { code: 'EIO' });
        }
        rename(source, destination);
      };
      syncBuiltinESMExports();
      await expect(contender.start()).rejects.toThrow(/one-off/);
    } finally {
      fs.linkSync = link;
      fs.renameSync = rename;
      syncBuiltinESMExports();
      await contender.stop();
    }
    expect(injected).toBe(1);
    const next = await replace();
    expect(fs.readFileSync(record, 'utf8')).toBe(saved);
    const result = await api(next.port, next.token, '/launcher/previous', { headers });
    expect({ status: result.status, body: result.body }).toMatchObject({ status: 200, body: { sessions: [{ profile: 'worker' }] } });
  });
});

it('saves the live profile when discovery disappears before the restart request', async () => {
  await withLiveProfile(async ({ active, headers, replace }) => {
    fs.unlinkSync(join(active.home, 'daemon.json'));
    const reply = await api(active.port, active.token, '/daemon/shutdown', { body: { force: true, restart: true } });
    expect(reply.status).toBe(200);
    await active.daemon.stop();
    const next = await replace();
    const previous = await api(next.port, next.token, '/launcher/previous', { headers });
    expect(reply.body.warnings).toEqual([]);
    expect(previous.status).toBe(200);
    expect(previous.body.sessions).toMatchObject([{ profile: 'worker' }]);
  });
});

it('preserves a verified snapshot across an ordinary stop before the supervisor can replay it', async () => {
  await withLiveProfile(async ({ active, headers, replace }) => {
    await active.daemon.stop({ restart: true });
    const next = await replace();
    const fresh = await api(next.port, next.token, '/launcher/previous', { headers });
    expect(fresh.status).toBe(200);
    expect(fresh.body.sessions).toMatchObject([{ profile: 'worker' }]);
    await next.daemon.stop();
    const later = await replace();
    const previous = await api(later.port, later.token, '/launcher/previous', { headers });
    expect({ status: previous.status, body: previous.body }).toEqual({ status: 200, body: fresh.body });
  });
});

it('preserves activity by the legitimate holder when direct stop overlaps a missing discovery record', async () => {
  let time = Date.now();
  const options = { home: makeTempHome(), now: () => time, logger: NULL_LOGGER,
    launchProfiles: { sessionLaunch: ['chair'], profiles: [], problems: [] },
    messaging: { enabled: true, allow: [], claimIdleMinutes: 1 } };
  let current = await startTestDaemon(options);
  try {
    const claim = (await api(current.port, current.token, '/messages/claims', { body: { name: 'chair' } })).body;
    const headers = { 'x-shellpuppet-claim': String(claim.claimId), 'x-shellpuppet-claim-secret': String(claim.secret) };
    time += 50_000;
    expect((await api(current.port, current.token, '/messages/inbox', { headers })).status).toBe(200);
    fs.unlinkSync(join(current.home, 'daemon.json'));
    await current.daemon.stop();
    const saved = JSON.parse(fs.readFileSync(join(current.home, 'launcher-claims.json'), 'utf8')) as { lastActivity: number }[];
    const activityLagMs = time - saved[0]!.lastActivity;
    time += 11_000;
    current = await startTestDaemon(options);
    const reply = await api(current.port, current.token, '/messages/inbox', { headers });
    expect({ activityLagMs, status: reply.status }).toEqual({ activityLagMs: 0, status: 200 });
  } finally { await current.stop(); }
});

it('reports an unavailable first restart when a transient storage fault prevents both snapshot and handoff writes', async () => {
  await withLiveProfile(async ({ active, headers, replace }) => {
    const rename = fs.renameSync;
    const blocked = [join(active.home, 'previous-sessions.json'), join(active.home, 'daemon.json')];
    try {
      fs.renameSync = (src, dest) => {
        if (blocked.includes(String(dest))) throw Object.assign(new Error('Simulated storage fault'), { code: 'ENOSPC' });
        return rename(src, dest);
      };
      syncBuiltinESMExports();
      const reply = await api(active.port, active.token, '/daemon/shutdown', { body: { restart: true, force: true } });
      expect(reply.status).toBe(200);
      expect(reply.body.warnings).toHaveLength(2);
      await active.daemon.stop();
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
    const next = await replace();
    const previous = await api(next.port, next.token, '/launcher/previous', { headers });
    expect({ status: previous.status, body: previous.body }).toMatchObject({ status: 409 });
  });
});

it('refuses durable claim creation and release through a former owner', async () => {
  const td = await startTestDaemon({ launchProfiles: { profiles: [], problems: [], sessionLaunch: ['first', 'second'] },
    messaging: { enabled: true, allow: [] } });
  const target = join(td.home, 'daemon.json');
  const original = fs.readFileSync(target, 'utf8');
  const file = join(td.home, 'launcher-claims.json');
  try {
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'first' } });
    expect(claim.status).toBe(201);
    const headers = { 'x-shellpuppet-claim': String(claim.body.claimId), 'x-shellpuppet-claim-secret': String(claim.body.secret) };
    const saved = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(target, JSON.stringify({ ...readDaemonState(td.home), instanceId: randomUUID() }));
    const create = await api(td.port, td.token, '/messages/claims', { body: { name: 'second' } });
    expect.soft(create.status).toBe(409);
    expect.soft(fs.readFileSync(file, 'utf8') === saved).toBe(true);
    const release = await api(td.port, td.token, '/messages/claims/' + headers['x-shellpuppet-claim'], { method: 'DELETE', headers });
    expect.soft(release.status).toBe(409);
    expect(fs.readFileSync(file, 'utf8') === saved).toBe(true);
  } finally { fs.writeFileSync(target, original); await td.stop(); }
});

it('returns an empty list only after recording a verified empty restart', async () => {
  const options = { home: makeTempHome(), launchProfiles: { sessionLaunch: ['chair'], profiles: [], problems: [] },
    messaging: { enabled: true, allow: [] } };
  let owner = await startTestDaemon(options);
  try {
    const claim = await api(owner.port, owner.token, '/messages/claims', { body: { name: 'chair' } });
    expect(claim.status).toBe(201);
    const headers = { 'x-shellpuppet-claim': String(claim.body.claimId), 'x-shellpuppet-claim-secret': String(claim.body.secret) };
    expect((await api(owner.port, owner.token, '/launcher/previous', { headers })).status).toBe(409);
    const outgoing = readDaemonState(owner.home)!.instanceId;
    await owner.daemon.stop({ restart: true });
    owner = await startTestDaemon(options);
    const previous = await api(owner.port, owner.token, '/launcher/previous', { headers });
    expect(previous).toEqual({ status: 200, body: { version: 1, outgoingInstanceId: outgoing, sessions: [] } });
  } finally { await owner.stop(); }
});

it('keeps an older verified snapshot unavailable when both writes fail and discovery cannot be removed', async () => {
  await withLiveProfile(async ({ active, headers, replace }) => {
    await active.daemon.stop({ restart: true });
    const next = await replace();
    expect((await api(next.port, next.token, '/launcher/previous', { headers })).status).toBe(200);
    const discovery = join(next.home, 'daemon.json');
    const snapshot = join(next.home, 'previous-sessions.json');
    const saved = fs.readFileSync(snapshot, 'utf8');
    const rename = fs.renameSync;
    const unlink = fs.unlinkSync;
    try {
      fs.renameSync = (source, target) => {
        if ([discovery, snapshot].includes(String(target))) throw Object.assign(new Error('Locked record'), { code: 'EBUSY' });
        rename(source, target);
      };
      fs.unlinkSync = target => {
        if (String(target) === discovery) throw Object.assign(new Error('Locked discovery'), { code: 'EBUSY' });
        unlink(target);
      };
      syncBuiltinESMExports();
      const reply = await api(next.port, next.token, '/daemon/shutdown', { body: { restart: true } });
      expect(reply.body.warnings).toHaveLength(2);
      await next.daemon.stop();
    } finally {
      fs.renameSync = rename;
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
    }
    expect(fs.readFileSync(snapshot, 'utf8')).toBe(saved);
    const later = await replace();
    expect((await api(later.port, later.token, '/launcher/previous', { headers })).status).toBe(409);
  });
});

it('prevents takeover while the owner publishes a staged claim with discovery missing', async () => {
  const td = await startTestDaemon({ launchProfiles: { sessionLaunch: ['chair'], profiles: [], problems: [] },
    messaging: { enabled: true, allow: [] } });
  const write = fs.writeFileSync;
  let contenderResult: string | undefined;
  try {
    fs.writeFileSync = (file, contents, options) => {
      write(file, contents, options);
      if (typeof file !== 'number' || typeof contents !== 'string' || !contents.includes('"lastActivity"')) return;
      fs.unlinkSync(join(td.home, 'daemon.json'));
      // Pause the owner inside the real write. An independent process tries
      // to acquire the same private home before the claim can be renamed.
      contenderResult = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { Daemon } from './dist/daemon/server.js';
        import { NULL_LOGGER } from './dist/core/types.js';
        const contender = new Daemon({ home: process.env.SHELLPUPPET_HOME, logger: NULL_LOGGER });
        try { await contender.start(); process.stdout.write('acquired'); }
        catch (error) { process.stdout.write(error.message); }
        finally { await contender.stop({ removeState: false }); }
      `], { cwd: repoRoot, env: { ...process.env, SHELLPUPPET_HOME: td.home }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    };
    syncBuiltinESMExports();
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'chair' } });
    expect(contenderResult).toMatch(/daemon is already running/i);
    expect(claim.status).toBe(201);
    expect(readDaemonState(td.home)?.port).toBe(td.port);
    expect(JSON.parse(fs.readFileSync(join(td.home, 'launcher-claims.json'), 'utf8'))).toMatchObject([{ name: 'chair' }]);
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); await td.stop(); }
});

it('transfers the same predecessor to one of two starters after the successor process dies', async () => {
  await withLiveProfile(async ({ active, headers, options }) => {
    await active.daemon.stop({ restart: true });
    const saved = fs.readFileSync(join(active.home, 'previous-sessions.json'), 'utf8');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Daemon } from './dist/daemon/server.js';
      import { NULL_LOGGER } from './dist/core/types.js';
      const owner = new Daemon({ home: process.env.SHELLPUPPET_HOME, logger: NULL_LOGGER,
        launchProfiles: { sessionLaunch: ['chair'], profiles: [], problems: [] }, messaging: { enabled: true, allow: [] } });
      await owner.start();
      process.stdout.write('ready');
    `], { cwd: repoRoot, env: { ...process.env, SHELLPUPPET_HOME: active.home }, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = once(child, 'exit');
    try {
      expect(String((await Promise.race([once(child.stdout, 'data'), exited]))[0])).toBe('ready');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const starters = [new Daemon(options), new Daemon(options)];
    try {
      const results = await Promise.allSettled(starters.map(daemon => daemon.start()));
      const winners = results.filter(result => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const { port, token } = winners[0]!.value;
      const previous = await api(port, token, '/launcher/previous', { headers });
      expect(previous.status).toBe(200);
      expect(previous.body).toEqual(JSON.parse(saved));
    } finally { await Promise.all(starters.map(daemon => daemon.stop())); }
  });
});
