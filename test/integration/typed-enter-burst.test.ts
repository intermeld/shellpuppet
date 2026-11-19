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
  it('submits the text after the receiver has finished treating the body as a paste', async () => {
    const manager = new SessionManager(compilePolicy(undefined));
    managers.push(manager);
    const session = manager.create({
      command: process.execPath,
      args: [path.join(repoRoot, 'test', 'fixtures', 'burst-paste-sink.mjs')],
      shell: false, cols: 80, rows: 24,
    });
    await eventually(async () => (await session.snapshot()).screen.includes('BURST READY'), 20_000);
    await session.write('reply with the word ok\r');
    await eventually(async () => (await session.snapshot()).screen.includes('RESULT'), 20_000);
    expect((await session.snapshot()).screen).toContain('RESULT submitted');
  }, 40_000);
});
