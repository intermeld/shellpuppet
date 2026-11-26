import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

const schedule = { name: 'daily-check', session: 'worker', message: 'Check the pear harvest.',
  cron: '* * * * *', whenBusy: 'skip', enabled: true };

it('reloads additions, edits and removals and retains the last readable section', async () => {
  const home = makeTempHome();
  const file = path.join(home, 'config.json');
  const log = path.join(home, 'daemon.log');
  const td = await startTestDaemon({ home, logger: createFileLogger(log) });
  const list = async () => (await api(td.port, td.token, '/schedules')).body['schedules'];
  const logged = () => fs.readFileSync(log, 'utf8');
  try {
    expect(await list()).toEqual([]);
    const save = (schedules: unknown) => {
      fs.writeFileSync(file + '.new', JSON.stringify({ schedules, messaging: { enabled: true } }));
      fs.renameSync(file + '.new', file);
    };
    save([schedule]);
    await eventually(async () => JSON.stringify(await list()).includes('daily-check'));
    const changed = { ...schedule, cron: '0 10 * * 1', whenBusy: 'queue' };
    save([changed, { ...schedule, name: 'broken', message: 3 }]);
    await eventually(() => /schedules.*invalid/i.test(logged()), 3000);
    expect(await list()).toMatchObject([{ name: schedule.name, cron: schedule.cron }]);
    save([changed]);
    await eventually(async () => JSON.stringify(await list()).includes('0 10 * * 1'));
    const saved = await list();
    expect(saved).toMatchObject([{ name: schedule.name, whenBusy: 'queue', lastOutcome: null }]);
    fs.writeFileSync(file, '{"schedules": [');
    await eventually(() => /invalid JSON/i.test(logged()));
    expect(await list()).toEqual(saved);
    save({ erroneous: true });
    await eventually(() => /schedules must be an array/i.test(logged()));
    expect(await list()).toEqual(saved);
    const cli = await promisify(execFile)(process.execPath, [path.join(repoRoot, 'dist/cli/index.js'),
      'schedule', 'list', '--json'], { env: { ...process.env, SHELLPUPPET_HOME: home } });
    expect(JSON.parse(cli.stdout)).toEqual({ schedules: saved });
    const plain = await promisify(execFile)(process.execPath, [path.join(repoRoot, 'dist/cli/index.js'),
      'schedule', 'list'], { env: { ...process.env, SHELLPUPPET_HOME: home } });
    expect(plain.stdout).toContain('daily-check\tworker\t0 10 * * 1\tqueue\ttrue');
    expect(plain.stdout).not.toContain(schedule.message);
    expect((await api(td.port, td.token, '/messages/claims', { body: { name: 'sample' } })).status).toBe(201);
    save([]);
    await eventually(async () => JSON.stringify(await list()) === '[]');
    expect(logged()).toContain('schedules');
    expect(logged()).not.toContain('daily-check');
    expect(logged()).not.toContain('broken');
    expect(logged()).not.toContain(schedule.message);
  } finally { await td.stop(); }
});

it('sends once per due minute to the current holder of the name and records a text-free audit', async () => {
  const home = makeTempHome();
  const log = path.join(home, 'daemon.log');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ schedules: [schedule] }));
  let now = Math.floor(Date.now() / 60_000) * 60_000;
  const td = await startTestDaemon({ home, now: () => now, logger: createFileLogger(log),
    audit: createAuditor(home, { captureContent: true }) });
  try {
    const input = path.join(home, 'input');
    const start = (file: string) => api(td.port, td.token, '/sessions', { body: { command: process.execPath,
      args: [path.join(repoRoot, 'test/fixtures/nudge-tui.mjs'), 'ready', file, file + '.signal'],
      shell: false, openViewer: false, label: schedule.session, agent: 'claude', cols: 120, rows: 34 } });
    const started = await start(input);
    expect(started.status).toBe(200);
    const session = td.daemon['manager'].get(String(started.body['id']))!;
    await eventually(() => session.nudgeReady(Date.now()));
    now += 120_000;
    await td.daemon['promptScheduler'].tick();
    await td.daemon['promptScheduler'].tick();
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === schedule.message + '\r');
    const list = (await api(td.port, td.token, '/schedules')).body;
    expect(list['schedules']).toMatchObject([{ name: schedule.name, lastOutcome: { outcome: 'sent' } }]);
    const draft = 'My unfinished reply.';
    await session.write(draft, { humanInput: true });
    await eventually(() => fs.readFileSync(input, 'utf8') === schedule.message + '\r' + draft &&
      session.nudgeReadyWithLine(draft));
    now += 60_000;
    await td.daemon['promptScheduler'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(schedule.message + '\r' + draft);
    expect((await api(td.port, td.token, '/sessions/' + session.id, { method: 'DELETE' })).status).toBe(200);
    await eventually(() => td.daemon['mailbox'].sessionIdByName(schedule.session) === undefined);
    now += 60_000;
    await td.daemon['promptScheduler'].tick();
    const nextInput = path.join(home, 'relaunched.input');
    const relaunched = await start(nextInput);
    expect(relaunched.status).toBe(200);
    expect(relaunched.body['id']).not.toBe(session.id);
    const nextSession = td.daemon['manager'].get(String(relaunched.body['id']))!;
    await eventually(() => nextSession.nudgeReady(Date.now()));
    now += 60_000;
    await td.daemon['promptScheduler'].tick();
    await eventually(() => fs.existsSync(nextInput) && fs.readFileSync(nextInput, 'utf8') === schedule.message + '\r');
    const audit = fs.readFileSync(auditLogPath(home), 'utf8');
    const events = audit.trim().split('\n').map(line => JSON.parse(line) as { meta?: { source?: string } })
      .filter(row => row.meta?.source === 'schedule');
    expect(events).toMatchObject([{ actor: 'daemon', action: 'input', session: started.body['id'],
      meta: { name: schedule.name, session: 'worker', outcome: 'sent' } },
    { actor: 'daemon', action: 'input', session: started.body['id'],
      meta: { name: schedule.name, session: 'worker', outcome: 'skipped', reason: 'recent-input' } },
    { actor: 'daemon', meta: { name: schedule.name, session: 'worker', outcome: 'skipped', reason: 'no-session' } },
    { actor: 'daemon', session: relaunched.body['id'], meta: { name: schedule.name, outcome: 'sent' } }]);
    expect([audit, JSON.stringify(list), fs.readFileSync(log, 'utf8')].join('\n')).not.toContain(schedule.message);
  } finally { await td.stop(); }
}, 90_000);
