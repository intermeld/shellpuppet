import { onlyBlankRowsAfter, readingReadiness } from '../nudgeReading.js';
import type { NudgeReadiness, NudgeView } from '../types.js';
import { reading } from './reading.js';

const STATUS = /^ {2}Grok .+ [█░]{4,} \d+%$/u;
/**
 * The newline hint. Grok names Alt+Enter alone or both keys
 * (`Shift+Enter/Alt+Enter`), depending on the terminal it detects.
 */
const NEWLINE = String.raw`(?:Shift\+Enter\/)?Alt\+Enter:newline`;
/** Key hints under an idle composer after a turn; a typed line adds Enter and newline hints. */
const IDLE_HINTS = new RegExp(String.raw`^ {2}(?:Enter:send {2}│ {2}${NEWLINE} {2}│ {2})?Shift\+Tab:mode {2}│ {2}Ctrl\+x:shortcuts$`, 'u');
/**
 * Key hints under an empty composer while a turn runs. With a line already
 * queued, Enter on the empty composer would send the queue at once, so the
 * hints say so; a typed line still queues (see TYPED_BUSY_HINTS).
 */
const BUSY_HINTS = /^ {2}(?:Enter:send now {2}│ {2})?Shift\+Tab:mode {2}│ {2}Ctrl\+c:cancel(?: {2}│ {2}Ctrl\+b:send to bg)?(?: {2}│ {2}Ctrl\+;:queue)? {2}│ {2}Ctrl\+x:shortcuts$/u;
/** Key hints with text in the composer while a turn runs: Enter queues the line. */
const TYPED_BUSY_HINTS = new RegExp(String.raw`^ {2}Enter:queue {2}│ {2}${NEWLINE} {2}│ {2}Shift\+Tab:mode {2}│ {2}Ctrl\+c:cancel {2}│ {2}Ctrl\+Enter:send now {2}│ {2}Ctrl\+x:shortcuts$`, 'u');

export function readiness(view: NudgeView): NudgeReadiness {
  if (view.styled !== undefined && (view.styled.length !== view.rows.length ||
    view.styled.some((line, index) => line.text !== view.rows[index]))) return 'unknown';
  let at = -1;
  for (let i = view.rows.length - 1; i >= 0; i--) {
    if (/^ {2}│ > /u.test(view.rows[i] ?? '')) { at = i; break; }
  }
  const top = view.rows[at - 1] ?? '';
  const bottom = view.rows[at + 1] ?? '';
  if (at < 1 || !((/^ {2}╭─/u.test(top) && /^ {2}╰─/u.test(bottom)) ||
    (/^ {2}┌─/u.test(top) && /^ {2}└─/u.test(bottom)))) return 'unknown';
  const status = view.rows[at + 2] ?? '';
  const hints = view.rows[at + 3] ?? '';
  const afterTurn = STATUS.test(status) && IDLE_HINTS.test(hints);
  // During a turn the empty composer keeps the status row and shows the turn's
  // key hints. A typed line under those hints is queued by Enter.
  const busyEmpty = STATUS.test(status) && BUSY_HINTS.test(hints);
  const busyTyped = STATUS.test(status) && TYPED_BUSY_HINTS.test(hints) && view.expectedDraft !== undefined;
  // Before the first turn the status and key hints are replaced by a blank
  // row and a right-aligned build channel. A rotating hint line above the frame
  // (a tip, or an offer to resume another program's session) identifies this
  // layout; all three rows must be in the live bottom block.
  const welcome = status === '' && /^ {10,}\[stable\]$/u.test(hints) &&
    view.rows.slice(Math.max(0, at - 5), at - 1).some((row) => /^ {3}\S/u.test(row));
  if ((!afterTurn && !welcome && !busyEmpty && !busyTyped) || !onlyBlankRowsAfter(view.rows, at + 3)) return 'unknown';
  const original = view.rows[at]!;
  const close = original.lastIndexOf('│');
  if (close <= 6) return 'unknown';
  const body = original.slice(6, close).trimEnd();
  const rows = [...view.rows];
  rows[at] = `> ${body}`;
  // Grok paints its frame and footer rows to the full width, so xterm marks
  // each following row as a wrap. The frame and footer matched above prove
  // these rows are the live composer block, so the marks are dropped there.
  const styled = view.styled?.map((line, index) => {
    if (index === at) return { ...line, text: rows[at]!, spans: [], wrapped: false };
    return index >= at - 1 && index <= at + 3 ? { ...line, wrapped: false } : line;
  });
  const result = readingReadiness({ rows, styled, expectedDraft: view.expectedDraft,
    exactEmpty: view.exactEmpty }, { ...reading, composer: { text: '^> ' } }, {
    placeholder: '', continuations: false, placeholderInk: () => false,
    queueWhileBusy: busyEmpty || busyTyped,
    composerFramed: true,
  });
  // The turn's own hints prove it is running even when no busy line is drawn.
  if (busyEmpty && result === 'ready' && view.expectedDraft === undefined) return 'queue';
  return result;
}
