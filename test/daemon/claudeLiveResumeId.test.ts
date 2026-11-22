import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claudeSessionFile, readClaudeResumeId, watchClaudeResumeId } from '../../src/agents/claude/liveResumeId.js';

let home: string;
let file: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sp-claude-id-'));
  file = claudeSessionFile({ CLAUDE_CONFIG_DIR: join(home, 'config') }, home, 123);
  mkdirSync(join(home, 'config', 'sessions'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it('reads only the validated sessionId from its parent PID file', async () => {
  writeFileSync(file, '{"sessionId":"first-123","other":"ignored"}');
  writeFileSync(join(home, 'config', 'sessions', '999.json'), '{"sessionId":"foreign"}');
  expect(await readClaudeResumeId(file)).toBe('first-123');
  expect(claudeSessionFile({ CLAUDE_CONFIG_DIR: 'config' }, home, 123)).toBe(file);
});

it.each([
  ['missing', undefined], ['malformed', '{'], ['wrong field', '{"id":"wrong"}'],
  ['invalid', '{"sessionId":"bad id"}'], ['oversize', ' '.repeat(65537)],
])('ignores %s metadata', async (_name, content) => {
  if (content !== undefined) writeFileSync(file, content);
  expect(await readClaudeResumeId(file)).toBeUndefined();
});

it.each(process.platform === 'win32' ? ['config', 'sessions', 'hard link'] :
  ['config', 'sessions', 'file', 'hard link'])('rejects a linked %s', async part => {
  writeFileSync(file, '{"sessionId":"linked"}');
  if (part === 'hard link') linkSync(file, join(home, 'other'));
  else {
    const path = part === 'config' ? join(home, 'config') : part === 'sessions'
      ? join(home, 'config', 'sessions') : file;
    const target = join(home, 'target');
    const { renameSync } = await import('node:fs');
    renameSync(path, target);
    symlinkSync(target, path, part === 'file' ? 'file' : 'junction');
  }
  expect(await readClaudeResumeId(file)).toBeUndefined();
});

it('reports each valid change once and retains the previous id through invalid metadata', async () => {
  const received: string[] = [];
  const report = vi.fn((id: string) => { received.push(id); return Promise.resolve(); });
  writeFileSync(file, '{"sessionId":"first"}');
  const stop = watchClaudeResumeId(file, report, 25);
  const waitFor = async (count: number) => {
    const deadline = Date.now() + 2000;
    while (received.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(received).toHaveLength(count);
  };
  try {
    await waitFor(1);
    writeFileSync(file, '{"sessionId":"first"}');
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(received).toEqual(['first']);
    writeFileSync(file, '{');
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(received).toEqual(['first']);
    writeFileSync(file, '{"sessionId":"second"}');
    await waitFor(2);
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(received).toEqual(['first', 'second']);
  } finally { stop(); }
});

it('finds a file created after the watcher starts using the poll fallback', async () => {
  const received: string[] = [];
  const stop = watchClaudeResumeId(file, id => { received.push(id); return Promise.resolve(); }, 25);
  try {
    writeFileSync(file, '{"sessionId":"late"}');
    const deadline = Date.now() + 2000;
    while (!received.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(received).toEqual(['late']);
  } finally { stop(); }
});
