import { readFileSync } from 'node:fs';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';
import type { StallState } from '../../src/core/types.js';

const refusal = readFileSync(new URL('../fixtures/stalls/mimo-refusal.ansi', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../fixtures/stalls/sidebar.ansi', import.meta.url), 'utf8');
const erase = (row: number) => `\x1b[${row};1H\x1b[2K`;
const sessions: Session[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  await Promise.all(sessions.splice(0).map(session => session.kill()));
});

async function setup(screen = refusal) {
  let output: (data: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  const pty = { pid: 0, cols: 120, rows: 30, process: 'synthetic', handleFlowControl: false,
    onData(fn: typeof output) { output = fn; return { dispose() {} }; },
    onExit(fn: typeof exit) { exit = fn; return { dispose() {} }; },
    resize(cols: number, rows: number) { pty.cols = cols; pty.rows = rows; },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('resize-redraw', { command: process.execPath, agent: 'mimo', cols: 120, rows: 30 }, {
    platform: 'linux', spawn: () => pty, pidWaitMs: 0,
  });
  sessions.push(session);
  let now = Date.now();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const internal = session as unknown as { refreshStall(): void };
  const draw = async (data: string) => {
    output(data); await vi.advanceTimersByTimeAsync(1); await session.viewportLines();
  };
  const check = (elapsed: number) => { now += elapsed; internal.refreshStall(); };
  const transitions: (StallState | undefined)[] = [];
  session.onStall(state => transitions.push(state));
  await draw(screen); check(0); check(1100);
  const original = session.getStalled();
  expect(original).toBeDefined();
  const rows = await session.viewportLines();
  const row = (text: string) => { const found = rows.findIndex(line => line.includes(text)) + 1; expect(found).toBeGreaterThan(0); return found; };
  return { session, pty, draw, check, transitions, original, row, exit: () => exit({ exitCode: 0 }) };
}

describe('bounded resize redraws of an established refusal', () => {
  it.each(['neutral', 'colon'])('keeps one %s identity through clipped reflow and delayed growth', async prompt => {
    const screen = refusal.replace('Summarise the sample.', 'Neutral sample text '.repeat(670) + (prompt === 'colon' ? ':' : ''));
    const h = await setup(screen);
    await h.session.resize(80, 24);
    await h.draw('\x1b[23;1H  \x1b[38;2;255;128;64m╹' + '▀'.repeat(75) + '\x1b[0m\x1b[K');
    h.check(1000);
    expect(h.session.getStalled()).toBe(h.original);
    await h.session.resize(120, 30);
    const rows = await h.session.viewportLines();
    const edge = rows.findIndex(line => line.includes('╹')) + 1;
    expect(edge).toBeGreaterThan(0);
    await h.draw(erase(edge)); h.check(80); h.check(250);
    expect(h.transitions).toEqual([h.original]);
    h.check(320);
    await h.draw(screen.replace('╹' + '▀'.repeat(20), '╹' + '▀'.repeat(115)));
    h.check(350); h.check(1200);
    expect(h.transitions).toEqual([h.original]);
  });
  for (const part of ['composer', 'footer', 'marker', 'error gutter', 'mode anchor', 'user gutter', 'panel dividers', 'whole frame']) {
    for (const source of ['request', 'pty report', 'renderer report']) {
      it(`retains the original notice through delayed ${part} restoration after a ${source}`, async () => {
        const screen = part === 'panel dividers' ? sidebar : refusal;
        const h = await setup(screen);
        if (source === 'request') await h.session.resize(120, 32);
        else if (source === 'pty report') { h.pty.rows = 32; await h.draw(''); }
        else (h.session as unknown as { renderer: { resize(cols: number, rows: number): void } }).renderer.resize(120, 32);
        const missing = part === 'whole frame' ? '\x1b[2J\x1b[H' : part === 'panel dividers' ? screen.replaceAll('█', ' ') :
          part === 'composer' ? erase(h.row('╹')) : part === 'footer' ? erase(h.row('▣  Build')) :
          part === 'marker' ? erase(h.row('✗ Error')) : part === 'mode anchor' ? erase(h.row('Build · Example Model') + 4) :
          part === 'user gutter' ? erase(h.row('Summarise')) :
          Array.from({ length: 5 }, (_, i) => erase(h.row('✗ Error') - 1 + i)).join('');
        await h.draw(missing);
        h.check(80); h.check(250);
        expect(h.transitions).toEqual([h.original]);
        h.check(320); await h.draw(screen);
        h.check(600); h.check(1100);
        expect(h.transitions).toEqual([h.original]);
        expect(h.session.getStalled()).toBe(h.original);
      });
    }
  }

  for (const end of ['composer loss', 'footer loss', 'marker loss', 'frame loss', 'new output', 'busy', 'changed footer']) {
    it(`clears a genuine ${end} within the resize allowance and confirmation bound`, async () => {
      const h = await setup();
      await h.session.resize(120, 32);
      const change = end === 'composer loss' ? erase(h.row('╹')) : end === 'footer loss' ? erase(h.row('▣  Build')) :
        end === 'marker loss' ? erase(h.row('✗ Error')) : end === 'frame loss' ? '\x1b[2J\x1b[H' :
        end === 'new output' ? refusal.replace('Reading the sample.', 'A newer answer.') :
        end === 'busy' ? refusal.replace('ctrl+p settings', 'esc to interrupt') : refusal.replace('17m 17s', '2s');
      await h.draw(change); h.check(100);
      // Output and duplicate same-size requests cannot renew an outstanding allowance.
      for (let i = 0; i < 8; i++) { await h.session.resize(120, 32); await h.draw(change); h.check(100); }
      expect(h.transitions).toEqual([h.original]);
      h.check(100);
      await h.session.resize(120, 32);
      h.check(250);
      expect(h.transitions).toEqual([h.original, undefined]);
    });
  }

  it('validates marker ink even when the resized screen has identical text', async () => {
    const h = await setup();
    await h.session.resize(120, 32);
    await h.draw(refusal.replaceAll('\x1b[38;2;251;113;133m', '\x1b[0m'));
    h.check(1000); h.check(250);
    expect(h.transitions).toEqual([h.original, undefined]);
  });

  it('keeps an early restored frame protected against the later growth redraw', async () => {
    const h = await setup();
    await h.session.resize(120, 32);
    await h.draw(refusal); h.check(100);
    await h.draw(erase(h.row('╹'))); h.check(300); h.check(250);
    expect(h.transitions).toEqual([h.original]);
    await h.draw(refusal); h.check(350);
    expect(h.transitions).toEqual([h.original]);
  });

  it.each(['request', 'pty report', 'renderer report'])('allows a full redraw after a later %s', async source => {
    const h = await setup();
    await h.session.resize(120, 32);
    await h.draw(refusal);
    h.check(900);
    if (source === 'request') await h.session.resize(120, 33);
    else if (source === 'pty report') h.pty.rows = 33;
    else (h.session as unknown as { renderer: { resize(cols: number, rows: number): void } }).renderer.resize(120, 33);
    await h.draw(erase(h.row('╹')));
    h.check(350); h.check(250);
    expect(h.transitions).toEqual([h.original]);
    h.check(50); await h.draw(refusal); h.check(350);
    expect(h.transitions).toEqual([h.original]);
    // Once the latest allowance ends, a persistent loss must still clear.
    await h.draw(erase(h.row('╹'))); h.check(250); h.check(250);
    expect(h.transitions).toEqual([h.original, undefined]);
  });

  it.each(['input', 'exit'])('clears immediately on %s during the allowance', async end => {
    const h = await setup();
    await h.session.resize(120, 32);
    if (end === 'input') await h.session.write('x'); else h.exit();
    expect(h.transitions).toEqual([h.original, undefined]);
  });
});
