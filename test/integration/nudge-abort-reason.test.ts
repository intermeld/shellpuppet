import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it('records a screen change when a visible nudge is resized before submit', async () => {
  const home = makeTempHome('nudge-audit-resize-');
  const td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 250,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'] }],
      nudgeIntervalMs: 1_000 } });
  // Nudge delivery is independent of group admission.
  (td.daemon as unknown as { mailbox: { policy: (from: unknown, to: unknown) => boolean } }).mailbox.policy = () => true;
  try {
    const input = path.join(home, 'recipient.input');
    const fixture = path.join(repoRoot, 'test', 'fixtures', 'nudge-tui.mjs');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [fixture, 'ready', input, path.join(home, 'unused.read')],
      shell: false, openViewer: false, cols: 120, rows: 34, label: 'recipient', agent: 'claude',
    } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const session = td.daemon['manager'].get(id)!;
    const internal = session as unknown as { agentModule: object };
    internal.agentModule = { ...internal.agentModule, input: { submit: { key: '\r', delayMs: 2_000 } } };
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
      'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const sent = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'private text' }, headers });
    const line = buildNudge([{ id: String(sent.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === line, 10_000);
    await eventually(() => session.nudgeReadyWithLine(line), 5_000);
    const resized = await api(td.port, td.token, `/sessions/${id}/resize`, { body: { cols: 120, rows: 34 } });
    expect(resized.status).toBe(200);
    expect(session.nudgeReadyWithLine(line)).toBe(true);
    const audit = () => fs.existsSync(auditLogPath(home))
      ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
        .map((row) => JSON.parse(row) as { action: string; meta?: { reason?: string } }) : [];
    await eventually(() => audit().some((entry) => entry.action === 'nudge-aborted'), 10_000);
    expect(audit().find((entry) => entry.action === 'nudge-aborted')?.meta?.reason).toBe('screen-changed');
  } finally { await td.stop(); }
}, 30_000);
