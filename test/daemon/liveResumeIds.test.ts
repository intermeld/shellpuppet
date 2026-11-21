import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { liveResumeId } from '../../src/agents/claude/liveResumeId.js';
import * as lookup from '../../src/daemon/liveResumeIds.js';
import { Daemon } from '../../src/daemon/server.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import type { Session } from '../../src/core/session.js';
import { windowsLiveMetadata } from '../../src/core/windowsLiveMetadata.js';

const { recordLiveResumeIds } = lookup;
const born = Date.now() - 60_000;
const root = { pid: 100, parent: 1, startedAt: born, name: 'claude' };

let daemonHome: string;
let home: string;
let directory: string;
beforeAll(async () => {
  daemonHome = mkdtempSync(join(tmpdir(), 'sp-record-'));
  if (process.platform === 'win32') {
    await windowsLiveMetadata().request(['tree', String(process.pid)], AbortSignal.timeout(30_000));
  }
}, 35_000);
afterAll(() => rmSync(daemonHome, { recursive: true, force: true }));
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sp-live-resume-'));
  directory = join(home, '.claude', 'sessions');
  mkdirSync(directory, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

// Exercise the shutdown writer with an isolated home and a synthetic process table.
async function savedId(processes = [root], s = session(), snapshot = () => Promise.resolve(processes)) {
  const daemon = new Daemon({ home: daemonHome, logger: NULL_LOGGER });
  rmSync(join(daemonHome, 'daemon.json'), { force: true });
  daemon['publishedState'] = { port: 1, pid: process.pid, token: '', version: '', startedAt: '' };
  daemon['homeOwner'] = { held: () => true, release: () => {} };
  const profileSession = { ...s, id: 's1', resumeId: 'reported', agent: 'claude',
    launchProfile: { profile: 'worker', resumeId: 'launch' } };
  daemon['manager']['sessions'].set('s1', profileSession as unknown as Session);
  vi.spyOn(daemon['mailbox'], 'participant').mockReturnValue({ kind: 'session', id: 's1', name: 'worker' });
  vi.spyOn(lookup, 'recordLiveResumeIds').mockImplementation(sessions => recordLiveResumeIds(sessions, snapshot));
  await daemon['saveShutdownRecords']({ restart: true });
  const saved = JSON.parse(readFileSync(join(daemonHome, 'previous-sessions.json'), 'utf8')) as { sessions: { resumeId: string }[] };
  return saved.sessions[0]!.resumeId;
}

function session(pid = 100) {
  return { pid, programEnded: false, liveResumeId: liveResumeId({ HOME: home, USERPROFILE: home }, home) };
}

it('reads the current sessionId each time a direct launch is recorded', async () => {
  const s = session();
  const processes = () => Promise.resolve([root]);
  for (const id of ['first', 'selected-in-resume']) {
    writeFileSync(join(directory, '100.json'), JSON.stringify({ sessionId: id, startedAt: born, other: 'ignored' }));
    expect((await recordLiveResumeIds([s], processes)).get(s)).toBe(id);
  }
});

it.each([
  ['missing', undefined], ['malformed', '{'], ['invalid id', '{"sessionId":"bad id"}'],
  ['wrong field', '{"id":"wrong"}'], ['null', 'null'], ['oversized', ' '.repeat(65536) + '{"sessionId":"big"}'],
])('leaves the reported id in effect for %s metadata', async (_description, content) => {
  if (content !== undefined) writeFileSync(join(directory, '100.json'), content);
  expect(await savedId()).toBe('reported');
});

it.each(['configuration', 'sessions', 'hard-linked file'])('keeps the reported id for a linked %s', async part => {
  const file = join(directory, '100.json');
  writeFileSync(file, '{"sessionId":"other"}');
  if (part === 'hard-linked file') linkSync(file, join(home, 'second-name'));
  else {
    const path = part === 'configuration' ? join(home, '.claude') : directory;
    const moved = join(home, 'ordinary-fixture');
    renameSync(path, moved);
    symlinkSync(moved, path, 'junction');
  }
  expect(await savedId()).toBe('reported');
});

it.each(['stale mtime', 'different startedAt', 'missing process'])('saves the reported id for %s', async reason => {
  const file = join(directory, '100.json');
  writeFileSync(file, JSON.stringify({ sessionId: 'other', ...(reason === 'different startedAt' && { startedAt: born - 1 }) }));
  if (reason === 'stale mtime') utimesSync(file, new Date(born - 1), new Date(born - 1));
  expect(await savedId(reason === 'missing process' ? [] : [root])).toBe('reported');
});

it('saves the reported id when only the nested Claude has metadata', async () => {
  writeFileSync(join(directory, '102.json'), '{"sessionId":"nested"}');
  expect(await savedId([{ ...root, name: 'wrapper' }, { ...root, pid: 101, parent: 100 },
    { ...root, pid: 102, parent: 101 }])).toBe('reported');
});

it('bounds the total lookup across stalled sessions using the production deadline', async () => {
  const sessions = [session(100), session(200), session(300)];
  const stalled = new Promise<never>(() => {});
  const reads = sessions.map(s => vi.spyOn(s.liveResumeId, 'read').mockReturnValue(stalled));
  const start = performance.now();
  expect((await recordLiveResumeIds(sessions, () => Promise.resolve(sessions.map(s => ({ ...root, pid: s.pid }))))).size).toBe(0);
  expect(performance.now() - start).toBeLessThan(550);
  for (const read of reads) expect(read).toHaveBeenCalledOnce();
  expect(await savedId([root], sessions[0], () => stalled)).toBe('reported');
});

it('opens only the selected PID file and shares the two process observations', async () => {
  const first = session(100);
  const other = session(200);
  const read = vi.spyOn(first.liveResumeId, 'read');
  const foreignRead = vi.spyOn(other.liveResumeId, 'read');
  writeFileSync(join(directory, '102.json'), '{"sessionId":"live"}');
  writeFileSync(join(directory, '999.json'), '{"sessionId":"foreign"}');
  const parents = vi.fn().mockResolvedValue([{ ...root, name: 'wrapper' },
    { ...root, pid: 101, parent: 100, name: 'wrapper' }, { ...root, pid: 102, parent: 101 },
    { ...root, pid: 999, parent: 998 }]);
  const ids = await recordLiveResumeIds([first, other], parents);
  expect(ids.get(first)).toBe('live');
  expect(ids.has(other)).toBe(false);
  expect(read.mock.calls.map(([process]) => process.pid)).toEqual([102]);
  expect(foreignRead).not.toHaveBeenCalled();
  expect(parents).toHaveBeenCalledTimes(2);
  expect(await savedId([root], other)).toBe('reported');
});

it('uses the session config directory, resolved from its working directory', async () => {
  const configured = join(home, 'custom', 'sessions');
  mkdirSync(configured, { recursive: true });
  writeFileSync(join(directory, '100.json'), '{"sessionId":"wrong-dir"}');
  writeFileSync(join(configured, '100.json'), '{"sessionId":"custom-id"}');
  const s = { ...session(), liveResumeId: liveResumeId({ CLAUDE_CONFIG_DIR: 'custom' }, home) };
  expect((await recordLiveResumeIds([s], () => Promise.resolve([root]))).get(s)).toBe('custom-id');
});

it('uses the outer conversation and falls back when two candidates are equally close', async () => {
  const s = session();
  const tree = [{ ...root, name: 'wrapper' }, { ...root, pid: 101, parent: 100 }, { ...root, pid: 102, parent: 101 }];
  writeFileSync(join(directory, '102.json'), '{"sessionId":"nested"}');
  writeFileSync(join(directory, '101.json'), '{"sessionId":"outer"}');
  expect((await recordLiveResumeIds([s], () => Promise.resolve(tree))).get(s)).toBe('outer');
  tree.push({ ...root, pid: 103, parent: 100 });
  expect(await savedId(tree)).toBe('reported');
});

it('falls back when metadata cannot be opened', async () => {
  const s = session();
  writeFileSync(join(directory, '100.json'), '{}');
  vi.spyOn(s.liveResumeId, 'read').mockRejectedValue(new Error('EACCES'));
  expect(await savedId([root], s)).toBe('reported');
});

it('saves the reported id if the selected process changes during the read', async () => {
  writeFileSync(join(directory, '100.json'), '{"sessionId":"other"}');
  const snapshot = vi.fn().mockResolvedValueOnce([root]).mockResolvedValueOnce([{ ...root, startedAt: born + 1 }]);
  expect(await savedId([root], session(), snapshot)).toBe('reported');
});
