import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { NUDGE_SUBMIT_DELAY_MS } from '../../src/core/session.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { api, eventually, makeTempHome } from './helpers.js';
import { startNudgeDaemon } from './nudge-fixture.js';

describe('fixed message nudges through a real terminal', () => {
  it('recovers a pending line after its named message was read through the inbox', async () => {
    const home = makeTempHome('nudge-stale-pending-');
    const td = await startNudgeDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 30_000,
      messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'], roles: ['chair'] }],
        nudgeIntervalMs: 60_000 } }, { recipient: 'late' });
    try {
      const input = path.join(home, 'recipient.input');
      const readSignal = path.join(home, 'recipient.read');
      const started = await td.launch('recipient');
      expect(started.status).toBe(200);
      const session = td.daemon['manager'].get(String(started.body['id']))!;
      const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
      const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
        'x-shellpuppet-claim-secret': String(claim.body['secret']) };
      const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
      const line = buildNudge([{ id: String(first.body['id']), from: {
        id: String(claim.body['claimId']), name: 'sender' } }]);
      await eventually(() => session.nudgeReady(Date.now()), 10_000);
      await td.daemon['nudges'].tick();
      await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === line, 10_000);
      const audit = () => fs.existsSync(auditLogPath(home))
        ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
          .map((row) => JSON.parse(row) as { action: string; meta?: {
            messageIds?: string[]; waitingMessageIds?: string[]; staleMessageIds?: string[] } }) : [];
      await eventually(() => audit().some((entry) => entry.action === 'nudge-aborted'), 10_000);
      fs.writeFileSync(readSignal, 'read');
      await eventually(() => fs.existsSync(`${readSignal}.result`), 5_000);
      const outbox = async () => (await api(td.port, td.token, '/messages/outbox', { headers }))
        .body['messages'] as { id: string; state: string }[];
      expect((await outbox()).find((entry) => entry.id === first.body['id'])?.state).toBe('read');
      await td.daemon['nudges'].tick();
      expect(fs.readFileSync(input, 'utf8')).toBe(line);
      expect(session.nudgePendingLine()).toBe(line);
      const second = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'second' }, headers });
      fs.writeFileSync(`${input}.paint`, 'paint');
      await eventually(() => session.nudgeReadyWithLine(line), 5_000);
      await td.daemon['nudges'].tick();
      await eventually(() => fs.readFileSync(input, 'utf8') === `${line}\r`, 5_000);
      expect((await outbox()).find((entry) => entry.id === second.body['id'])?.state).toBe('nudged');
      const nudges = audit().filter((entry) => entry.action === 'nudge');
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.meta).toMatchObject({ messageIds: [first.body['id']],
        waitingMessageIds: [second.body['id']], staleMessageIds: [first.body['id']] });
      expect(fs.readFileSync(`${input}.events`, 'utf8').split('\n').filter(Boolean)
        .map((row) => (JSON.parse(row) as { data: string }).data)).toEqual([line, '\r']);
    } finally { await td.stop(); }
  }, 45_000);

  it('clears a pending body after the composer stays empty for a quiet period', async () => {
    const home = makeTempHome('nudge-clearable-');
    const td = await startNudgeDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 250,
      messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'], roles: ['chair'] }],
        nudgeIntervalMs: 1_000 } }, { recipient: 'clearable' });

    try {
      const input = path.join(home, 'recipient.input');
      const started = await td.launch('recipient');
      expect(started.status).toBe(200);
      const id = String(started.body['id']);
      const session = td.daemon['manager'].get(id)!;
      (session as unknown as { pendingNudgeSettleMs: number }).pendingNudgeSettleMs = 2_500;
      const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
      const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
        'x-shellpuppet-claim-secret': String(claim.body['secret']) };
      const first = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'first' }, headers });
      const firstLine = buildNudge([{ id: String(first.body['id']), from: {
        id: String(claim.body['claimId']), name: 'sender' } }]);
      await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === firstLine, 10_000);
      const audit = () => fs.existsSync(auditLogPath(home))
        ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
          .map((row) => JSON.parse(row) as { action: string; meta?: { messageIds?: string[] } }) : [];
      await eventually(() => audit().some((entry) => entry.action === 'nudge-aborted'), 10_000);
      const second = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'second' }, headers });
      await session.write('\x15', { humanInput: true });
      await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8') === `${firstLine}\x15`, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await td.daemon['nudges'].tick();
      expect(audit().some((entry) => entry.action === 'nudge-cleared')).toBe(false);
      await eventually(() => audit().some((entry) => entry.action === 'nudge-cleared'), 5_000);
      const next = buildNudge([{ id: String(first.body['id']), from: {
        id: String(claim.body['claimId']), name: 'sender' } }, { id: String(second.body['id']), from: {
          id: String(claim.body['claimId']), name: 'sender' } }]);
      await eventually(() => fs.readFileSync(input, 'utf8') === `${firstLine}\x15${next}`, 10_000);
      await td.daemon['nudges'].tick();
      expect(fs.readFileSync(input, 'utf8')).toBe(`${firstLine}\x15${next}`);
      expect(audit().find((entry) => entry.action === 'nudge-cleared')?.meta?.messageIds)
        .toEqual([first.body['id']]);
    } finally { await td.stop(); }
  }, 120_000);

  it.each(['late', 'dim-extra'] as const)('does not type a second body after %s paint aborts', async (mode) => {
    const home = makeTempHome(`nudge-${mode}-`);
    const td = await startNudgeDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 250,
      messaging: { enabled: true, allow: [{ group: 'peers', members: ['sender'], roles: ['chair'] }],
        nudgeIntervalMs: 1_000 } }, { recipient: mode });

    try {
      const input = path.join(home, 'recipient.input');
      const started = await td.launch('recipient');
      expect(started.status).toBe(200);
      const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
      const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
        'x-shellpuppet-claim-secret': String(claim.body['secret']) };
      const sent = await api(td.port, td.token, '/messages', { body: { to: 'recipient', text: 'private text' }, headers });
      expect(sent.status).toBe(201);
      const line = buildNudge([{ id: String(sent.body['id']), from: {
        id: String(claim.body['claimId']), name: 'sender' } }]);
      await eventually(() => fs.existsSync(input) && fs.readFileSync(input, 'utf8').includes(line), 10_000);
      const audit = () => fs.existsSync(auditLogPath(home))
        ? fs.readFileSync(auditLogPath(home), 'utf8').split('\n').filter(Boolean)
          .map((row) => JSON.parse(row) as { action: string; meta?: { reason?: string } })
        : [];
      await eventually(() => audit().some((entry) => entry.action === 'nudge-aborted'), 10_000);
      // Let the first scheduler run finish, then force a retry before
      // explicitly asking the late fixture to paint.
      await eventually(() => td.daemon['nudges']['running'] === null, 5_000);
      await td.daemon['nudges'].tick();
      expect(fs.readFileSync(input, 'utf8')).toBe(line);
      expect(audit().some((entry) => entry.action === 'nudge-aborted' &&
        entry.meta?.reason === 'line-not-seen')).toBe(true);
      if (mode === 'late') {
        await td.daemon['nudges'].tick();
        expect(fs.readFileSync(input, 'utf8')).toBe(line);
        fs.writeFileSync(`${input}.paint`, 'paint');
        await eventually(() => fs.readFileSync(input, 'utf8') === `${line}\r`, 15_000);
        expect(fs.readFileSync(input, 'utf8')).toBe(`${line}\r`);
        await eventually(() => audit().some((entry) => entry.action === 'nudge'), 5_000);
      }
    } finally { await td.stop(); }
  }, 60_000);

  it('types once only to an idle covered session and records a text-free audit', async () => {
    const home = makeTempHome('nudge-delivery-');
    const logFile = path.join(home, 'daemon.log');
    const td = await startNudgeDaemon({ home, logger: createFileLogger(logFile),
      audit: createAuditor(home, { captureContent: true }), promptScanIntervalMs: 250,
      messaging: { enabled: true, allow: [{ group: 'peers',
        members: ['sender', 'outside'], roles: ['chair'] }], nudgeIntervalMs: 1_000 } }, { ready: 'ready', draft: 'draft', shell: 'shell' });

    try {
      const files = (name: string) => ({ input: path.join(home, `${name}.input`),
        signal: path.join(home, `${name}.read`) });
      const started = new Map<string, string>();
      for (const name of ['ready', 'draft', 'shell']) {
        const response = await td.launch(name);
        expect(response.status).toBe(200);
        started.set(name, String(response.body['id']));
      }
      const claim = await api(td.port, td.token, '/messages/claims', { body: { name: 'sender' } });
      expect(claim.status).toBe(201);
      const headers = { 'x-shellpuppet-claim': String(claim.body['claimId']),
        'x-shellpuppet-claim-secret': String(claim.body['secret']) };
      const outside = await api(td.port, td.token, '/messages/claims', { body: { name: 'outside' } });
      expect(outside.status).toBe(201);
      const sent = new Map<string, string>();
      const readyPty = td.daemon['manager'].get(started.get('ready')!)!['pty'];
      const write = readyPty.write.bind(readyPty);
      const writes: { data: string | Buffer; at: number }[] = [];
      vi.spyOn(readyPty, 'write').mockImplementation(data => {
        writes.push({ data, at: performance.now() });
        write(data);
      });
      const marker = 'private-message-body-91b4';
      for (const name of started.keys()) {
        const response = await api(td.port, td.token, '/messages', { body: { to: name, text: marker }, headers });
        expect(response.status).toBe(201);
        sent.set(name, String(response.body['id']));
      }
      const outsideMessage = await api(td.port, td.token, '/messages', {
        body: { to: 'outside', text: marker }, headers });
      expect(outsideMessage.status).toBe(201);
      const outbox = async () => (await api(td.port, td.token, '/messages/outbox', { headers }))
        .body['messages'] as { id: string; state: string }[];
      await eventually(async () => (await outbox()).find((entry) => entry.id === sent.get('ready'))?.state === 'nudged',
        15_000);
      const expected = buildNudge([{ id: sent.get('ready')!, from: { id: String(claim.body['claimId']), name: 'sender' } }]);
      await eventually(() => fs.existsSync(files('ready').input) &&
        fs.readFileSync(files('ready').input, 'utf8') === `${expected}\r`);
      expect(fs.readFileSync(files('ready').input, 'utf8')).toBe(`${expected}\r`);
      expect(writes.map(event => event.data)).toEqual([expected, '\r']);
      // Measure the daemon's submissions. The terminal can receive buffered bytes together.
      expect(writes[1]!.at - writes[0]!.at).toBeGreaterThanOrEqual(NUDGE_SUBMIT_DELAY_MS - 5);
      expect((await outbox()).filter((entry) => entry.state === 'nudged')).toHaveLength(1);
      expect((await outbox()).find((entry) => entry.id === outsideMessage.body['id'])?.state).toBe('waiting');
      const second = await api(td.port, td.token, '/messages', {
        body: { to: 'ready', text: marker }, headers });
      expect(second.status).toBe(201);
      // A later message brings one new nudge that lists every unread message,
      // even though the first went unanswered; the first line is never retyped.
      const both = buildNudge([
        { id: sent.get('ready')!, from: { id: String(claim.body['claimId']), name: 'sender' } },
        { id: String(second.body['id']), from: { id: String(claim.body['claimId']), name: 'sender' } },
      ]);
      await eventually(() => fs.readFileSync(files('ready').input, 'utf8') === `${expected}\r${both}\r`, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(fs.readFileSync(files('ready').input, 'utf8')).toBe(`${expected}\r${both}\r`);
      expect((await outbox()).find((entry) => entry.id === second.body['id'])?.state).toBe('nudged');
      expect(fs.existsSync(files('draft').input)).toBe(false);
      expect(fs.existsSync(files('shell').input)).toBe(false);
      fs.writeFileSync(files('ready').signal, 'read');
      await eventually(async () => (await outbox()).find((entry) => entry.id === sent.get('ready'))?.state === 'read');
      expect((await outbox()).find((entry) => entry.id === second.body['id'])?.state).toBe('read');
      // The fixture writes its result after the read marks the messages read.
      await eventually(() => fs.existsSync(`${files('ready').signal}.result`));
      expect(fs.readFileSync(`${files('ready').signal}.result`, 'utf8')).toContain(marker);
      const third = await api(td.port, td.token, '/messages', {
        body: { to: 'ready', text: marker }, headers });
      expect(third.status).toBe(201);
      await eventually(async () => (await outbox()).find((entry) => entry.id === third.body['id'])?.state === 'nudged');
      const next = buildNudge([{ id: String(third.body['id']), from: {
        id: String(claim.body['claimId']), name: 'sender' } }]);
      await eventually(() => fs.existsSync(files('ready').input) &&
        fs.readFileSync(files('ready').input, 'utf8') === `${expected}\r${both}\r${next}\r`);
      expect(fs.readFileSync(files('ready').input, 'utf8')).toBe(`${expected}\r${both}\r${next}\r`);
      expect((await api(td.port, td.token, `/sessions/${started.get('draft')!}`, { method: 'DELETE' })).status).toBe(200);
      await eventually(async () => (await outbox()).find((entry) => entry.id === sent.get('draft'))?.state === 'not-delivered');
      const audit = fs.readFileSync(auditLogPath(home), 'utf8');
      const nudges = audit.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        actor: string; action: string; session?: string; meta?: { messageIds?: string[]; count?: number };
      }).filter((entry) => entry.action === 'nudge');
      expect(nudges).toHaveLength(3);
      expect(nudges[0]).toMatchObject({ actor: 'daemon', session: started.get('ready'),
        meta: { messageIds: [sent.get('ready')], count: 1 } });
      expect(nudges[1]).toMatchObject({ actor: 'daemon', session: started.get('ready'),
        meta: { messageIds: [second.body['id']], count: 1 } });
      expect(nudges[2]).toMatchObject({ actor: 'daemon', session: started.get('ready'),
        meta: { messageIds: [third.body['id']], count: 1 } });
      expect(audit).not.toContain(marker);
      expect(logFile && fs.readFileSync(logFile, 'utf8')).not.toContain(marker);
      expect(audit).not.toContain(expected);
    } finally { await td.stop(); }
  }, 90_000);
});
