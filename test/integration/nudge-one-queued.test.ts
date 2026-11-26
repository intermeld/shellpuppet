import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it('holds a later message until a queued nudge is followed by a consuming inbox read', async () => {
  const home = makeTempHome('nudge-one-queued-');
  const td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 250,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'] }],
      nudgeIntervalMs: 1_000 } });
  (td.daemon as unknown as { mailbox: { policy: (from: unknown, to: unknown) => boolean } }).mailbox.policy = () => true;
  try {
    const input = path.join(home, 'recipient.input');
    const readSignal = path.join(home, 'recipient.read');
    const fixture = path.join(repoRoot, 'test', 'fixtures', 'nudge-tui.mjs');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [fixture, 'queueing', input, readSignal],
      shell: false, openViewer: false, cols: 120, rows: 34, label: 'recipient', agent: 'claude',
    } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const session = td.daemon['manager'].get(id)!;
    await eventually(() => session.nudgeState(Date.now()).queued, 10_000);
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
      'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
    const line = buildNudge([{ id: String(first.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    const audit = () => fs.existsSync(auditLogPath(home))
      ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
        .map((row) => JSON.parse(row) as { action: string; meta?: { queued?: boolean; reason?: string } }) : [];
    await eventually(() => audit().some((entry) => entry.action === 'nudge' && entry.meta?.queued === true), 15_000);
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}\r`);
    const second = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'second' }, headers });
    await eventually(() => audit().some((entry) => entry.action === 'nudge-held' &&
      entry.meta?.reason === 'queued-nudge-pending'), 10_000);
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}\r`);
    const outbox = async () => (await api(td.port, td.token, '/messages/outbox', { headers }))
      .body['messages'] as { id: string; state: string }[];
    expect((await outbox()).find((entry) => entry.id === second.body['id'])?.state).toBe('waiting');
    fs.writeFileSync(readSignal, 'read-one');
    await eventually(() => fs.existsSync(`${readSignal}.result`), 5_000);
    await eventually(async () => (await outbox()).find((entry) => entry.id === second.body['id'])?.state === 'nudged', 15_000);
    const next = buildNudge([{ id: String(second.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}\r${next}\r`);
  } finally { await td.stop(); }
}, 60_000);
