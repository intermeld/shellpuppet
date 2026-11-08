import { readFileSync } from 'node:fs';
import type { IPty } from 'node-pty';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor } from '../../src/core/reasoning.js';
import type { StallState } from '../../src/core/types.js';

const refusal = readFileSync(new URL('../fixtures/stalls/mimo-refusal.ansi', import.meta.url), 'utf8')
  .replace('Summarise the sample.', 'Neutral sample text '.repeat(670));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sessions: Session[] = [];
function make() {
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 120, rows: 30, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), resize() {}, write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('clipped-stall', { command: process.execPath, agent: 'mimo', cols: 120, rows: 30 }, {
    platform: 'linux', spawn: () => pty, pidWaitMs: 0,
  });
  sessions.push(session);
  const transitions: (StallState | undefined)[] = [];
  session.onStall(state => transitions.push(state));
  const draw = async (data: string) => { output(data); await session.viewportLines(); };
  return { session, transitions, draw };
}
const edge = (row: number) => `\x1b[${row};1H  \x1b[38;2;255;128;64m╹${'▀'.repeat(75)}\x1b[0m\x1b[K`;
const suggestion = (row: number, fg = '128;128;128') =>
  `\x1b[${row};1H  \x1b[38;2;255;128;64m┃\x1b[0m  \x1b[38;2;${fg}mReview the sample. (Tab to accept)\x1b[0m\x1b[K`;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map(session => session.kill()));
});

for (const presentation of ['suggestion', 'edge']) {
  it.each(['neutral', 'colon'])(`keeps the original %s notice through clipped context, ${presentation} repaints and growth`, async (prompt) => {
    const screen = prompt === 'colon' ? refusal.replace('Neutral sample text '.repeat(670), 'Neutral sample text '.repeat(670) + ':') : refusal;
    const { session, transitions, draw } = make();
    await draw(screen);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await session.resize(80, 24);
    const viewport = await session.viewportLines();
    const row = viewport.findIndex(line => line.includes('╹')) + 1;
    expect(row).toBeGreaterThan(2);
    const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
    const start = performance.now();
    for (let i = 0; i < 35; i++) {
      await draw(presentation === 'edge' ? edge(row).replace('▀'.repeat(75), '▀'.repeat(74 + i % 2)) :
        i % 2 ? `\x1b[${row - 2};1H  \x1b[38;2;255;128;64m┃\x1b[0m\x1b[K` : suggestion(row - 2));
      await sleep(30);
    }
    expect(styled.mock.calls.length).toBeGreaterThan(0);
    expect(styled.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil((performance.now() - start) / 250));
    for (const [index, args] of styled.mock.calls.entries()) {
      expect(args[0]).toEqual({ above: 128, extendWrapped: false });
      const bounded = styled.mock.results[index]!.value as ReturnType<ScreenRenderer['styledLines']>;
      expect(bounded.lines.length).toBeLessThanOrEqual(24 + 128);
      expect(detectStall(bounded.lines, signatureFor('mimo', 'mimo')!, false, bounded.firstVisible)).toBeNull();
    }
    await sleep(400);
    expect(session.getStalled()).toEqual(state);
    await session.resize(120, 30);
    await draw('\x1b[?25h');
    // ConPTY can deliver the final settings row separately. The live block
    // already qualifies, but the viewport contains more of the wrapped prompt.
    await draw(screen.replace('╹' + '▀'.repeat(20), '╹' + '▀'.repeat(115)).replace('   ctrl+p settings', '').trimEnd());
    expect(session.getStalled()).toEqual(state);
    await draw(screen);
    await sleep(1400);
    expect(session.getStalled()).toEqual(state);
    expect(transitions).toEqual([state]);
  }, 8000);
}

for (const end of ['refusal replaced', 'new footer', 'busy', 'prompt', 'new transcript', 'input', 'white suggestion', 'missing error row']) {
  it(`clears an established notice for ${end} while the turn boundary is clipped`, async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await session.resize(80, 24);
    const viewport = await session.viewportLines();
    const row = (text: string) => {
      const index = viewport.findIndex(line => line.includes(text));
      expect(index).toBeGreaterThanOrEqual(0);
      return index + 1;
    };
    const composer = row('╹');
    await draw(edge(composer));
    await sleep(400);
    expect(session.getStalled()).toEqual(state);
    if (end === 'input') await session.write('x');
    else if (end === 'refusal replaced') await draw(`\x1b[${row('✗ Error')};1H\x1b[2K     An ordinary answer.`);
    else if (end === 'new footer') await draw(`\x1b[${row('▣  Build')};1H\x1b[2K     ▣  Build · Example Model · 2s`);
    else if (end === 'busy') await draw(`\x1b[${row('ctrl+p')};1H\x1b[2K   esc to interrupt`);
    else if (end === 'prompt') await draw(`\x1b[${composer - 3};1H\x1b[2K  ┃  △ Permission required\r\n\x1b[2K  ┃   Allow once   Always allow   Reject`);
    else if (end === 'new transcript') await draw(`\x1b[${row('▣  Build') - 1};1H\x1b[2K     A newer answer follows.`);
    else if (end === 'white suggestion') await draw(suggestion(composer - 2, '238;238;238'));
    else await draw(`\x1b[${row('✗ Error') - 1};1H\x1b[2K`);
    if (end === 'new footer') {
      expect(session.getStalled()).toBe(state);
      // Include the first coalesced check: it must request confirmation.
      await sleep(100);
      expect(session.getStalled()).toBe(state);
    } else if (end !== 'white suggestion' && end !== 'missing error row') expect(session.getStalled()).toBeUndefined();
    await sleep(1400);
    expect(session.getStalled()).toBeUndefined();
    expect(transitions).toEqual([state, undefined]);
    if (end === 'input') {
      await session.resize(120, 30);
      await draw(refusal);
      await sleep(1400);
      expect(session.getStalled()).toBeUndefined();
      expect(transitions).toEqual([state, undefined]);
    }
  }, 8000);
}

it('does not discover a new notice with the long user-turn boundary outside the bounded read', async () => {
  const { session, transitions, draw } = make();
  await session.resize(80, 24);
  await draw(refusal);
  await sleep(1400);
  expect(session.getStalled()).toBeUndefined();
  expect(transitions).toEqual([]);
});

it('does not finish settling a notice after its user-turn boundary is clipped', async () => {
  const { session, transitions, draw } = make();
  await draw(refusal);
  await sleep(400);
  await session.resize(80, 24);
  const row = (await session.viewportLines()).findIndex(line => line.includes('╹')) + 1;
  await draw(edge(row));
  await sleep(1400);
  expect(session.getStalled()).toBeUndefined();
  expect(transitions).toEqual([]);
});
