import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveResumeId } from '../../src/agents/claude/liveResumeId.js';
import { recordLiveResumeIds } from '../../src/daemon/liveResumeIds.js';

let home: string;
let directory: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sp-live-resume-'));
  directory = join(home, '.claude', 'sessions');
  mkdirSync(directory, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function session(pid = 100) {
  return { pid, programEnded: false, liveResumeId: liveResumeId({ HOME: home, USERPROFILE: home }, home) };
}

it('reads the current sessionId each time a direct launch is recorded', async () => {
  const s = session();
  const parents = vi.fn();
  for (const id of ['first', 'selected-in-resume']) {
    writeFileSync(join(directory, '100.json'), JSON.stringify({ sessionId: id, other: 'ignored' }));
    expect((await recordLiveResumeIds([s], parents)).get(s)).toBe(id);
  }
  expect(parents).not.toHaveBeenCalled();
});

it.each([
  ['missing', undefined], ['malformed', '{'], ['invalid id', '{"sessionId":"bad id"}'],
  ['wrong field', '{"id":"wrong"}'], ['null', 'null'], ['oversized', ' '.repeat(65536) + '{"sessionId":"big"}'],
])('leaves the reported id in effect for %s metadata', async (_description, content) => {
  if (content !== undefined) writeFileSync(join(directory, '100.json'), content);
  expect((await recordLiveResumeIds([session()])).size).toBe(0);
});

it('opens only a PID file verified to belong to the session, sharing one ancestry query', async () => {
  const first = session(100);
  const other = session(200);
  const read = vi.spyOn(first.liveResumeId, 'read');
  const foreignRead = vi.spyOn(other.liveResumeId, 'read');
  writeFileSync(join(directory, '102.json'), '{"sessionId":"live"}');
  writeFileSync(join(directory, '999.json'), '{"sessionId":"foreign"}');
  const parents = vi.fn().mockResolvedValue(new Map([[102, 101], [101, 100], [999, 998]]));
  const ids = await recordLiveResumeIds([first, other], parents);
  expect(ids.get(first)).toBe('live');
  expect(ids.has(other)).toBe(false);
  expect(read.mock.calls).toEqual([[102]]);
  expect(foreignRead).not.toHaveBeenCalled();
  expect(parents).toHaveBeenCalledTimes(1);
});

it('uses the session config directory, resolved from its working directory', async () => {
  const configured = join(home, 'custom', 'sessions');
  mkdirSync(configured, { recursive: true });
  writeFileSync(join(directory, '100.json'), '{"sessionId":"wrong-dir"}');
  writeFileSync(join(configured, '100.json'), '{"sessionId":"custom-id"}');
  const s = { ...session(), liveResumeId: liveResumeId({ CLAUDE_CONFIG_DIR: 'custom' }, home) };
  expect((await recordLiveResumeIds([s])).get(s)).toBe('custom-id');
});

it('uses the outer conversation and falls back when two candidates are equally close', async () => {
  const s = session();
  const parents = vi.fn().mockResolvedValue(new Map([[101, 100], [102, 101], [103, 100]]));
  writeFileSync(join(directory, '102.json'), '{"sessionId":"nested"}');
  writeFileSync(join(directory, '101.json'), '{"sessionId":"outer"}');
  expect((await recordLiveResumeIds([s], parents)).get(s)).toBe('outer');
  writeFileSync(join(directory, '103.json'), '{"sessionId":"sibling"}');
  expect((await recordLiveResumeIds([s], parents)).has(s)).toBe(false);
});

it('falls back when metadata cannot be opened', async () => {
  const s = session();
  writeFileSync(join(directory, '100.json'), '{}');
  vi.spyOn(s.liveResumeId, 'read').mockRejectedValue(new Error('EACCES'));
  expect((await recordLiveResumeIds([s])).size).toBe(0);
});

it('keeps resolved ids when the shared ancestry query exceeds its deadline', async () => {
  const direct = session();
  const wrapped = session(200);
  writeFileSync(join(directory, '100.json'), '{"sessionId":"direct"}');
  let started!: () => void;
  const querying = new Promise<void>(resolve => { started = resolve; });
  const slow = () => {
    started();
    return new Promise<Map<number, number>>(() => {});
  };
  vi.useFakeTimers();
  try {
    const recording = recordLiveResumeIds([direct, wrapped], slow, 100);
    await querying;
    await vi.advanceTimersByTimeAsync(100);
    expect([...(await recording).values()]).toEqual(['direct']);
  } finally { vi.useRealTimers(); }
});
