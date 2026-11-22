import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it('skips a scheduled write when an empty repaint hides a buffered draft', async () => {
  const home = makeTempHome();
  const schedule = { name: 'check', session: 'worker', message: 'Run the scheduled check.',
    cron: '* * * * *', whenBusy: 'skip', enabled: true };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ schedules: [schedule] }));
  // Start in the preceding minute so the due tick can use the session's real input time.
  let now = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
  const td = await startTestDaemon({ home, now: () => now });
  try {
    const input = path.join(home, 'input');
    const fixture = path.join(repoRoot, 'test/fixtures/draft-repaint.mjs');
    const screen = path.join(repoRoot, 'test/fixtures/reasoning/claude-answered.ansi');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [fixture, input, screen],
      shell: false, openViewer: false, label: 'worker', agent: 'claude', cols: 120, rows: 34,
    } });
    expect(started.status).toBe(200);
    const session = td.daemon['manager'].get(String(started.body['id']))!;
    await eventually(() => session.nudgeReady(Date.now()));
    const draft = 'My unfinished reply.';
    const before = session.lastChangeAt();
    await session.write(draft, { humanInput: true });
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === draft &&
      session.lastChangeAt() > before && Date.now() - session.lastChangeAt() >= 1_500);
    now = Date.now();
    await td.daemon['promptScheduler'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(draft);
    expect((await api(td.port, td.token, '/schedules')).body['schedules']).toMatchObject([
      { name: 'check', lastOutcome: { outcome: 'skipped', reason: 'recent-input' } },
    ]);
  } finally { await td.stop(); }
}, 90_000);
