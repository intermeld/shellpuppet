import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { NUDGE_SUBMIT_DELAY_MS } from '../../src/core/session.js';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';

describe('fixed message nudges through a real terminal', () => {
  it('types once only to an idle covered session and records a text-free audit', async () => {
    const home = makeTempHome('nudge-delivery-');
    const logFile = path.join(home, 'daemon.log');
    const td = await startTestDaemon({ home, logger: createFileLogger(logFile),
      audit: createAuditor(home, { captureContent: true }), promptScanIntervalMs: 250,
      messaging: { enabled: true, allow: [{ group: 'peers',
        members: ['sender', 'ready', 'draft', 'shell', 'outside'] }], nudgeIntervalMs: 1_000 } });
    try {
      const fixture = path.join(repoRoot, 'test', 'fixtures', 'nudge-tui.mjs');
      const files = (name: string) => ({ input: path.join(home, `${name}.input`),
        signal: path.join(home, `${name}.read`) });
      const started = new Map<string, string>();
      for (const name of ['ready', 'draft', 'shell']) {
        const file = files(name);
        const response = await api(td.port, td.token, '/sessions', { body: {
          command: process.execPath, args: [fixture, name, file.input, file.signal],
          shell: false, openViewer: false, cols: 120, rows: 34, label: name,
          ...(name === 'shell' ? {} : { agent: 'claude' }),
        } });
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
      await eventually(() => fs.existsSync(files('ready').input));
      expect(fs.readFileSync(files('ready').input, 'utf8')).toBe(`${expected}\r`);
      const events = fs.readFileSync(`${files('ready').input}.events`, 'utf8').trim().split('\n')
        .map((row) => JSON.parse(row) as { data: string; at: number });
      expect(events.map((event) => event.data)).toEqual([expected, '\r']);
      // PTY delivery can lag behind the write clock, unlike the recording PTY.
      expect(events[1]!.at - events[0]!.at).toBeGreaterThanOrEqual(NUDGE_SUBMIT_DELAY_MS - 50);
      expect((await outbox()).filter((entry) => entry.state === 'nudged')).toHaveLength(1);
      expect((await outbox()).find((entry) => entry.id === outsideMessage.body['id'])?.state).toBe('waiting');
      const second = await api(td.port, td.token, '/messages', {
        body: { to: 'ready', text: marker }, headers });
      expect(second.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(fs.readFileSync(files('ready').input, 'utf8')).toBe(`${expected}\r`);
      expect((await outbox()).find((entry) => entry.id === second.body['id'])?.state).toBe('waiting');
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
        fs.readFileSync(files('ready').input, 'utf8') === `${expected}\r${next}\r`);
      expect(fs.readFileSync(files('ready').input, 'utf8')).toBe(`${expected}\r${next}\r`);
      expect((await api(td.port, td.token, `/sessions/${started.get('draft')!}`, { method: 'DELETE' })).status).toBe(200);
      await eventually(async () => (await outbox()).find((entry) => entry.id === sent.get('draft'))?.state === 'not-delivered');
      const audit = fs.readFileSync(auditLogPath(home), 'utf8');
      const nudges = audit.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        actor: string; action: string; session?: string; meta?: { messageIds?: string[]; count?: number };
      }).filter((entry) => entry.action === 'nudge');
      expect(nudges).toHaveLength(2);
      expect(nudges[0]).toMatchObject({ actor: 'daemon', session: started.get('ready'),
        meta: { messageIds: [sent.get('ready')], count: 1 } });
      expect(nudges[1]).toMatchObject({ actor: 'daemon', session: started.get('ready'),
        meta: { messageIds: [third.body['id']], count: 1 } });
      expect(audit).not.toContain(marker);
      expect(logFile && fs.readFileSync(logFile, 'utf8')).not.toContain(marker);
      expect(audit).not.toContain(expected);
    } finally { await td.stop(); }
  }, 60_000);
});
