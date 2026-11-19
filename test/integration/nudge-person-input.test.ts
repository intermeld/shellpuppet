import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

it('does not submit a pending line after a person has edited and restored it', async () => {
  const home = makeTempHome('nudge-edited-recovery-');
  const td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 30_000,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'] }],
      nudgeIntervalMs: 60_000 } });
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
    internal.agentModule = { ...internal.agentModule, input: { submit: { key: '\r', delayMs: 5_000 } } };
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
      'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
    const line = buildNudge([{ id: String(first.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    await eventually(() => session.nudgeReady(Date.now()), 10_000);
    const firstTick = td.daemon['nudges'].tick();
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === line, 10_000);
    const edit = session.write('x', { humanInput: true });
    await edit;
    await firstTick;
    await eventually(() => fs.readFileSync(input, 'utf8') === `${line}x`, 5_000);
    await eventually(() => !session.nudgeReadyWithLine(line), 5_000);
    await session.write(line, { humanInput: true });
    await eventually(() => fs.readFileSync(input, 'utf8') === `${line}x${line}`, 5_000, 100,
      'restored input', () => fs.readFileSync(input, 'utf8'));
    await eventually(() => session.nudgeReadyWithLine(line), 5_000);
    const audit = () => fs.existsSync(auditLogPath(home))
      ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
        .map((row) => JSON.parse(row) as { action: string; meta?: { reason?: string } }) : [];
    await eventually(() => audit().some((entry) => entry.action === 'nudge-aborted'), 10_000);
    expect(session.nudgePendingLine()).toBe(line);
    await td.daemon['nudges'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}x${line}`);
    expect(session.nudgePendingLine()).toBe(line);
    expect(audit().some((entry) => entry.action === 'nudge-aborted' &&
      entry.meta?.reason === 'person-input-since')).toBe(true);
    await td.daemon['nudges'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}x${line}`);
    expect(audit().filter((entry) => entry.action === 'nudge-aborted' &&
      entry.meta?.reason === 'person-input-since')).toHaveLength(1);
  } finally { await td.stop(); }
}, 55_000);

it('keeps a late painted body pending after a person types', async () => {
  const home = makeTempHome('nudge-late-person-');
  const td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 30_000,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'] }],
      nudgeIntervalMs: 60_000 } });
  // Nudge delivery is independent of group admission.
  (td.daemon as unknown as { mailbox: { policy: (from: unknown, to: unknown) => boolean } }).mailbox.policy = () => true;
  try {
    const input = path.join(home, 'recipient.input');
    const fixture = path.join(repoRoot, 'test', 'fixtures', 'nudge-tui.mjs');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [fixture, 'late-person', input, path.join(home, 'unused.read')],
      shell: false, openViewer: false, cols: 120, rows: 34, label: 'recipient', agent: 'claude',
    } });
    const session = td.daemon['manager'].get(String(started.body['id']))!;
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
      'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
    const line = buildNudge([{ id: String(first.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    await eventually(() => session.nudgeReady(Date.now()), 10_000);
    const firstTick = td.daemon['nudges'].tick();
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === line, 10_000);
    await session.write('x', { humanInput: true });
    await firstTick;
    await eventually(() => fs.readFileSync(input, 'utf8') === `${line}x`, 5_000);
    fs.writeFileSync(`${input}.paint`, 'paint');
    await eventually(() => session.nudgeReadyWithLine(line), 5_000);
    await td.daemon['nudges'].tick();
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}x`);
    expect(session.nudgePendingLine()).toBe(line);
  } finally { await td.stop(); }
}, 45_000);

it('clears a touched body after the quiet period, then types and submits one fresh body', async () => {
  const home = makeTempHome('nudge-person-clear-');
  const td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 30_000,
    messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'] }],
      nudgeIntervalMs: 60_000 } });
  // Nudge delivery is independent of group admission.
  (td.daemon as unknown as { mailbox: { policy: (from: unknown, to: unknown) => boolean } }).mailbox.policy = () => true;
  try {
    const input = path.join(home, 'recipient.input');
    const fixture = path.join(repoRoot, 'test', 'fixtures', 'nudge-tui.mjs');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: [fixture, 'ready', input, path.join(home, 'unused.read')],
      shell: false, openViewer: false, cols: 120, rows: 34, label: 'recipient', agent: 'claude',
    } });
    const session = td.daemon['manager'].get(String(started.body['id']))!;
    (session as unknown as { pendingNudgeSettleMs: number }).pendingNudgeSettleMs = 1_000;
    const internal = session as unknown as { agentModule: object };
    internal.agentModule = { ...internal.agentModule, input: { submit: { key: '\r', delayMs: 5_000 } } };
    const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
    const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
      'x-shellpuppet-claim-secret': String(claim.body['secret']) };
    const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
    const line = buildNudge([{ id: String(first.body['id']), from: {
      id: String(claim.body['claimId']), name: 'sender' } }]);
    await eventually(() => session.nudgeReady(Date.now()), 10_000);
    const firstTick = td.daemon['nudges'].tick();
    await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === line, 10_000);
    await session.write('x', { humanInput: true });
    await firstTick;
    await session.write('\x15', { humanInput: true });
    await eventually(() => fs.readFileSync(input, 'utf8') === `${line}x\x15`, 5_000);
    await td.daemon['nudges'].tick();
    expect(session.nudgePendingLine()).toBe(line);
    expect(fs.readFileSync(input, 'utf8')).toBe(`${line}x\x15`);
    await eventually(() => session.nudgeReady(Date.now()), 5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await td.daemon['nudges'].tick();
    await eventually(() => fs.readFileSync(input, 'utf8') === `${line}x\x15${line}\r`, 15_000);
    expect(session.nudgePendingLine()).toBe(null);
    const readEvents = () => fs.existsSync(`${input}.events`)
      ? fs.readFileSync(`${input}.events`, 'utf8').trim().split('\n')
        .map((row) => JSON.parse(row) as { data: string }) : [];
    await eventually(() => readEvents().length === 5, 5_000);
    const events = readEvents();
    expect(events.map((event) => event.data)).toEqual([line, 'x', '\x15', line, '\r']);
  } finally { await td.stop(); }
}, 55_000);
