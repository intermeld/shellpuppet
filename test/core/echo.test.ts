/**
 * The echo locator behind `matchAfterInput`. The shapes are the
 * two families a wait runs against: a line-mode shell that echoes the
 * command on the prompt line, and an agent TUI that re-renders the submitted
 * prompt in its transcript, wrapped at its own width.
 */

import { describe, expect, it } from 'vitest';
import { echoEnd, screenShows } from '../../src/core/echo.js';

describe('echoEnd', () => {
  it('places the end of a shell echo so output below it is after the input', () => {
    const screen = "PS D:\\work> Write-Host 'HELLO'\nHELLO\nPS D:\\work>";
    const end = echoEnd(screen, "Write-Host 'HELLO'\r");
    expect(end).not.toBeNull();
    // Everything from the echo's end onward is the program's, echo excluded.
    expect(screen.slice(end ?? 0)).toBe('\nHELLO\nPS D:\\work>');
  });

  it('finds a prompt the TUI re-wrapped across rows with its own indent', () => {
    const typed = 'List the Python files: set PY_FILES = the files under src, then print them';
    const screen = [
      '│ > List the Python files: set PY_FILES = the files',
      '│   under src, then print them',
      '',
      '● PY_FILES = a.py b.py',
    ].join('\n');
    const end = echoEnd(screen, typed);
    expect(end).not.toBeNull();
    // The match that counts is the program's line, not the wrapped echo.
    expect(screen.slice(end ?? 0)).toContain('● PY_FILES = a.py b.py');
    expect(screen.slice(end ?? 0)).not.toContain('List the Python');
  });

  it('uses the LAST occurrence: the transcript rendering, not older history', () => {
    const screen = 'earlier: run tests\n> run tests\nok';
    const end = echoEnd(screen, 'run tests\r');
    expect(screen.slice(end ?? 0)).toBe('\nok');
  });

  it('returns null for control-only input such as Enter or an arrow key', () => {
    expect(echoEnd('anything\n1. Allow', '\r')).toBeNull();
    expect(echoEnd('anything\n1. Allow', '\x1b[A')).toBeNull();
    expect(echoEnd('anything\n1. Allow', '\x1b[1;5C')).toBeNull();
  });

  it('returns null for a head too short to be distinctive', () => {
    expect(echoEnd('ls\nfile.txt', 'ls\r')).toBeNull();
  });

  it('returns null when the echo is not on screen (hidden input, scrolled away)', () => {
    expect(echoEnd('Password:\n\nLogin OK', 'hunter2-secret\r')).toBeNull();
  });

  it('places only the printable head of a multi-line paste', () => {
    const typed = 'first line of the prompt\nsecond line\n';
    const screen = '> first line of the prompt\n  second line\nresult';
    const end = echoEnd(screen, typed);
    expect(screen.slice(end ?? 0)).toBe('\n  second line\nresult');
  });
});

/**
 * The check behind `terminal_type`'s verify. The input box shapes are
 * OpenCode's: a `┃` border down the left and, on a wide screen, a side panel
 * on the same rows.
 */
describe('screenShows', () => {
  const box = (rows: string[]): string => rows.map((row) => `  ┃  ${row}`).join('\n');
  const typed = 'ending with the verdict line, and when everything is complete reply';

  it('finds text wrapped inside a bordered input box', () => {
    const screen = box(['ending with the verdict line, and when', 'everything is complete reply', '']);
    expect(screenShows(screen, typed)).toBe(true);
  });

  it('finds text wrapped past a side panel drawn on the same rows', () => {
    const screen = box([
      'ending with the verdict line, and when      Free models are included',
      'everything is complete reply                so you can start now.',
    ]);
    expect(screenShows(screen, typed)).toBe(true);
  });

  it('finds it when the panel starts with the next letter of the text', () => {
    const screen = box([
      'ending with the verdict line, and when      everything you need',
      'everything is complete reply',
    ]);
    expect(screenShows(screen, typed)).toBe(true);
  });

  it('carries on across several rows, with the panel beside only some of them', () => {
    const screen = box([
      'ending with the',
      'verdict line, and      Getting started',
      'when everything is',
      'complete reply',
    ]);
    expect(screenShows(screen, typed)).toBe(true);
  });

  it('does not find text that is not on screen', () => {
    expect(screenShows(box(['Ask anything', '']), typed)).toBe(false);
  });

  it('does not find a head that is missing, even with the tail on screen', () => {
    const screen = box(['line, and when everything is complete reply']);
    expect(screenShows(screen, 'ending with the verdict')).toBe(false);
  });

  it('does not join a row to one below that does not start with the rest', () => {
    const screen = box([
      'ending with the verdict line, and when',
      'something else entirely',
      'everything is complete reply',
    ]);
    expect(screenShows(screen, typed)).toBe(false);
  });

  it('does not skip a blank row between the pieces', () => {
    const screen = box(['ending with the verdict line, and when', '', 'everything is complete reply']);
    expect(screenShows(screen, typed)).toBe(false);
  });

  it('does not break a row mid-word to carry on below', () => {
    const screen = box(['ending with the verdict line, and whenzzz', 'everything is complete reply']);
    expect(screenShows(screen, typed)).toBe(false);
  });

  it('reads rows one at a time only where they changed since the text was typed', () => {
    // Two spaces cannot tell a panel from a table's next column: a row whose
    // text runs on into the next can only be told by what the typing changed.
    const panel = 'alpha  WRONG\nbeta';
    expect(screenShows(panel, 'alpha beta')).toBe(true);
    expect(screenShows(panel, 'alpha beta', panel)).toBe(false);

    const table = ['NAME    STATE', 'alpha   rejected', 'beta    pending'].join('\n');
    expect(screenShows(table, 'alpha beta', table)).toBe(false);

    // A long input that lost its front: only its end was drawn, in the box under
    // a table whose cells happen to hold the front's words.
    const earlier = `${table}\n${box([''])}`;
    const now = `${table}\n${box(['beta gamma delta'])}`;
    expect(screenShows(now, 'alpha beta', earlier)).toBe(false);
    expect(screenShows(now, 'beta gamma delta', earlier)).toBe(true);
  });

  it('wants new characters in each piece, not just a row where something else changed', () => {
    // The table's clock ticks; its words stay where they were.
    const earlier = ['alpha  rejected 12:00', 'beta   pending 12:00'].join('\n');
    const now = ['alpha  rejected 12:01', 'beta   pending 12:01'].join('\n');
    expect(screenShows(now, 'alpha beta', earlier)).toBe(false);

    // A long input whose front never landed, under that table: only its end
    // was drawn in the box, while the clock ticked in the rows above it.
    const tableAt = (time: string): string =>
      ['NAME    STATE', `alpha   rejected ${time}`, `beta    pending  ${time}`].join('\n');
    expect(
      screenShows(`${tableAt('12:01')}\n${box(['gamma delta'])}`, 'alpha beta', `${tableAt('12:00')}\n${box([''])}`),
    ).toBe(false);
  });

  it('finds typed text whose piece matches what stood there, when what followed it is gone', () => {
    // A placeholder that began with the same word as the text typed over it.
    expect(screenShows('│ Ask\n│ something', 'Ask something', '│ Ask anything\n│ ')).toBe(true);
    // Earlier input replaced by text that shares its first, middle or last word.
    expect(screenShows('│ alpha\n│ beta', 'alpha beta', '│ alpha old\n│ old')).toBe(true);
    expect(screenShows('│ alpha\n│ beta', 'alpha beta', '│ old\n│ beta obsolete')).toBe(true);
    expect(screenShows('│ alpha\n│ beta\n│ gamma', 'alpha beta gamma', '│ old\n│ beta obsolete\n│ old')).toBe(true);
    expect(screenShows('│ alpha\n│ >', 'alpha >', '│ placeholder\n│ > choose')).toBe(true);
    // Nothing gone and nothing new: the same text where it already stood.
    expect(screenShows('│ alpha\n│ beta', 'alpha beta', '│ alpha\n│ beta')).toBe(false);
    // An old word beside a ticking clock, its closing border still standing after
    // it, is not new because the next row's word is.
    expect(screenShows('x2  alpha │\nbeta      │', 'alpha beta', 'x1  alpha │\nold       │')).toBe(false);
  });

  it('still finds new text in an input box beside a panel that changed too', () => {
    const earlier = box([
      'Ask anything                                Context 10%',
      '                                            Getting started',
    ]);
    const now = box([
      'ending with the verdict line, and when      Context 11%',
      'everything is complete reply                Getting started',
    ]);
    expect(screenShows(now, typed, earlier)).toBe(true);
  });

  it('does not leave a row at a single space: the words after it are on the row', () => {
    expect(screenShows('alpha WRONG\nbeta', 'alpha beta')).toBe(false);
    expect(screenShows(box(['ending with the verdict line, and when WRONG', 'everything is complete reply']), typed)).toBe(
      false,
    );
  });

  it("does not join a table's rows, whose columns are set apart by box drawing", () => {
    const table = ['│ alpha      │ rejected │', '│ beta       │ pending  │'].join('\n');
    expect(screenShows(table, 'alpha beta')).toBe(false);
  });

  it('does not join two panes side by side', () => {
    expect(screenShows('│ alpha │ beta │', 'alpha beta')).toBe(false);
  });

  it('wants typed box drawing on screen', () => {
    expect(screenShows('empty input', '┌─┐')).toBe(false);
    expect(screenShows('alphabeta', 'alpha│beta')).toBe(false);
    expect(screenShows('alpha│beta', 'alpha│beta')).toBe(true);
  });

  it("does not read a panel's own text as the box's, past a wide indent", () => {
    // An empty input box, its panel's two labels typed as the text.
    const screen = [`  ┃  ${' '.repeat(47)}Getting started`, `  ┃  ${' '.repeat(47)}Free models are included`].join(
      '\n',
    );
    expect(screenShows(screen, 'Getting startedFree models are included')).toBe(false);
  });

  it('stays cheap on the largest screen, built against the text', () => {
    // 1000 x 500: the text's first character everywhere, with gaps that each
    // could be the end of a row's part, and its last character only at the top.
    const text = `${'a'.repeat(39)}b`;
    for (const row of ['a '.repeat(500), 'a  '.repeat(333), `│ ${'a  '.repeat(332)}`]) {
      const screen = `b\n${Array.from({ length: 500 }, () => row).join('\n')}`;
      const started = performance.now();
      expect(screenShows(screen, text)).toBe(false);
      // About 60 ms here; without the step budget, 250 to 400 ms.
      expect(performance.now() - started).toBeLessThan(300);
    }
  });

  it('spends the reading on the rows the typing changed, not on a full screen above them', () => {
    // 300 rows of the text's first character, unchanged, over the box that
    // shows the text: read every row, and the budget runs out before the box.
    const data = Array.from({ length: 300 }, () => '0'.repeat(160)).join('\n');
    const text = `${'0'.repeat(39)}1`;
    const earlier = `${data}\n${box(['', ''])}`;
    const now = `${data}\n${box(['00000000000000000000', '00000000000000000001'])}`;
    expect(screenShows(now, text, earlier)).toBe(true);
  });

  it('still finds wrapped text under a full screen of prose', () => {
    const prose = 'the quick brown fox jumps over the lazy dog, then the next one does the same; ';
    const above = Array.from({ length: 146 }, () => prose.repeat(5).slice(0, 400));
    const input = box(['ending with the verdict line, and when', 'everything is complete reply', '']);
    const screen = `${above.join('\n')}\n${input}`;
    expect(screenShows(screen, typed)).toBe(true);
  });
});
