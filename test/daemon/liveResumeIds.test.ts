import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { liveResumeId } from '../../src/agents/claude/liveResumeId.js';
import * as lookup from '../../src/daemon/liveResumeIds.js';
import { Daemon } from '../../src/daemon/server.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import type { LiveResumeProcess, ProcessImage } from '../../src/agents/types.js';
import type { Session } from '../../src/core/session.js';
import { windowsLiveMetadata } from '../../src/core/windowsLiveMetadata.js';

const { recordLiveResumeIds } = lookup;
// Each fixture row already includes its synthetic OS birth time.
const fixtureBirths = (rows: ProcessImage[]) => Promise.resolve(rows as LiveResumeProcess[]);
const born = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const root = { pid: 100, parent: 1, startedAt: born, name: 'claude' };

let daemonHome: string;
let home: string;
let directory: string;
beforeAll(async () => {
  daemonHome = mkdtempSync(join(tmpdir(), 'sp-record-'));
  if (process.platform === 'win32') {
    await windowsLiveMetadata().request(['images'], AbortSignal.timeout(30_000));
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
  vi.spyOn(lookup, 'recordLiveResumeIds').mockImplementation(sessions => recordLiveResumeIds(sessions, snapshot, fixtureBirths));
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
    expect((await recordLiveResumeIds([s], processes, fixtureBirths)).get(s)).toBe(id);
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

it('uses only sessionId from the registration, including when Claude started later than the process', async () => {
  writeFileSync(join(directory, '100.json'), JSON.stringify({
    pid: root.pid, startedAt: born + 2398, startTime: 'unknown', procStart: born, sessionId: 'switched',
  }));
  expect(await savedId()).toBe('switched');
});

it('ignores a pid field inside the selected file', async () => {
  writeFileSync(join(directory, '100.json'), '{"pid":999,"procStart":1,"sessionId":"switched"}');
  expect(await savedId()).toBe('switched');
});

it.each([[2000, 'live'], [2001, 'reported']] as const)('checks the native birth time with mtime %i ms earlier', async (age, id) => {
  const file = join(directory, '100.json');
  writeFileSync(file, '{"sessionId":"live"}');
  utimesSync(file, (born - age) / 1000, (born - age) / 1000);
  expect(await savedId()).toBe(id);
});

it('keeps the reported id when the OS has no birth time or the process is missing', async () => {
  writeFileSync(join(directory, '100.json'), '{"sessionId":"other"}');
  expect(await savedId([{ ...root, startedAt: 0 }])).toBe('reported');
  expect(await savedId([])).toBe('reported');
});

it('follows a linked parent and documents where the link checks begin', async () => {
  const alias = join(home, 'alias');
  const layout = join(home, 'layout');
  mkdirSync(layout);
  renameSync(join(home, '.claude'), join(layout, '.claude'));
  symlinkSync(layout, alias, 'junction');
  writeFileSync(join(layout, '.claude', 'sessions', '100.json'), '{"sessionId":"live"}');
  const s = { ...session(), liveResumeId: liveResumeId({ CLAUDE_CONFIG_DIR: join(alias, '.claude') }, home) };
  expect(await savedId([root], s)).toBe('live');
  const reference = readFileSync(new URL('../../docs/reference/agent-profiles.md', import.meta.url), 'utf8');
  expect(reference.replace(/\s+/g, ' ')).toMatch(/link above the configured directory[^.]*followed/i);
});

it('selects a claude-code image ahead of a nested claude', async () => {
  writeFileSync(join(directory, '101.json'), '{"sessionId":"outer"}');
  writeFileSync(join(directory, '102.json'), '{"sessionId":"nested"}');
  expect(await savedId([{ ...root, name: 'wrapper' }, { ...root, pid: 101, parent: 100, name: 'claude-code' },
    { ...root, pid: 102, parent: 101 }])).toBe('outer');
});

it('recognises native image names and ignores a Claude script argument', () => {
  const source = session().liveResumeId;
  const images = ['claude', 'claude.exe', 'claude-code', 'node', 'node.exe', '/fixture/@anthropic-ai/claude-code/cli.js'];
  expect(images.filter(name => source.matchesProcess(name))).toEqual(['claude', 'claude.exe', 'claude-code']);
});

it.each([[3, 'live'], [4, 'reported']] as const)('checks the launcher chain to depth %i', async (depth, id) => {
  const processes = Array.from({ length: depth + 1 }, (_, n) => ({
    ...root, pid: 100 + n, parent: 99 + n, name: n === depth ? 'claude' : 'wrapper',
  }));
  writeFileSync(join(directory, String(100 + depth) + '.json'), '{"sessionId":"live"}');
  expect(await savedId(processes)).toBe(id);
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
  expect((await recordLiveResumeIds(sessions, () => Promise.resolve(sessions.map(s => ({ ...root, pid: s.pid }))), fixtureBirths)).size).toBe(0);
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
    { ...root, pid: 103, parent: 102 }, { ...root, pid: 999, parent: 998 }]);
  const births = vi.fn(fixtureBirths);
  const ids = await recordLiveResumeIds([first, other], parents, births);
  expect(ids.get(first)).toBe('live');
  expect(ids.has(other)).toBe(false);
  expect(read.mock.calls.map(([process]) => process.pid)).toEqual([102]);
  expect(foreignRead).not.toHaveBeenCalled();
  expect(parents).toHaveBeenCalledTimes(2);
  expect(births.mock.calls.map(([rows]) => rows.map(p => p.pid))).toEqual([[100, 101, 102], [100, 101, 102]]);
  expect(await savedId([root], other)).toBe('reported');
});

it('uses the session config directory, resolved from its working directory', async () => {
  const configured = join(home, 'custom', 'sessions');
  mkdirSync(configured, { recursive: true });
  writeFileSync(join(directory, '100.json'), '{"sessionId":"wrong-dir"}');
  writeFileSync(join(configured, '100.json'), '{"sessionId":"custom-id"}');
  const s = { ...session(), liveResumeId: liveResumeId({ CLAUDE_CONFIG_DIR: 'custom' }, home) };
  expect((await recordLiveResumeIds([s], () => Promise.resolve([root]), fixtureBirths)).get(s)).toBe('custom-id');
});

it('uses the outer conversation and falls back when two candidates are equally close', async () => {
  const s = session();
  const tree = [{ ...root, name: 'wrapper' }, { ...root, pid: 101, parent: 100 }, { ...root, pid: 102, parent: 101 }];
  writeFileSync(join(directory, '102.json'), '{"sessionId":"nested"}');
  writeFileSync(join(directory, '101.json'), '{"sessionId":"outer"}');
  expect((await recordLiveResumeIds([s], () => Promise.resolve(tree), fixtureBirths)).get(s)).toBe('outer');
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
