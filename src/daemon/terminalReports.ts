/**
 * Which viewer messages are the viewer's terminal answering the program,
 * rather than a person typing (design §4.5, §5).
 *
 * The viewer page is a real terminal (xterm.js). A program can ask its
 * terminal where the cursor is, what kind of terminal it is, whether a mode
 * is set or which colours it draws with, and it can switch on focus reporting
 * (DECSET 1004), after which the terminal says at once whether it has focus
 * and again whenever that changes. xterm.js sends each answer through
 * `onData`, the channel keystrokes take, so it reaches the daemon as a viewer
 * message like any keystroke. The daemon writes it to the program either way,
 * because the program asked for it; this module only says what it is, so that
 * the audit log and the "last input" indicator do not take it for a person's
 * keystroke.
 *
 * A message is a report only when the WHOLE message is one of the sequences
 * below. xterm.js hands each answer to `onData` on its own, and the page sends
 * each `onData` string as one message, so an answer always arrives alone.
 * Anything else is input, including a paste that merely contains such bytes.
 * A paste of exactly one answer's bytes, and nothing else, cannot be told
 * from the answer itself and is filed as a report: every such shape is
 * escape bytes carrying terminal state, never text.
 *
 * The set is what the bundled xterm.js (`@xterm/xterm` 6) sends, read from its
 * source, as the viewer configures it. Under the default terminal name
 * (`xterm`) each device-attributes query has one answer, and with no
 * `windowOptions` the window-size reports (`CSI 4`, `6` and `8 ; … t`) are
 * never sent. xterm.js answers no XTVERSION query.
 *
 * Pure: no I/O.
 */

/** What a terminal report says, as the audit log names it. */
export type TerminalReportKind =
  | 'focus-in'
  | 'focus-out'
  | 'cursor-position'
  | 'device-status'
  | 'device-attributes'
  | 'mode-report'
  | 'colour'
  | 'status-string';

/* eslint-disable no-control-regex -- escape sequences are what this table matches */
const REPORTS: readonly { kind: TerminalReportKind; pattern: RegExp }[] = [
  // Focus reporting: the page gained or lost focus, or had it or not when
  // the program set DECSET 1004 (CoreBrowserTerminal `_handleTextAreaFocus`,
  // `_handleTextAreaBlur` and `_reportFocus`).
  { kind: 'focus-in', pattern: /^\x1b\[I$/ },
  { kind: 'focus-out', pattern: /^\x1b\[O$/ },
  // CPR and DECXCPR: the cursor's row and column, counted from 1, answering
  // `CSI 6 n` and `CSI ? 6 n` (InputHandler `deviceStatus`,
  // `deviceStatusPrivate`).
  { kind: 'cursor-position', pattern: /^\x1b\[\??[1-9]\d*;[1-9]\d*R$/ },
  // DSR 5: the terminal saying it is working (InputHandler `deviceStatus`).
  { kind: 'device-status', pattern: /^\x1b\[0n$/ },
  // Primary and secondary device attributes, DA1 and DA2 (InputHandler
  // `sendDeviceAttributesPrimary`, `sendDeviceAttributesSecondary`).
  { kind: 'device-attributes', pattern: /^\x1b\[(?:\?1;2|>0;276;0)c$/ },
  // DECRPM answering DECRQM, for ANSI and DEC private modes: the mode asked
  // about and its state, 0 to 4 (InputHandler `requestMode`).
  { kind: 'mode-report', pattern: /^\x1b\[\??(?:0|[1-9]\d*);[0-4]\$y$/ },
  // OSC 4, 10, 11 and 12 queries: a palette entry from 0 to 255, or the
  // foreground, background or cursor colour, at sixteen bits a channel
  // (CoreBrowserTerminal `_handleColorEvent`).
  {
    kind: 'colour',
    pattern:
      /^\x1b\](?:4;(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|1[0-2]);rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\$/,
  },
  // DECRPSS answering DECRQSS: the protection attribute, the conformance
  // level, the scroll margins, the text attributes or the cursor style, or 0
  // for a request xterm.js does not answer (InputHandler
  // `requestStatusString`).
  {
    kind: 'status-string',
    pattern: /^\x1bP(?:1\$r(?:[01]"q|61;1"p|[1-9]\d*;[1-9]\d*r|0m|[1-6] q)|0\$r)\x1b\\$/,
  },
];

/**
 * F3 with a modifier is `CSI 1 ; m R`, m from 2 to 16 (xterm.js's keyboard
 * map), the same bytes as a cursor-position answer for row 1, columns 2 to
 * 16. Nothing in the message says which it was, and a keystroke must never be
 * filed as something nobody typed, so those stay input.
 */
const MODIFIED_F3 = /^\x1b\[1;(?:[2-9]|1[0-6])R$/;
/* eslint-enable no-control-regex */

/**
 * The kind of terminal report a viewer message is, or `null` when it is
 * input: a keystroke, a paste or anything else a person may have sent.
 */
export function terminalReportKind(message: string): TerminalReportKind | null {
  if (MODIFIED_F3.test(message)) return null;
  return REPORTS.find(({ pattern }) => pattern.test(message))?.kind ?? null;
}
