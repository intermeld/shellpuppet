/**
 * Cursor visibility and bracketed paste as tracked from program output: what
 * the viewer snapshot appends when the program has hidden its cursor (design
 * §5), and whether a long write goes out as one paste.
 */

import { describe, expect, it } from 'vitest';
import { bracketedPasteAfter, cursorHiddenAfter } from '../../src/core/session.js';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
/**
 * A full terminal reset (RIS) and a soft one (DECSTR): both clear DEC 2004,
 * and both show the cursor.
 */
const RIS = '\x1bc';
const DECSTR = '\x1b[!p';

describe('cursorHiddenAfter', () => {
  it('keeps the last state when a chunk says nothing about the cursor', () => {
    expect(cursorHiddenAfter('plain text', true)).toBe(true);
    expect(cursorHiddenAfter('plain text', false)).toBe(false);
  });

  it('takes the last transition in a chunk', () => {
    expect(cursorHiddenAfter(`${HIDE}draw${SHOW}`, false)).toBe(false);
    expect(cursorHiddenAfter(`${SHOW}draw${HIDE}`, false)).toBe(true);
  });

  it('treats a terminal reset as the cursor coming back', () => {
    // A program that hid its cursor and then reset the terminal, with RIS or
    // DECSTR, has a visible cursor.
    expect(cursorHiddenAfter(`${HIDE}${RIS}`, false)).toBe(false);
    expect(cursorHiddenAfter(`${HIDE}${DECSTR}`, false)).toBe(false);
    expect(cursorHiddenAfter(RIS, true)).toBe(false);
    // ...and a hide after the reset still counts.
    expect(cursorHiddenAfter(`${RIS}${HIDE}`, false)).toBe(true);
  });
});

describe('bracketedPasteAfter', () => {
  it('keeps the last state when a chunk says nothing about the mode', () => {
    expect(bracketedPasteAfter('plain text', true)).toBe(true);
    expect(bracketedPasteAfter('plain text', false)).toBe(false);
  });

  it('takes the last transition in a chunk', () => {
    expect(bracketedPasteAfter(`${PASTE_ON}draw${PASTE_OFF}`, false)).toBe(false);
    expect(bracketedPasteAfter(`${PASTE_OFF}draw${PASTE_ON}`, false)).toBe(true);
  });

  it('treats a terminal reset as the mode going off', () => {
    // The emulator the daemon mirrors resets DEC 2004 on both RIS and
    // DECSTR, and so does this scan: after a reset the program does not
    // expect paste markers, and would read them around a long write as
    // literal input.
    expect(bracketedPasteAfter(`${PASTE_ON}${RIS}`, false)).toBe(false);
    expect(bracketedPasteAfter(`${PASTE_ON}${DECSTR}`, false)).toBe(false);
    expect(bracketedPasteAfter(RIS, true)).toBe(false);
    // ...and enabling it again after the reset still counts.
    expect(bracketedPasteAfter(`${RIS}${PASTE_ON}`, false)).toBe(true);
  });
});
