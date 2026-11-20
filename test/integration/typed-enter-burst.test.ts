import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { eventually, repoRoot } from './helpers.js';

const managers: SessionManager[] = [];
afterEach(async () => {
  while (managers.length > 0) await managers.pop()?.killAll();
});

describe('typed Enter and a burst-sensitive composer', () => {
  it.each([30, 340, 1200])('submits a %i character line after its late paint and length dependent pause', async (length) => {
    const manager = new SessionManager(compilePolicy(undefined));
    managers.push(manager);
    const session = manager.create({
      command: process.execPath,
      args: [path.join(repoRoot, 'test', 'fixtures', 'burst-paste-sink.mjs')],
      shell: false, agent: 'codex', cols: 80, rows: 24,
    });
    await eventually(async () => (await session.snapshot()).screen.includes('BURST READY'), 20_000);
    const body = 'reply with the word ok '.padEnd(length, 'x');
    const result = await session.writeWithResult(`${body}\r`);
    await eventually(async () => (await session.snapshot()).screen.includes('RESULT'), 20_000);
    expect((await session.snapshot()).screen).toContain('RESULT submitted');
    expect(result.submitted).toBe(true);
  }, 40_000);
});
