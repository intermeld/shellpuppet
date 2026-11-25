import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { auditLogPath, createAuditor } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it('nudges a waiting message on the clipped post-turn frame through a recording PTY', async () => {
  const home = makeTempHome('nudge-hermes-post-turn-');
  const td = await startTestDaemon({ home, audit: createAuditor(home),
    messaging: { enabled: true, allow: ['parent-child'] } });
  try {
    const input = join(home, 'received.input');
    const receiver = join(repoRoot, 'test', 'fixtures', 'hermes', 'composer.mjs');
    const parent = [
      "const cli = (...args) => require('node:child_process').execFileSync(process.execPath, [process.env.SHELLPUPPET_CLI, ...args]);",
      "cli('start', '--no-shell', '--no-viewer', '--label', 'recipient', '--agent', 'hermes',",
      "  '--cols', '99', '--rows', '35', process.execPath, ...process.argv.slice(1));",
      "cli('msg', 'send', 'recipient', 'ok');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const sender = await api(td.port, td.token, '/sessions', { body: { command: process.execPath,
      args: ['-e', parent, receiver, input, 'post-turn-clipped'], label: 'sender', shell: false, openViewer: false } });
    expect(sender.status).toBe(200);
    await eventually(() => td.daemon['manager'].list().some(s => s.label === 'recipient'), 10_000);
    const nudges = () => readFileSync(auditLogPath(home), 'utf8').trimEnd().split('\n').map(row =>
      JSON.parse(row) as { action: string; meta: { messageIds: string[] } })
      .filter(entry => entry.action === 'nudge');
    await eventually(() => nudges().length > 0, 20_000);
    expect(nudges()).toHaveLength(1);
    const line = buildNudge([{ id: nudges()[0]!.meta.messageIds[0]!,
      from: { name: 'sender', id: String(sender.body['id']) } }]);
    await eventually(() => existsSync(input) && readFileSync(input, 'utf8') === line + '\r');
  } finally {
    await td.stop();
  }
}, 60_000);
