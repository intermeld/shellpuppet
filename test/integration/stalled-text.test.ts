import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';
import type { StallState } from '../../src/core/types.js';
import { eventually, repoRoot } from './helpers.js';
import { stallDiagnostics } from './stall-diagnostics.js';

for (const multiline of [true, false]) it(multiline
  ? 'retains one native notice through an indented prompt continuation redraw'
  : 'clears the original native notice when wide ordinary output changes', async () => {
  const session = new Session('native-text', { command: process.execPath,
    args: [path.join(repoRoot, 'test/fixtures/stalled-text-screen.mjs'), ...(multiline ? ['--multiline'] : [])],
    shell: false, agent: 'mimo', cols: 120, rows: 30 });
  const transitions: (StallState | undefined)[] = [];
  const off = session.onStall(state => transitions.push(state));
  const diagnostics = stallDiagnostics(session);
  let phase = 'initial notice';
  const watchdog = setTimeout(() => {
    console.error('Native text lifecycle deadline (no screen text):', JSON.stringify({ phase, pid: session.pid, exited: session.exited }));
    diagnostics.print();
  }, 55_000);
  try {
    await eventually(() => session.getStalled() !== undefined, 10_000);
    appendFileSync(path.join(tmpdir(), 'stall-text-pids.jsonl'), JSON.stringify({ pid: session.pid, at: new Date().toISOString() }) + '\n');
    const original = session.getStalled();
    phase = multiline ? 'resize' : 'output change';
    if (multiline) {
      for (const [cols, rows] of [[80, 24], [120, 30]] as const) {
        diagnostics.resize(cols, rows, 'requested');
        await session.resize(cols, rows);
        await new Promise(resolve => setTimeout(resolve, 1600));
        diagnostics.resize(cols, rows, 'settled');
        expect(session.getStalled()).toBe(original);
      }
      expect(transitions).toEqual([original]);
    } else {
      expect((await session.viewportLines()).some(line => line.includes('█ first'))).toBe(true);
      await eventually(() => transitions.includes(undefined), 10_000);
      expect((await session.viewportLines()).some(line => line.includes('█ second'))).toBe(true);
      expect(transitions.slice(0, 2)).toEqual([original, undefined]);
    }
  } catch (error) { diagnostics.print(); throw error; }
  finally {
    diagnostics.stop(); off();
    try { phase = 'quit input'; await session.write('q'); phase = 'native cleanup'; await session.kill(); }
    finally { clearTimeout(watchdog); }
  }
});
