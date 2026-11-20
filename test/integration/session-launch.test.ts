import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';

it('requires a live named grant, confines resume arguments and preserves a granted outside claim across restart', async () => {
  const home = makeTempHome();
  const launchedFile = join(home, 'launched.json');
  const program = "require('node:fs').writeFileSync('launched.json',JSON.stringify({args:process.argv.slice(1),env:process.env.EXAMPLE,token:process.env.SHELLPUPPET_SESSION_TOKEN}));setInterval(()=>{},1000)";
  const profile = { name: 'chair', role: 'chair', purpose: 'Review {name}', command: process.execPath,
    args: ['-e', program, '--'], cwd: home, shell: false, envFromDaemon: ['EXAMPLE'] };
  const { config, problems } = parseDaemonConfig({ launcher: { sessionLaunch: ['supervisor', 'review'],
    profiles: [profile, { ...profile, name: 'resumable', resume: ['--resume', '{id}'] },
      { ...profile, name: 'denied', policy: { deny: ['node'] } }] } });
  expect(problems).toEqual([]);
  let now = Date.now();
  const opts = { home, now: () => now, audit: createAuditor(home), launchProfiles: config.launcher, messaging: { enabled: true, allow: [], claimIdleMinutes: 1 }, daemonEnv: { EXAMPLE: 'private-value' } };
  let td = await startTestDaemon(opts);
  const claim = async (name: string) => {
    const res = await api(td.port, td.token, '/messages/claims', { body: { name } });
    expect(res.status).toBe(201);
    return { 'x-shellpuppet-claim': String(res.body['claimId']), 'x-shellpuppet-claim-secret': String(res.body['secret']) };
  };
  const launch = (headers: Record<string,string>, body: object) => api(td.port, td.token, '/launcher/launch', { headers, body });
  try {
    const proof = await claim('supervisor');
    expect((await launch({}, { profile: 'chair' })).status).toBe(403);
    expect((await launch(await claim('other'), { profile: 'chair' })).status).toBe(403);
    expect((await launch({ ...proof, 'x-shellpuppet-claim-secret': 'wrong' }, { profile: 'chair' })).status).toBe(403);
    now += 45_000;
    expect((await api(td.port, td.token, '/messages/inbox', { headers: proof })).status).toBe(200);
    await td.daemon.stop();
    now += 30_000;
    td = await startTestDaemon(opts);
    for (const resumeId of ['', '-flag', 'a&b', 'x\n', 'a'.repeat(129)]) {
      expect((await launch(proof, { profile: 'resumable', resumeId })).status).toBe(400);
    }
    expect((await launch(proof, { profile: 'chair', resumeId: 'abc' })).status).toBe(400);
    expect((await launch(proof, { profile: 'resumable', args: [] })).status).toBe(400);
    expect((await launch(proof, { profile: 'denied' })).status).toBe(403);
    const launched = await launch(proof, { profile: 'resumable', name: 'review', resumeId: 'Thread-12' });
    expect(launched.status).toBe(200);
    const list = await api(td.port, td.token, '/sessions');
    expect(list.body['sessions']).toEqual([expect.objectContaining({ role: 'chair', name: 'review', purpose: 'Review resumable',
      startedBy: 'supervisor' })]);
    await eventually(() => existsSync(launchedFile));
    const readChild = () => JSON.parse(readFileSync(launchedFile, 'utf8')) as { token: string };
    const child = readChild();
    expect(child).toMatchObject({ args: ['--resume', 'Thread-12'], env: 'private-value' });
    const managed = { 'x-shellpuppet-session': String(launched.body['id']), 'x-shellpuppet-session-token': child.token };
    const next = await launch(managed, { profile: 'chair', name: 'ordinary' });
    expect(next.status).toBe(200);
    expect((await api(td.port, td.token, '/sessions')).body['sessions']).toContainEqual(expect.objectContaining({
      id: next.body['id'], role: 'chair', parent: launched.body['id'], startedBy: 'review'
    }));
    await eventually(() => readChild().token !== child.token);
    const ordinary = { 'x-shellpuppet-session': String(next.body['id']),
      'x-shellpuppet-session-token': readChild().token };
    expect((await launch(ordinary, { profile: 'chair' })).status).toBe(403);
    const audit = readFileSync(join(home, 'audit.log'), 'utf8');
    const entries = audit.trim().split('\n').map(line => JSON.parse(line) as { actor: string; action: string; meta?: { reason?: string } });
    expect(entries.some(entry => entry.actor === 'supervisor' && entry.action === 'refuse' && entry.meta?.reason === 'policy')).toBe(true);
    expect(audit).toContain('"startedBy":"supervisor"');
    expect(audit).not.toContain('private-value');
    expect(audit).not.toContain(proof['x-shellpuppet-claim-secret']);
    const stored = readFileSync(join(home, 'launcher-claims.json'), 'utf8');
    expect(stored).not.toContain(proof['x-shellpuppet-claim-secret']);
  } finally { await td.stop(); }
}, 60000);
