/**
 * Which viewer messages are the viewer's terminal answering the program
 * (design §4.5, §5). The positives are the answers xterm.js sends, as its
 * source builds them and, for the ones its shared parser gives, as a real
 * emulator produces them. The negatives are what a person can send, the
 * nearest neighbours first.
 */

import xterm from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { keyToBytes, knownKeys } from '../../src/core/keys.js';
import { terminalReportKind } from '../../src/daemon/terminalReports.js';
import type { TerminalReportKind } from '../../src/daemon/terminalReports.js';

// Same CJS-bundle caveat as src/core/renderer.ts: default import, then destructure.
const { Terminal } = xterm;

const ESC = '\x1b';
const ST = `${ESC}\\`;

describe('terminalReportKind: the answers xterm.js sends on its own', () => {
  it.each<[string, TerminalReportKind, string]>([
    // CoreBrowserTerminal: focus gained or lost, and the state at the moment
    // the program sets DECSET 1004.
    ['focus gained', 'focus-in', `${ESC}[I`],
    ['focus lost', 'focus-out', `${ESC}[O`],
    // InputHandler deviceStatus and deviceStatusPrivate: CPR and DECXCPR.
    ['CPR at the origin', 'cursor-position', `${ESC}[1;1R`],
    ['CPR mid-screen', 'cursor-position', `${ESC}[24;80R`],
    ['CPR on row 1 past the keyboard range', 'cursor-position', `${ESC}[1;17R`],
    ['CPR on row 2, column 2', 'cursor-position', `${ESC}[2;2R`],
    ['DECXCPR on row 1, column 2', 'cursor-position', `${ESC}[?1;2R`],
    ['DECXCPR on a large grid', 'cursor-position', `${ESC}[?150;401R`],
    // InputHandler deviceStatus: DSR 5.
    ['DSR 5', 'device-status', `${ESC}[0n`],
    // InputHandler sendDeviceAttributesPrimary and ...Secondary, as the
    // terminal name `xterm` answers them.
    ['DA1', 'device-attributes', `${ESC}[?1;2c`],
    ['DA2', 'device-attributes', `${ESC}[>0;276;0c`],
    // InputHandler requestMode: DECRPM, DEC private and ANSI, every state.
    ['focus reporting set', 'mode-report', `${ESC}[?1004;1$y`],
    ['bracketed paste reset', 'mode-report', `${ESC}[?2004;2$y`],
    ['a mode permanently set', 'mode-report', `${ESC}[?8;3$y`],
    ['a mode permanently reset', 'mode-report', `${ESC}[?67;4$y`],
    ['an unrecognised private mode', 'mode-report', `${ESC}[?12345;0$y`],
    ['an ANSI mode', 'mode-report', `${ESC}[4;2$y`],
    ['a query with no mode', 'mode-report', `${ESC}[0;0$y`],
    // CoreBrowserTerminal _handleColorEvent, in the viewer's theme and
    // xterm.js's default palette.
    ['the foreground', 'colour', `${ESC}]10;rgb:c5c5/cdcd/d9d9${ST}`],
    ['the background', 'colour', `${ESC}]11;rgb:0b0b/0e0e/1414${ST}`],
    ['the cursor', 'colour', `${ESC}]12;rgb:6c6c/b6b6/ffff${ST}`],
    ['palette entry 0', 'colour', `${ESC}]4;0;rgb:2e2e/3434/3636${ST}`],
    ['palette entry 1', 'colour', `${ESC}]4;1;rgb:cccc/0000/0000${ST}`],
    ['palette entry 255', 'colour', `${ESC}]4;255;rgb:eeee/eeee/eeee${ST}`],
    // InputHandler requestStatusString: DECRPSS.
    ['the protection attribute', 'status-string', `${ESC}P1$r0"q${ST}`],
    ['the conformance level', 'status-string', `${ESC}P1$r61;1"p${ST}`],
    ['the scroll margins', 'status-string', `${ESC}P1$r1;24r${ST}`],
    ['the text attributes', 'status-string', `${ESC}P1$r0m${ST}`],
    ['a blinking block cursor', 'status-string', `${ESC}P1$r1 q${ST}`],
    ['a steady bar cursor', 'status-string', `${ESC}P1$r6 q${ST}`],
    ['a request xterm.js does not answer', 'status-string', `${ESC}P0$r${ST}`],
  ])('%s is a %s report', (_label, kind, message) => {
    expect(terminalReportKind(message)).toBe(kind);
  });
});

describe('terminalReportKind: answers from a real xterm.js parser', () => {
  // @xterm/headless is built from the same source as the viewer's
  // @xterm/xterm, and these answers come from the parser the two share, so
  // the bytes are the emulator's own rather than a transcription.
  async function answersTo(query: string): Promise<string[]> {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const answers: string[] = [];
    term.onData((data) => answers.push(data));
    await new Promise<void>((resolve) => term.write(query, resolve));
    term.dispose();
    return answers;
  }

  it.each<[string, TerminalReportKind, string]>([
    ['DA1', 'device-attributes', `${ESC}[c`],
    ['DA2', 'device-attributes', `${ESC}[>c`],
    ['DSR 5', 'device-status', `${ESC}[5n`],
    ['CPR at row 7, column 33', 'cursor-position', `${ESC}[7;33H${ESC}[6n`],
    ['DECXCPR', 'cursor-position', `${ESC}[?6n`],
    ['DECRQM for focus reporting', 'mode-report', `${ESC}[?1004$p`],
    ['DECRQM for insert mode', 'mode-report', `${ESC}[4$p`],
    ['DECRQM with no mode', 'mode-report', `${ESC}[$p`],
    ['DECRQSS for the scroll margins', 'status-string', `${ESC}P$qr${ST}`],
    ['DECRQSS for the cursor style', 'status-string', `${ESC}P$q q${ST}`],
    ['DECRQSS for the text attributes', 'status-string', `${ESC}P$qm${ST}`],
    ['DECRQSS for something it does not answer', 'status-string', `${ESC}P$qz${ST}`],
  ])('the answer to %s is a %s report', async (_label, kind, query) => {
    const answers = await answersTo(query);
    expect(answers).toHaveLength(1);
    expect(terminalReportKind(answers[0] ?? '')).toBe(kind);
  });

  it('F3 with a modifier stays input, though a cursor answer on row 1 has the same bytes', async () => {
    // xterm.js's keyboard map sends F3 with a modifier as CSI 1 ; m R, m from
    // 2 to 16: every one of them stays input.
    for (let modifier = 2; modifier <= 16; modifier++) {
      expect(terminalReportKind(`${ESC}[1;${String(modifier)}R`), String(modifier)).toBeNull();
    }
    // The emulator really does answer with those bytes on row 1...
    expect(await answersTo(`${ESC}[1;5H${ESC}[6n`)).toEqual([`${ESC}[1;5R`]);
    // ...and just outside the keyboard's range the same shape is a report.
    expect(terminalReportKind(`${ESC}[1;1R`)).toBe('cursor-position');
    expect(terminalReportKind(`${ESC}[1;17R`)).toBe('cursor-position');
  });

  it("files a paste of exactly one answer's bytes as that report: nothing tells them apart", () => {
    // Nothing marks a paste, so a message that is byte for byte one answer is
    // that answer. With anything else in the message it is input (below).
    expect(terminalReportKind(`${ESC}[I`)).toBe('focus-in');
    expect(terminalReportKind(`${ESC}[2;5R`)).toBe('cursor-position');
  });

  it('keeps the scroll margins of a status-string answer at 1 or more, as xterm.js sends them', () => {
    expect(terminalReportKind(`${ESC}P1$r1;24r${ESC}\\`)).toBe('status-string');
    expect(terminalReportKind(`${ESC}P1$r0;80r${ESC}\\`)).toBeNull();
    expect(terminalReportKind(`${ESC}P1$r1;0r${ESC}\\`)).toBeNull();
  });
});

describe('terminalReportKind: what a person sends stays input', () => {
  it.each<[string, string]>([
    ['a printable key', 'a'],
    ['a word', 'hello'],
    ['Enter', '\r'],
    ['Alt+Enter', `${ESC}\r`],
    ['Tab', '\t'],
    ['Backspace', '\x7f'],
    ['Ctrl+C', '\x03'],
    ['a bare ESC', ESC],
    ['Alt+Escape', `${ESC}${ESC}`],
    // Arrows are three characters, like the focus reports.
    ['Up', `${ESC}[A`],
    ['Down', `${ESC}[B`],
    ['Right', `${ESC}[C`],
    ['Left', `${ESC}[D`],
    ['Ctrl+Up', `${ESC}[1;5A`],
    ['Home', `${ESC}[H`],
    ['End', `${ESC}[F`],
    ['Shift+Home', `${ESC}[1;2H`],
    ['Shift+Tab', `${ESC}[Z`],
    // SS3 keys: ESC O and a letter, no bracket, unlike focus-out.
    ['Up in application mode', `${ESC}OA`],
    ['Down in application mode', `${ESC}OB`],
    ['Right in application mode', `${ESC}OC`],
    ['Left in application mode', `${ESC}OD`],
    ['Home in application mode', `${ESC}OH`],
    ['End in application mode', `${ESC}OF`],
    ['F1', `${ESC}OP`],
    ['F2', `${ESC}OQ`],
    ['F3', `${ESC}OR`],
    ['F4', `${ESC}OS`],
    ['Ctrl+F1', `${ESC}[1;5P`],
    ['Ctrl+F2', `${ESC}[1;5Q`],
    ['Ctrl+F4', `${ESC}[1;5S`],
    ['F5', `${ESC}[15~`],
    ['Ctrl+F5', `${ESC}[15;5~`],
    ['Insert', `${ESC}[2~`],
    ['Delete', `${ESC}[3~`],
    ['Shift+Delete', `${ESC}[3;2~`],
    ['Page Up', `${ESC}[5~`],
    ['Page Down', `${ESC}[6~`],
    // Alt with a key is ESC and that key, which starts like a report and is
    // never one.
    ['Alt+[', `${ESC}[`],
    ['Alt+]', `${ESC}]`],
    ['Alt+Shift+I', `${ESC}I`],
    ['Alt+Shift+O', `${ESC}O`],
    ['Alt+Shift+P', `${ESC}P`],
    ['a mouse press (SGR)', `${ESC}[<0;10;5M`],
    ['a mouse release (SGR)', `${ESC}[<0;10;5m`],
  ])('%s', (_label, message) => {
    expect(terminalReportKind(message)).toBeNull();
  });

  it('every key an agent can name', () => {
    const names = [
      ...knownKeys().filter((name) => !name.includes('<') && name !== 'f1-f12'),
      ...Array.from({ length: 26 }, (_, i) => `ctrl+${String.fromCharCode(97 + i)}`),
      ...Array.from({ length: 12 }, (_, i) => `f${String(i + 1)}`),
    ];
    for (const name of names) {
      const bytes = keyToBytes(name);
      expect(bytes, name).not.toBeNull();
      expect(terminalReportKind(bytes ?? ''), name).toBeNull();
    }
  });

  it.each<[string, string]>([
    ['a CSI with nothing after it', `${ESC}[`],
    ['a cursor answer cut short', `${ESC}[12;4`],
    ['device attributes cut short', `${ESC}[?1;2`],
    ['a colour without its terminator', `${ESC}]11;rgb:0b0b/0e0e/1414`],
    ['a colour with half a terminator', `${ESC}]11;rgb:0b0b/0e0e/1414${ESC}`],
    ['a status string without its terminator', `${ESC}P1$r0m`],
  ])('part of a report: %s', (_label, message) => {
    expect(terminalReportKind(message)).toBeNull();
  });

  it.each<[string, string]>([
    ['text after a report', `${ESC}[Ia`],
    ['text before a report', `a${ESC}[I`],
    ['a line feed after a report', `${ESC}[I\n`],
    ['a report and Enter', `${ESC}[2;5R\r`],
    ['two reports in one message', `${ESC}[I${ESC}[O`],
    ['a report inside a bracketed paste', `${ESC}[200~${ESC}[I${ESC}[201~`],
    ['a bracketed paste of text', `${ESC}[200~hello${ESC}[201~`],
  ])('a report is only ever a whole message: %s', (_label, message) => {
    expect(terminalReportKind(message)).toBeNull();
  });

  it.each<[string, string]>([
    ['a colour in capitals', `${ESC}]11;rgb:0B0B/0E0E/1414${ST}`],
    ['a colour at eight bits a channel', `${ESC}]11;rgb:0b/0e/14${ST}`],
    ['a colour ended by BEL', `${ESC}]11;rgb:0b0b/0e0e/1414\x07`],
    ['a palette entry past 255', `${ESC}]4;256;rgb:0000/0000/0000${ST}`],
    ['a mode state past 4', `${ESC}[?1004;5$y`],
    ['a cursor row of 0', `${ESC}[0;1R`],
    ['a number with a leading zero', `${ESC}[01;1R`],
    ['device attributes under another terminal name', `${ESC}[?6c`],
    ['a window size, which the viewer never sends', `${ESC}[8;24;80t`],
  ])('a shape xterm.js does not send from the viewer: %s', (_label, message) => {
    expect(terminalReportKind(message)).toBeNull();
  });
});
