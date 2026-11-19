import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it('keeps a pending body when an empty repaint precedes queued paste', async () => {
  const home = makeTempHome('nudge-queued-paste-');
  const td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 250,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'] }],
      nudgeIntervalMs: 1_000 } });
  // Nudge delivery is independent of group admission.
  (td.daemon as unknown as { mailbox: { policy: (from: unknown, to: unknown) => boolean } }).mailbox.policy = () => true;
  try {
    const input = path.join(home, 'recipient.input');
    const fixture = path.join(repoRoot, 'test', 'fixtures', 'nudge-tui.mjs');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [fixture, 'queued-paste', input, path.join(home, 'unused.read')],
      shell: false, openViewer: false, cols: 120, rows: 34, label: 'recipient', agent: 'claude',
    } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const session = td.daemon['manager'].get(id)!;
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
      'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
    const line = buildNudge([{ id: String(first.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === line, 10_000);
    const audit = () => fs.existsSync(auditLogPath(home))
      ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
        .map((row) => JSON.parse(row) as { action: string }) : [];
    await eventually(() => audit().some((entry) => entry.action === 'nudge-aborted'), 10_000);
    await session.write('\x15', { humanInput: true });
    await eventually(() => fs.readFileSync(input, 'utf8') === `${line}\x15`, 5_000);
    // The first body is still buffered by the programme, even though it showed an empty composer.
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}\x15`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await td.daemon['nudges'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}\x15`);
    expect(audit().some((entry) => entry.action === 'nudge-cleared')).toBe(false);
    fs.writeFileSync(`${input}.paint`, 'paint');
    await eventually(() => session.nudgeReadyWithLine(line), 10_000);
    await td.daemon['nudges'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}\x15`);
    expect(session.nudgePendingLine()).toBe(line);
  } finally { await td.stop(); }
}, 45_000);
