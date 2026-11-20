import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { auditLogPath, createAuditor } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it.each(['idle', 'busy', 'sidebar'])('submits one nudge while the OpenCode PTY is %s', async state => {
  const home = makeTempHome('nudge-opencode-');
  const td = await startTestDaemon({ home, audit: createAuditor(home),
    messaging: { enabled: true, allow: ['parent-child'] } });
  try {
    const input = join(home, 'chair.input');
    const fixture = join(repoRoot, 'test', 'fixtures', 'opencode-composer.mjs');
    const sender = 'long-sender-name-to-wrap-the-fixed-nudge';
    const parent = `
      const { execFileSync } = require('node:child_process');
      const cli = (...args) => execFileSync(process.execPath, [process.env.SHELLPUPPET_CLI, ...args]);
      cli('start', '--no-shell', '--no-viewer', '--label', 'chair', '--agent', 'opencode',
        '--cols', '${state === 'sidebar' ? '200' : '80'}', '--rows', '24', process.execPath, ...process.argv.slice(1));
      cli('msg', 'send', 'chair', 'ok');
      setInterval(() => {}, 1000);
    `;
    const start = await api(td.port, td.token, '/sessions', { body: { command: process.execPath,
      args: ['-e', parent, fixture, input, state], label: sender, shell: false, openViewer: false } });
    expect(start.status).toBe(200);
    const audit = () => readFileSync(auditLogPath(home), 'utf8').trimEnd().split('\n').map(row =>
      JSON.parse(row) as { action: string; meta?: { messageIds: string[]; queued?: boolean } });
    await eventually(() => audit().some(entry => entry.action === 'nudge'), 20_000);
    const nudges = audit().filter(entry => entry.action === 'nudge');
    expect(nudges).toHaveLength(1);
    const meta = nudges[0]!.meta!;
    expect(meta.queued).toBe(state === 'busy' ? true : undefined);
    const line = buildNudge([{ id: meta.messageIds[0]!, from: { name: sender, id: String(start.body['id']) } }]);
    expect(line.length).toBeGreaterThan(80);
    await eventually(() => existsSync(input) && readFileSync(input, 'utf8') === line + '\r');
  } finally {
    await td.stop();
  }
});
