import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildNudge } from '../../src/core/mailbox.js';
import { auditLogPath, createAuditor } from '../../src/daemon/audit.js';
import { eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let running: TestDaemon | undefined;
afterEach(async () => { await running?.stop(); running = undefined; });

async function recipient(ignoredKeys: number, repaint = false) {
  const home = makeTempHome('nudge-submit-');
  const input = join(home, 'received.input');
  let now = Date.now();
  const td = running = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 60_000,
    messaging: { enabled: true, allow: ['parent-child'] }, now: () => now });
  const session = td.daemon['manager'].create({
    command: process.execPath, args: [join(repoRoot, 'test/fixtures/nudge-submit.mjs'), input, String(ignoredKeys),
      ...(repaint ? ['repaint'] : [])],
    shell: false, cols: 120, rows: 34, agent: 'muse', parent: 'sender',
  });
  td.daemon['registerMailboxSession'](session);
  const id = session.id;
  const mailbox = td.daemon['mailbox'];
  // Seed the sender directly so only the receiving terminal needs a child process.
  mailbox.register({ id: 'sender', name: 'sender', kind: 'session' });
  const send = () => mailbox.send('sender', id, 'private message');
  const first = send();
  const line = buildNudge(mailbox.inbox(id, { markRead: false }));
  await eventually(() => session.nudgeReady(Date.now()));
  return { session, first, line, send, read: () => mailbox.inbox(id),
    unreadLine: () => buildNudge(mailbox.inbox(id, { markRead: false })),
    states: () => mailbox.outbox('sender').map(entry => entry.state),
    tick: () => { now += 30_000; return td.daemon['nudges'].tick(); },
    bytes: () => existsSync(input) ? readFileSync(input, 'utf8') : '',
    audit: () => readFileSync(auditLogPath(home), 'utf8').trimEnd().split('\n').map(row =>
      JSON.parse(row) as { action: string; meta: Record<string, unknown> }),
  };
}

it('retries a swallowed submit key once and confirms the composer cleared', async () => {
  const r = await recipient(1);
  await r.tick();
  await eventually(() => r.bytes().endsWith('\r'));
  expect(r.bytes()).toBe(r.line + '\r\r');
  expect(r.session.nudgeReadyWithLine(r.line)).toBe(false);
  expect(r.session.nudgePendingLine()).toBeNull();
  expect(r.states()).toEqual(['nudged']);
  expect(r.audit().filter(entry => entry.action === 'nudge')).toHaveLength(1);
});

it.each(['input', 'resize'] as const)('leaves the line pending when %s arrives after Enter', async change => {
  const r = await recipient(1);
  const pty = r.session['pty'];
  const write = pty.write.bind(pty);
  let edit: Promise<unknown> | undefined;
  vi.spyOn(pty, 'write').mockImplementation(data => {
    write(data);
    if (data === '\r') {
      if (change === 'input') edit = r.session.write('x', { humanInput: true });
      else edit = Promise.resolve(r.session.resize(120, 34));
    }
  });
  await r.tick();
  await edit;
  const expected = r.line + (change === 'input' ? '\rx' : '\r');
  await eventually(() => r.bytes() === expected);
  expect(r.states()).toEqual(['waiting']);
  expect(r.session.nudgePendingLine()).toBe(r.line);
  expect(r.audit().some(e => e.action === 'nudge')).toBe(false);
});

it('keeps the draft waiting after an ignored Enter repaints the background task status', async () => {
  const r = await recipient(1, true);
  await r.tick();
  await r.tick();
  expect(r.bytes()).toBe(r.line + '\r');
  expect(r.states()).toEqual(['waiting']);
  expect(r.session.nudgePendingLine()).toBe(r.line);
});

it.each([false, true])('keeps the two-key limit across later scans and arrivals (original read: %s)', async read => {
  const r = await recipient(20);
  await r.tick();
  expect(r.states()).toEqual(['waiting']);
  await r.tick();
  if (read) {
    r.read();
    await r.tick();
  }
  r.send();
  await r.tick();
  expect(r.bytes()).toBe(r.line + '\r\r');
  expect(r.states()).toEqual([read ? 'read' : 'waiting', 'waiting']);
  expect(r.audit().find(entry => entry.action === 'nudge-aborted')?.meta)
    .toMatchObject({ reason: 'not-submitted', messageIds: [r.first.id] });
  expect(r.audit().filter(e => e.action === 'nudge')).toHaveLength(0);
});

it('never retypes an accepted line after a resize interrupted its confirmation', async () => {
  const r = await recipient(0);
  Object.assign(r.session, { pendingNudgeSettleMs: 25 });
  const pty = r.session['pty'];
  const write = pty.write.bind(pty);
  let resized: Promise<void> | undefined;
  const spy = vi.spyOn(pty, 'write').mockImplementation(data => {
    write(data);
    if (data === '\r') resized = Promise.resolve(r.session.resize(120, 34));
  });
  await r.tick();
  await resized;
  spy.mockRestore();
  expect(r.states()).toEqual(['waiting']);
  await eventually(() => r.session.nudgeReady(Date.now()));
  await r.tick();
  await r.tick();
  expect(r.bytes()).toBe(r.line + '\r');
  expect(r.states()).toEqual(['waiting']);
  expect(r.audit().some(entry => entry.action === 'nudge')).toBe(false);
  r.send();
  const nextLine = r.unreadLine();
  await r.tick();
  expect(r.states()).toEqual(['nudged', 'nudged']);
  expect(r.bytes()).toBe(r.line + '\r' + nextLine + '\r');
});
