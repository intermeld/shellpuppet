import { afterEach, describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectPrompt } from '../../src/core/promptDetector.js';
import { markFilteredSelectedOption } from '../../src/core/selection.js';

const renderers: ScreenRenderer[] = [];

function makeRenderer(cols = 40, rows = 5, scrollback = 100): ScreenRenderer {
  const r = new ScreenRenderer({ cols, rows, scrollback });
  renderers.push(r);
  return r;
}

afterEach(() => {
  while (renderers.length > 0) renderers.pop()?.dispose();
});

describe('ScreenRenderer.snapshot', () => {
  it('marks an inverse-video selected menu option in text and reports its index', async () => {
    const r = makeRenderer(60, 6);
    await r.write('Choose a build?\r\n  1. Debug\r\n\x1b[7m  2. Release\x1b[0m');
    const screen = r.snapshot().screen;
    expect(screen).toContain('⟦SP:selected⟧   2. Release');
    expect(detectPrompt(screen)?.options).toEqual(['1. Debug', '2. Release']);
    expect(detectPrompt(screen)?.selectedOption).toBe(1);
    expect(r.lastLines(2)).toEqual(['  1. Debug', '⟦SP:selected⟧   2. Release']);
    expect(await r.serialize()).not.toContain('⟦SP:selected⟧');
  });

  it('marks a background-colour selected menu option', async () => {
    const r = makeRenderer(60, 6);
    await r.write('Choose a build?\r\n\x1b[44m  1. Debug\x1b[0m\r\n  2. Release');
    expect(r.snapshot().screen).toContain('⟦SP:selected⟧   1. Debug');
  });

  it('leaves ordinary highlighting and unstyled menus alone', async () => {
    const r = makeRenderer(60, 6);
    await r.write('Status: \x1b[7mREADY\x1b[0m\r\nChoose a build?\r\n  1. Debug\r\n  2. Release');
    expect(r.snapshot().screen).toBe('Status: READY\nChoose a build?\n  1. Debug\n  2. Release');
  });

  it('keeps the same prompt signature as a styled selection moves', async () => {
    const r = makeRenderer(60, 6);
    await r.write('Choose a build?\r\n\x1b[7m  1. Debug\x1b[0m\r\n  2. Release');
    const first = detectPrompt(r.snapshot().screen)!;
    await r.write('\x1b[2;1H\x1b[0K  1. Debug\x1b[3;1H\x1b[7m  2. Release\x1b[0m');
    const moved = detectPrompt(r.snapshot().screen)!;
    expect(moved.signature).toBe(first.signature);
    expect(first.selectedOption).toBe(0);
    expect(moved.options).toEqual(['1. Debug', '2. Release']);
    expect(moved.selectedOption).toBe(1);
  });

  it('does not infer a selection when two option rows are highlighted', async () => {
    const r = makeRenderer(60, 6);
    await r.write('Choose a build?\r\n\x1b[7m  1. Debug\x1b[0m\r\n\x1b[44m  2. Release\x1b[0m');
    const screen = r.snapshot().screen;
    expect(screen).toBe('Choose a build?\n  1. Debug\n  2. Release');
    expect(detectPrompt(screen)?.selectedOption).toBeUndefined();
  });

  it('does not infer a selection from a highlighted keyword under half the row', async () => {
    const r = makeRenderer(60, 6);
    await r.write('Choose a build?\r\n  1. \x1b[7mAlpha\x1b[0mBeta\r\n  2. Release');
    const screen = r.snapshot().screen;
    expect(screen).toBe('Choose a build?\n  1. AlphaBeta\n  2. Release');
    expect(detectPrompt(screen)?.selectedOption).toBeUndefined();
  });

  it('keeps the selection marker when preceding reasoning is filtered', async () => {
    const r = makeRenderer(60, 6);
    await r.write('Thinking\r\nChoose a build?\r\n  1. Debug\r\n\x1b[44m  2. Release\x1b[0m');
    const filtered = ['[reasoning hidden: 1 line]', 'Choose a build?', '  1. Debug', '  2. Release'];
    expect(markFilteredSelectedOption(filtered, r.styledLines().lines)).toEqual([
      '[reasoning hidden: 1 line]', 'Choose a build?', '  1. Debug', '⟦SP:selected⟧   2. Release',
    ]);
    expect(detectPrompt(markFilteredSelectedOption(filtered, r.styledLines().lines).join('\n'))?.selectedOption).toBe(1);
  });

  it('renders plain text with the cursor after it', async () => {
    const r = makeRenderer();
    await r.write('hello');
    const snap = r.snapshot();
    expect(snap.screen).toBe('hello');
    expect(snap.cursor).toEqual({ x: 5, y: 0 });
  });

  it('applies cursor movement sequences', async () => {
    const r = makeRenderer();
    await r.write('abc\x1b[1;1HX'); // move to row 1 col 1, overwrite the a
    expect(r.snapshot().screen).toBe('Xbc');
  });

  it('clears the screen on ED2 + home', async () => {
    const r = makeRenderer();
    await r.write('line1\r\nline2\r\nline3');
    await r.write('\x1b[2J\x1b[H');
    const snap = r.snapshot();
    expect(snap.screen).toBe('');
    expect(snap.cursor).toEqual({ x: 0, y: 0 });
  });

  it('wraps long lines at the column limit', async () => {
    const r = makeRenderer(10, 5);
    await r.write('abcdefghijKL');
    expect(r.snapshot().lines).toEqual(['abcdefghij', 'KL']);
  });

  it('preserves interior blank lines while trimming the blank tail', async () => {
    const r = makeRenderer();
    await r.write('a\r\n\r\nb');
    expect(r.snapshot().lines).toEqual(['a', '', 'b']);
  });

  it('renders wide (CJK) characters, occupying two cells each', async () => {
    const r = makeRenderer();
    await r.write('你好');
    const snap = r.snapshot();
    expect(snap.screen).toBe('你好');
    expect(snap.cursor.x).toBe(4); // two cells per character
  });

  it('switches to the alternate screen buffer and back', async () => {
    const r = makeRenderer();
    await r.write('main content');
    // Enter the alt screen and home the cursor: 1049 preserves the cursor
    // position across the switch, so real TUIs home it before drawing.
    await r.write('\x1b[?1049h\x1b[H');
    expect(r.snapshot().screen).toBe('');
    await r.write('alt content');
    expect(r.snapshot().screen).toBe('alt content');
    await r.write('\x1b[?1049l'); // leave alt screen
    expect(r.snapshot().screen).toBe('main content');
  });

  it('shows only the final viewport once output scrolls', async () => {
    const r = makeRenderer(40, 3, 100);
    await r.write(['one', 'two', 'three', 'four', 'five'].join('\r\n'));
    expect(r.snapshot().lines).toEqual(['three', 'four', 'five']);
  });

  it('reports new geometry after resize', async () => {
    const r = makeRenderer(40, 5);
    await r.write('resize me');
    r.resize(80, 10);
    const snap = r.snapshot();
    expect(snap.cols).toBe(80);
    expect(snap.rows).toBe(10);
    expect(snap.screen).toContain('resize me');
  });
});

describe('ScreenRenderer.lastLines', () => {
  it('crosses the scrollback boundary in order', async () => {
    // Design §6 names this case explicitly: lastLines across the scrollback
    // boundary. 20 lines into a 5-row viewport → lines 1 to 15 live in
    // scrollback, 16 to 20 in the viewport. Asking for 10 must span both, in order.
    const r = makeRenderer(40, 5, 100);
    const numbered = Array.from({ length: 20 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`);
    await r.write(numbered.join('\r\n'));

    expect(r.snapshot().lines).toEqual(numbered.slice(15)); // viewport: 16 to 20
    expect(r.lastLines(10)).toEqual(numbered.slice(10)); // 11 to 20: scrollback + viewport
  });

  it('returns everything written when asked for more than exists', async () => {
    const r = makeRenderer(40, 5, 100);
    await r.write('a\r\nb\r\nc');
    expect(r.lastLines(500)).toEqual(['a', 'b', 'c']);
  });

  it('ignores the blank viewport tail but keeps interior blanks', async () => {
    const r = makeRenderer(40, 10, 100);
    await r.write('top\r\n\r\nbottom');
    expect(r.lastLines(3)).toEqual(['top', '', 'bottom']);
  });

  it('returns an empty array for a blank terminal or a non-positive count', async () => {
    const r = makeRenderer();
    expect(r.lastLines(5)).toEqual([]);
    await r.write('x');
    expect(r.lastLines(0)).toEqual([]);
    expect(r.lastLines(-3)).toEqual([]);
  });
});

describe('ScreenRenderer.flush', () => {
  it('resolves only after queued writes are parsed', async () => {
    const r = makeRenderer();
    // Deliberately not awaiting the individual writes.
    void r.write('first ');
    void r.write('second');
    await r.flush();
    expect(r.snapshot().screen).toBe('first second');
  });
});
