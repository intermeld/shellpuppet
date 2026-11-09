import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor } from '../../src/core/reasoning.js';
import type { StallState } from '../../src/core/types.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/stalls/${name}.ansi`, import.meta.url), 'utf8');
const refusal = fixture('mimo-refusal');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sessions: Session[] = [];
function make(cols = 120, rows = 30) {
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols, rows, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), resize() {}, write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('stall-regression', { command: process.execPath, agent: 'mimo', cols, rows }, {
    platform: 'linux', spawn: () => pty, pidWaitMs: 0,
  });
  sessions.push(session);
  const transitions: (StallState | undefined)[] = [];
  session.onStall(state => transitions.push(state));
  const draw = async (data: string) => { output(data); await session.viewportLines(); };
  return { session, transitions, draw };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map(session => session.kill()));
});

describe('live refusal regressions', () => {
  it('keeps a notice when a user prompt mentions the busy status', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await draw(refusal.replace('Summarise the sample.', 'Explain esc to interrupt in the sample.'));
    await sleep(600);
    expect(transitions).toEqual([state]);
  });
  it('treats a copy symbol inside ordinary transcript text as new output', async () => {
    const { session, draw } = make();
    const screen = refusal.replace('Reading the sample.', 'Reading the sample. ⎘ first');
    await draw(screen);
    await sleep(1400);
    expect(session.getStalled()).toBeDefined();
    await draw(screen.replace('⎘ first', '⎘ second'));
    expect(session.getStalled()).toBeUndefined();
  });
  it('clears new output when a validation timer precedes the deferred comparison', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    // A due timer can run before the next-tick output task. It must compare
    // the old transcript before updating either validated baseline.
    const internal = session as unknown as { deferStall(): void; refreshStall(): void };
    vi.spyOn(internal, 'deferStall').mockImplementation(() => {});
    await draw(refusal.replace('Reading the sample.', 'Changed real output.'));
    internal.refreshStall();
    expect(transitions).toEqual([state, undefined]);
    expect(session.getStalled()).toBeUndefined();
  });
  it('keeps a notice when ordinary user text containing the error marker is redrawn alone', async () => {
    const { session, transitions, draw } = make();
    const prompt = 'Explain the ✗ Error message shown by the sample.';
    const screen = refusal.replace('Summarise the sample.', prompt);
    await draw(screen);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await draw(screen.replace(prompt, prompt.slice(0, -8)));
    expect(session.getStalled()).toBe(state);
    await draw(screen.slice(0, screen.indexOf('\r\n')));
    expect(session.getStalled()).toBe(state);
    await sleep(80);
    await draw(screen);
    await sleep(600);
    expect(transitions).toEqual([state]);
  });
  it('cancels presentation validation when a native partial frame is restored', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
    // First invalid check, then restoration before its confirmation deadline.
    await draw('\x1b[2J\x1b[H');
    await sleep(80);
    await draw(refusal);
    styled.mockClear();
    for (let i = 0; i < 12; i++) {
      await draw('\x1b[2J\x1b[H');
      await draw(refusal.replace('⎘ copy', `⎘ copy ${i}`));
      await sleep(30);
    }
    await sleep(300);
    expect(styled).not.toHaveBeenCalled();
    expect(transitions).toEqual([state]);
    // Cancelling an obsolete check must not disable a later persistent loss.
    await draw('\x1b[2J\x1b[H');
    await sleep(600);
    expect(session.getStalled()).toBeUndefined();
  });
  it('confirms a changed footer despite repeated identical invalid frames', async () => {
    const { session, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const start = performance.now();
    const transitions: { state: StallState | undefined; elapsed: number }[] = [];
    session.onStall(next => transitions.push({ state: next, elapsed: performance.now() - start }));
    for (let i = 0; i < 20; i++) {
      await draw(refusal.replace('17m 17s', '2s'));
      await sleep(30);
    }
    // Under load the loop can run past settlement of the *new* footer. The
    // old occurrence must clear at its confirmation deadline either way.
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions[0]?.state).toBeUndefined();
    expect(transitions[0]?.elapsed).toBeLessThan(1000);
    const next = session.getStalled();
    if (next !== undefined) {
      expect(next.since).not.toBe(state?.since);
      expect(transitions[1]?.state).toBe(next);
      expect(transitions[1]!.elapsed - transitions[0]!.elapsed).toBeGreaterThanOrEqual(1000);
    }
  });
  it('confirms footer loss while retaining the independently framed error block', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const rows = await session.viewportLines();
    const footer = rows.findIndex(row => row.includes('▣  Build')) + 1;
    await draw(`\x1b[${footer};1H\x1b[2K`);
    expect(session.getStalled()).toBe(state);
    await sleep(80);
    await draw(refusal);
    await sleep(400);
    expect(transitions).toEqual([state]);
    await draw(`\x1b[${footer};1H\x1b[2K`);
    await sleep(600);
    expect(transitions).toEqual([state, undefined]);
  });
  it('confirms erased error rows while the introduction and footer retain their positions', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const rows = await session.viewportLines();
    const marker = rows.findIndex(row => row.includes('✗ Error'));
    const erased = Array.from({ length: 5 }, (_, i) => `\x1b[${marker + i};1H\x1b[2K`).join('');
    await draw(erased);
    expect(session.getStalled()).toBe(state);
    await sleep(80);
    await draw(refusal);
    await sleep(400);
    expect(transitions).toEqual([state]);
    await draw(erased);
    await sleep(600);
    expect(transitions).toEqual([state, undefined]);
  });
  it('clears a printed introduction after a surviving error block even with blank padding', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await draw(refusal.replace('     ▣', '     The request was rejected because it was considered high risk' +
      '\r\n'.repeat(7) + '     ▣'));
    expect(transitions).toEqual([state, undefined]);
  });
  it('does not schedule stall validation for busy frames without candidate ink', async () => {
    const { session, draw } = make();
    const refresh = vi.spyOn(session as unknown as { refreshStall(): void }, 'refreshStall');
    const plain = vi.spyOn(ScreenRenderer.prototype, 'plainViewport');
    for (let i = 0; i < 12; i++) {
      await draw(`\x1b[2J\x1b[H  ┃  Explain the ✗ Error example.\r\n     Working ${i}\r\n   esc to interrupt`);
      await sleep(30);
    }
    await sleep(300);
    expect(refresh).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
  });
  it('can announce another identical refusal after input and an ink-free busy turn', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const original = session.getStalled();
    expect(original).toBeDefined();
    await session.write('x');
    await draw('\x1b[2J\x1b[H  ┃  A new task.\r\n   esc to interrupt');
    await sleep(400);
    const plain = vi.spyOn(ScreenRenderer.prototype, 'plainViewport');
    for (let i = 0; i < 12; i++) {
      await draw(`\x1b[3;1H   esc to interrupt ${i}\x1b[K`);
      await sleep(30);
    }
    expect(plain).not.toHaveBeenCalled();
    await draw(refusal.replace('Summarise the sample.', 'A new task.'));
    await sleep(1400);
    const next = session.getStalled();
    expect(next).toBeDefined();
    expect(next?.since).not.toBe(original?.since);
    expect(transitions).toEqual([original, undefined, next]);
  });
  it('keeps an established notice through persistent user-turn text changes', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    for (const text of ['Short.', 'A different reconstructed prompt.', 'Summarise the sample.']) {
      await draw(refusal.replace('Summarise the sample.', text));
      expect(session.getStalled()).toBe(state);
      await sleep(1400);
      expect(session.getStalled()).toBe(state);
    }
    expect(transitions).toEqual([state]);
  }, 8000);
  it('confirms loss of the refusal instead of clearing for a transient redraw', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await draw('\x1b[2J\x1b[H');
    await sleep(80);
    expect(session.getStalled()).toBe(state);
    await draw('  ┃  A partially reconstructed user turn.');
    expect(session.getStalled()).toBe(state);
    await draw(refusal);
    await sleep(400);
    expect(session.getStalled()).toBe(state);
    expect(transitions).toEqual([state]);
    await draw('\x1b[2J\x1b[H');
    await sleep(600);
    expect(session.getStalled()).toBeUndefined();
    expect(transitions).toEqual([state, undefined]);
  });
  const frame = (cols: number) => refusal.replace('╹' + '▀'.repeat(20), '╹' + '▀'.repeat(cols - 5));
  const suggestion = '\x1b[16;1H  \x1b[38;2;255;128;64m┃\x1b[0m  ' +
    '\x1b[38;2;128;128;128mReview the sample. (Tab to accept)\x1b[0m\x1b[K';
  const blankInput = '\x1b[16;1H  \x1b[38;2;255;128;64m┃\x1b[0m\x1b[K';
  it('keeps partial grey composer presentation inside an independently framed panel', async () => {
    const { session, transitions, draw } = make();
    const screen = fixture('sidebar');
    await draw(screen);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const withSuggestion = (text: string) => screen.split('\r\n').map((line, row) => row === 15
      ? '  \x1b[38;2;255;128;64m┃\x1b[0m  \x1b[38;2;128;128;128m' + text + '\x1b[0m' +
        ' '.repeat(83 - 5 - text.length) + '█ Example panel' : line).join('\r\n');
    await draw(withSuggestion('Review the sam'));
    expect(session.getStalled()).toBe(state);
    await sleep(80);
    await draw(withSuggestion('Review the sample. (Tab to accept)'));
    await sleep(600);
    expect(transitions).toEqual([state]);
  });
  it('confirms partial grey composer text before clearing an established notice', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const partial = suggestion.replace('Review the sample. (Tab to accept)', 'Review the sam');
    await draw(partial);
    expect(session.getStalled()).toBe(state);
    await sleep(80);
    await draw(suggestion);
    await sleep(400);
    expect(session.getStalled()).toBe(state);
    expect(transitions).toEqual([state]);
    await draw(partial);
    await sleep(600);
    expect(session.getStalled()).toBeUndefined();
    expect(transitions).toEqual([state, undefined]);
  });
  it('keeps a partial grey composer row whose padding wraps during a native redraw', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    // ConPTY can pad a shortened suggestion to the old width before drawing
    // the next row. Its logical row and physical row then have different text.
    const partial = '  \x1b[38;2;255;128;64m┃\x1b[0m  \x1b[38;2;128;128;128mReview the sam';
    await draw('\x1b[16;1H' + partial + ' '.repeat(120 - stripVTControlCharacters(partial).length) + ' \x1b[K\x1b[0m');
    expect(session.getStalled()).toBe(state);
    await sleep(80);
    await draw(refusal);
    await sleep(600);
    expect(transitions).toEqual([state]);
  });
  it('keeps the framed status region while the composer closing edge is redrawn', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await draw('\x1b[18;1H\x1b[2K  \x1b[38;2;255;128;64m┃\x1b[0m');
    expect(session.getStalled()).toBe(state);
    await sleep(80);
    await draw(refusal);
    await sleep(600);
    expect(transitions).toEqual([state]);
    await draw('\r\n   ctrl+p settings');
    expect(session.getStalled()).toBeUndefined();
  });
  const candidate = async (session: Session) => {
    const { lines, firstVisible } = await session.styledScreen(128);
    return detectStall(lines, signatureFor('mimo', 'mimo')!, false, firstVisible);
  };
  for (const [cols, rows] of [[80, 24], [180, 45], [240, 60]]) {
    it(`preserves one notice through a responsive composer repaint at ${cols}x${rows}`, async () => {
      const { session, transitions, draw } = make();
      await draw(frame(120));
      await sleep(1400);
      const state = session.getStalled();
      const before = await candidate(session);
      expect(state).toBeDefined();
      expect(before).not.toBeNull();
      await session.resize(cols!, rows!);
      await draw(frame(cols!));
      expect(await candidate(session)).toEqual(before);
      expect(session.getStalled()).toEqual(state);
      await sleep(1400);
      expect(session.getStalled()).toEqual(state);
      expect(transitions).toEqual([state]);
    });
  }
  it('preserves one notice through a partial responsive composer edge repaint', async () => {
    const { session, transitions, draw } = make();
    await draw(frame(120));
    await sleep(1400);
    const state = session.getStalled();
    const before = await candidate(session);
    expect(state).toBeDefined();
    expect(before).not.toBeNull();
    await session.resize(180, 45);
    await draw('\x1b[18;1H  \x1b[38;2;255;128;64m╹' + '▀'.repeat(175) + '\x1b[0m\x1b[K');
    expect(await candidate(session)).toEqual(before);
    expect(session.getStalled()).toEqual(state);
    await sleep(1400);
    expect(session.getStalled()).toEqual(state);
    expect(transitions).toEqual([state]);
  });
  for (const arriving of [true, false]) {
    it(`preserves one notice when a grey suggestion ${arriving ? 'arrives' : 'leaves'}`, async () => {
      const { session, transitions, draw } = make();
      await draw(refusal + (arriving ? '' : suggestion));
      await sleep(1400);
      const state = session.getStalled();
      const before = await candidate(session);
      expect(state).toBeDefined();
      expect(before).not.toBeNull();
      await draw(arriving ? suggestion : blankInput);
      expect(await candidate(session)).toEqual(before);
      expect(session.getStalled()).toEqual(state);
      await sleep(1400);
      expect(session.getStalled()).toEqual(state);
      expect(transitions).toEqual([state]);
    });
  }
  it('coalesces grey suggestion repaints while retaining the candidate and clock', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
    const start = performance.now();
    for (let i = 0; i < 35; i++) {
      await draw(i % 2 ? blankInput : suggestion);
      expect(session.getStalled()).toEqual(state);
      await sleep(30);
    }
    expect(styled.mock.calls.length).toBeGreaterThan(0);
    expect(styled.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil((performance.now() - start) / 250));
    expect(transitions).toEqual([state]);
  });
  it('validates the ink of changed suggestion text before keeping a notice', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    // The text resembles idle presentation, but the white ink makes it a draft.
    await draw(suggestion.replace('128;128;128', '238;238;238'));
    expect(session.getStalled()).toEqual(state);
    await sleep(400);
    expect(session.getStalled()).toBeUndefined();
    expect(transitions).toEqual([state, undefined]);
  });
  for (const cols of [80, 120, 180]) {
    for (const name of ['cat_ansi_in_tool_panel', 'newer_after_composer', 'old_offscreen', 'indented_unsent', 'multiline-indented-draft']) {
      it(`rejects ${name} at ${cols} columns`, async () => {
        const { session, transitions, draw } = make(cols, cols === 180 ? 40 : 30);
        await draw(fixture(name));
        await sleep(1400);
        expect(session.getStalled()).toBeUndefined();
        expect(transitions).toEqual([]);
      });
    }
  }
  for (const initiallyRecover of [true, false]) {
    const withoutRecover = refusal.replace('          ↻ /recover', '');
    const initial = initiallyRecover ? refusal : withoutRecover;
    const changed = initiallyRecover ? withoutRecover : refusal;
    it(`keeps one announcement through recovery toggles and input, initially ${initiallyRecover}`, async () => {
      const { session, transitions, draw } = make();
      await draw(initial);
      await sleep(1400);
      const state = session.getStalled();
      expect(state).toBeDefined();
      await draw(changed);
      expect(session.getStalled()).toEqual(state);
      await sleep(1400);
      await draw(initial);
      await sleep(1400);
      expect(transitions).toEqual([state]);
      await session.write('x');
      for (const screen of [changed, initial]) {
        await draw(screen);
        await sleep(1400);
        expect(session.getStalled()).toBeUndefined();
      }
      expect(transitions).toEqual([state, undefined]);
    }, 12_000);
    it(`settles through a recovery toggle, initially ${initiallyRecover}`, async () => {
      const { session, transitions, draw } = make();
      await draw(initial);
      await sleep(700);
      await draw(changed);
      await sleep(700);
      expect(session.getStalled()).toBeDefined();
      expect(transitions).toHaveLength(1);
    });
    it(`suppresses a recovery toggle after input, initially ${initiallyRecover}`, async () => {
      const { session, transitions, draw } = make();
      await draw(initial);
      await sleep(1400);
      const state = session.getStalled();
      expect(state).toBeDefined();
      await session.write('x');
      await draw(changed);
      await sleep(1400);
      expect(session.getStalled()).toBeUndefined();
      expect(transitions).toEqual([state, undefined]);
    });
  }
  it('does no styled validation for cosmetic repaints of a tracked refusal', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
    for (let i = 0; i < 35; i++) {
      await draw(i % 2 ? refusal : refusal.replace('⎘ copy', '⎘ copied'));
      await sleep(30);
    }
    expect(styled).not.toHaveBeenCalled();
    expect(session.getStalled()).toEqual(state);
    expect(transitions).toEqual([state]);
  });
  it('ignores cursor-only writes after reflow at the 80x24 floor', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await session.resize(80, 24);
    const before = await session.viewportLines();
    const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
    await draw('\x1b[?25h\x1b[15;5H');
    expect(await session.viewportLines()).toEqual(before);
    expect(styled).not.toHaveBeenCalled();
    expect(session.getStalled()).toEqual(state);
    await session.resize(120, 30);
    await sleep(1400);
    expect(session.getStalled()).toEqual(state);
    expect(transitions).toEqual([state]);
  });
  it('preserves the notice when a padded native frame is redrawn after reflow', async () => {
    const { session, transitions, draw } = make();
    // ConPTY prints trailing spaces on styled rows. Reflow wraps those
    // spaces too, before the native terminal repaints its original text.
    const padded = refusal.split('\r\n').map(line => line.startsWith('  \x1b')
      ? line + ' '.repeat(Math.max(0, 120 - stripVTControlCharacters(line).length)) : line).join('\r\n');
    await draw(padded);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await session.resize(80, 24);
    await draw('\x1b[?25h');
    expect(session.getStalled()).toEqual(state);
    await draw(refusal);
    expect(session.getStalled()).toEqual(state);
    await session.resize(120, 30);
    await sleep(1400);
    expect(transitions).toEqual([state]);
  });
  for (const name of ['copy', 'sidebar', 'style']) {
    it(`keeps one stall and suppresses its unchanged refusal through ${name} changes`, async () => {
      const { session, transitions, draw } = make();
      await draw(refusal);
      await sleep(1400);
      const state = session.getStalled();
      expect(state).toBeDefined();
      const changed = name === 'copy' ? refusal.replace('⎘ copy', '⎘ copied') :
        name === 'sidebar' ? fixture('sidebar') : refusal.replace('The request was rejected', '\x1b[1mThe request was rejected');
      await draw(changed);
      expect(session.getStalled()).toEqual(state);
      await sleep(1400);
      expect(transitions).toEqual([state]);
      await session.write('x');
      await draw(refusal);
      await sleep(1400);
      expect(session.getStalled()).toBeUndefined();
      expect(transitions).toEqual([state, undefined]);
    });
  }
  it('keeps the same stall through 120x30 to 64x24 to 120x30 reflow', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await session.resize(64, 24);
    expect(session.getStalled()).toEqual(state);
    await draw(refusal);
    await sleep(1400);
    await session.resize(120, 30);
    await sleep(1400);
    expect(session.getStalled()).toEqual(state);
    expect(transitions).toEqual([state]);
  });
  it('recognises an initially wrapped refusal at 64 columns', async () => {
    const { session, draw } = make(64, 24);
    await draw(refusal);
    await sleep(1400);
    expect(session.getStalled()).toBeDefined();
  });
  it('confirms persistent frame loss after resizing below the supported floor', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await session.resize(40, 10);
    expect(session.getStalled()).toEqual(state);
    await sleep(1400);
    expect(transitions).toEqual([state, undefined]);
    await draw('\r\n     New ordinary output.');
    expect(session.getStalled()).toBeUndefined();
  });
  it('does not dismiss or suppress a stall for zero bytes', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    const state = session.getStalled();
    expect(state).toBeDefined();
    await session.write('');
    expect(session.getStalled()).toEqual(state);
    await draw(refusal);
    await sleep(1400);
    expect(transitions).toEqual([state]);
  });
  it('clears immediately when newer output appears below the composer', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await sleep(1400);
    expect(session.getStalled()).toBeDefined();
    await draw('\r\n     A newer answer follows.');
    expect(session.getStalled()).toBeUndefined();
    expect(transitions).toHaveLength(2);
  });
  it('coalesces busy repaints without reading styled history', async () => {
    const { session, draw } = make();
    await draw(Array.from({ length: 2000 }, () => '     Earlier neutral output\r\n').join('') +
      '\x1b[2J\x1b[H     ⠋ Thinking\r\n   esc to interrupt');
    const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
    const plain = 'plainViewport' in ScreenRenderer.prototype ? vi.spyOn(ScreenRenderer.prototype, 'plainViewport') : undefined;
    const started = performance.now();
    for (let i = 0; i < 35; i++) {
      await draw(`\x1b[1;1H     ⠋ Thinking ${i}`);
      await sleep(30);
    }
    const elapsed = performance.now() - started;
    expect(styled).not.toHaveBeenCalled();
    expect(plain?.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(elapsed / 250));
    expect(session.getStalled()).toBeUndefined();
  });
  it('suppresses the current refusal when input arrives before the discovery timer', async () => {
    const { session, transitions, draw } = make();
    await draw(refusal);
    await session.write('x');
    await draw(refusal.replace('⎘ copy', '⎘ copied'));
    await sleep(1400);
    expect(session.getStalled()).toBeUndefined();
    expect(transitions).toEqual([]);
  });
  for (const kind of ['no marker', 'no ink', 'no composer']) {
    it(`rejects ${kind} before reading styled context`, async () => {
      const { draw } = make();
      const styled = vi.spyOn(ScreenRenderer.prototype, 'styledLines');
      const data = kind === 'no marker' ? '     Ordinary answer\r\n  ╹▀▀▀▀' :
        kind === 'no ink' ? refusal.replaceAll('\x1b[38;2;251;113;133m', '') :
          refusal.slice(0, refusal.indexOf('ctrl+p')).replaceAll('╹', ' ');
      await draw(data);
      await sleep(400);
      expect(styled).not.toHaveBeenCalled();
    });
  }
});
