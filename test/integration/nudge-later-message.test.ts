import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it('recovers a delayed body after a later message and audits both ID sets', async () => {
  const home = makeTempHome('nudge-later-message-');
  const td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 250,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'] }],
      nudgeIntervalMs: 1_000 } });
  // Nudge delivery is independent of group admission.
  (td.daemon as unknown as { mailbox: { policy: (from: unknown, to: unknown) => boolean } }).mailbox.policy = () => true;
  try {
    const input = path.join(home, 'recipient.input');
    const fixture = path.join(repoRoot, 'test', 'fixtures', 'nudge-tui.mjs');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [fixture, 'late', input, path.join(home, 'unused.read')],
      shell: false, openViewer: false, cols: 120, rows: 34, label: 'recipient', agent: 'claude',
    } });
    expect(started.status).toBe(200);
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
      'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
    const line = buildNudge([{ id: String(first.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === line, 10_000);
    const audit = () => fs.existsSync(auditLogPath(home))
      ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
        .map((row) => JSON.parse(row) as { action: string; meta?: { messageIds?: string[]; waitingMessageIds?: string[] } }) : [];
    await eventually(() => audit().some((entry) => entry.action === 'nudge-aborted'), 10_000);
    const second = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'second' }, headers });
    await td.daemon['nudges'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(line);
    fs.writeFileSync(`${input}.paint`, 'paint');
    await eventually(() => fs.readFileSync(input, 'utf8') === `${line}\r`, 15_000);
    await eventually(() => audit().some((entry) => entry.action === 'nudge'), 5_000);
    const entry = audit().find((row) => row.action === 'nudge')!;
    expect(entry.meta).toMatchObject({ messageIds: [first.body['id']], waitingMessageIds: [second.body['id']] });
  } finally { await td.stop(); }
}, 45_000);
