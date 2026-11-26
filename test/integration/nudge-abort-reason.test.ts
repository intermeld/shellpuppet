import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome } from './helpers.js';
import { startNudgeDaemon } from './nudge-fixture.js';

it('records a screen change when a visible nudge is resized before submit', async () => {
  const home = makeTempHome('nudge-audit-resize-');
  const td = await startNudgeDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 250,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'], roles: ['chair'] }],
      nudgeIntervalMs: 1_000 } }, { recipient: 'ready' });

  try {
    const input = path.join(home, 'recipient.input');
    const started = await td.launch('recipient');
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
