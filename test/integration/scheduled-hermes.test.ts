import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it.each([
  ['busy', 'queue', 'queued', '\t'],
  ['busy', 'skip', 'skipped', ''],
  ['idle', 'queue', 'sent', '\r'],
] as const)('scheduled %s Hermes with %s gives %s', async (state, whenBusy, outcome, key) => {
  const home = makeTempHome('scheduled-hermes-');
  const td = await startTestDaemon({ home });
  try {
    const input = join(home, 'received.input');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath,
      args: [join(repoRoot, 'test/fixtures/hermes/composer.mjs'), input, state],
      label: 'worker', agent: 'hermes', shell: false, openViewer: false, cols: 105, rows: 37,
    } });
    expect(started.status).toBe(200);
    const session = td.daemon['manager'].get(String(started.body['id']))!;
    if (state === 'busy') {
      // The running transcript can repaint; readiness is measured on the stable composer.
      await eventually(() => session.nudgeState(Date.now(), 'queue').ready, 10_000);
    } else {
      await eventually(() => session.nudgeState(Date.now(), whenBusy).ready, 10_000);
    }
    const message = 'Check the pear harvest.';
    const schedule = { name: 'check', session: 'worker', message, cron: '* * * * *',
      whenBusy, enabled: true };
    const result = await td.daemon['deliverScheduled'](schedule, () => true);
    expect(result).toMatchObject({ sessionId: session.id, outcome,
      ...(state === 'busy' && whenBusy === 'skip' ? { reason: 'busy' } : {}) });
    if (key) {
      await eventually(() => existsSync(input) && readFileSync(input, 'utf8') === message + key);
      expect(readFileSync(input, 'utf8')).toBe(message + key);
    } else {
      expect(existsSync(input)).toBe(false);
    }
  } finally {
    await td.stop();
  }
}, 45_000);
