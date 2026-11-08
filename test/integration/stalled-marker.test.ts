import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';
import type { StallState } from '../../src/core/types.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it('retains one native notice when a prompt containing the error marker is redrawn alone', async () => {
  const session = new Session('marker-native', { command: process.execPath,
    args: [fileURLToPath(new URL('../fixtures/marker-stalled-screen.mjs', import.meta.url))],
    shell: false, agent: 'mimo', cols: 120, rows: 30 });
  const transitions: (StallState | undefined)[] = [];
  session.onStall(state => transitions.push(state));
  try {
    for (let i = 0; i < 60 && !session.getStalled(); i++) await sleep(100);
    const original = session.getStalled();
    expect(original).toBeDefined();
    for (const [cols, rows] of [[80, 24], [120, 30]]) {
      await session.resize(cols!, rows!);
      await sleep(1500);
      expect(session.getStalled()).toBe(original);
    }
    expect(transitions).toEqual([original]);
  } finally {
    await session.write('q');
    await sleep(250);
    await session.kill();
  }
});
