import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { auditLogPath, createAuditor } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it.each([
  ['idle', 'plain'], ['busy', 'panel'], ['busy', 'plain'],
])('submits once on the %s PTY and checks ordinary input on its %s composer', async (state, afterTab) => {
  const home = makeTempHome('nudge-hermes-');
  const td = await startTestDaemon({ home, audit: createAuditor(home),
    messaging: { enabled: true, allow: ['parent-child'] } });
  try {
    const input = join(home, 'received.input');
    const receiver = join(repoRoot, 'test', 'fixtures', 'hermes', 'composer.mjs');
    const parent = [
      "const cli = (...args) => require('node:child_process').execFileSync(process.execPath, [process.env.SHELLPUPPET_CLI, ...args]);",
      "cli('start', '--no-shell', '--no-viewer', '--label', 'recipient', '--agent', 'hermes',",
      "  '--cols', '105', '--rows', '37', process.execPath, ...process.argv.slice(1));",
      "cli('msg', 'send', 'recipient', 'ok');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const sender = await api(td.port, td.token, '/sessions', { body: { command: process.execPath,
      args: ['-e', parent, receiver, input, state, afterTab], label: 'sender', shell: false, openViewer: false } });
    expect(sender.status).toBe(200);
    const manager = td.daemon['manager'];
    await eventually(() => manager.list().some(s => s.label === 'recipient'), 10_000);
    const session = manager.get(manager.list().find(s => s.label === 'recipient')!.id)!;
    const nudges = () => readFileSync(auditLogPath(home), 'utf8').trimEnd().split('\n').map(row =>
      JSON.parse(row) as { action: string; meta: { messageIds: string[]; queued?: boolean } })
      .filter(entry => entry.action === 'nudge');
    await eventually(() => nudges().length > 0, 20_000);
    expect(nudges()).toHaveLength(1);
    const meta = nudges()[0]!.meta;
    expect(meta.queued).toBe(state === 'busy' ? true : undefined);
    const line = buildNudge([{ id: meta.messageIds[0]!, from: { name: 'sender', id: String(sender.body['id']) } }]);
    const expected = line + (state === 'busy' ? '\t' : '\r');
    await eventually(() => existsSync(input) && readFileSync(input, 'utf8') === expected);
    expect((await session.snapshot()).screen.includes('Ctrl+R collapse')).toBe(afterTab === 'panel');
    const typed = await session.writeWithResult('sample\r');
    expect(typed.submitted).toBe(state === 'idle');
    expect(typed.submitRetried).toBe(false);
    expect(readFileSync(input, 'utf8')).toBe(expected + (state === 'busy' ? 'sample' : 'sample\r'));
  } finally {
    await td.stop();
  }
}, 45_000);
