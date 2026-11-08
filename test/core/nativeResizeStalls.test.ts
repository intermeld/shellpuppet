import { readFileSync } from 'node:fs';
import type { IPty } from 'node-pty';
import { expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';
import type { StallState } from '../../src/core/types.js';

type Phase = 'initial' | 'shrink' | 'grow';
// Three native ConPTY captures of the neutral colon fixture. The phase bytes
// are identical, so store them once, retaining each capture's chunk boundaries.
// No process metadata, timestamps or diagnostic screens belong in the fixture.
const recording = JSON.parse(readFileSync(new URL('../fixtures/stalls/native-growth.json', import.meta.url), 'utf8')) as {
  streams: Record<Phase, string>;
  captures: (Record<Phase, number[]> & { capture: number })[];
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it.each(recording.captures.flatMap(capture => [35, 400].map(delay => ({ ...capture, delay }))))(
  'preserves one notice through recorded native growth $capture with $delay ms chunk delays', async (capture) => {
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 120, rows: 30, process: 'native-replay', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), resize() {}, write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('native-replay', { command: process.execPath, agent: 'mimo', cols: 120, rows: 30 }, {
    platform: 'linux', spawn: () => pty, pidWaitMs: 0,
  });
  const transitions: (StallState | undefined)[] = [];
  session.onStall(state => transitions.push(state));
  const replay = async (phase: Phase, state?: StallState) => {
    let offset = 0;
    for (const length of capture[phase]) {
      output(recording.streams[phase].slice(offset, offset + length));
      offset += length;
      await session.viewportLines();
      // Let the renderer and scheduled validation see the preliminary redraw
      // before the application repaint arrives, as separate native writes.
      await sleep(capture.delay);
      if (state !== undefined) expect(session.getStalled()).toBe(state);
    }
    expect(offset).toBe(recording.streams[phase].length);
  };
  try {
    await replay('initial');
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    for (const [phase, cols, rows] of [['shrink', 80, 24], ['grow', 120, 30]] as const) {
      await session.resize(cols, rows);
      await replay(phase, state);
      // Expire the old coalescing deadline before the next geometry change.
      await sleep(1400);
      expect(session.getStalled()).toBe(state);
    }
    expect(transitions).toEqual([state]);
  } finally { await session.kill(); }
}, 20_000);
