import type { CellStyle, StyledLine } from '../../core/renderer.js';

export const GOLD = '#ffbf00';
export const CREAM = '#fff8dc';
const GREY = '#8b8682';
export const hints = new Set([
  'Set a reminder or schedule a recurring task',
  'Draft a reply to the last email in my inbox',
  'Plan a feature, then build it step by step',
]);
export const busyHint = '☤ ❯ type to redirect this turn · Tab queues it for after';
const welcome = 'Welcome to Hermes Agent! Type your message or /help for commands.';
const activity = String.raw`(?:updated \d+ memor(?:y|ies)|ran \d+ commands?|called \d+ tools?|(?:edited|read) \d+ files?|searched \d+ paths?)`;
export const summary = new RegExp(String.raw`^─ (?:\d+m)?\d+(?:\.\d+)?s · (?:${activity} · )*\d{1,2}:\d{2} [AP]M$`, 'u');
const plainRule = /^─{4,}$/u;
const labelledRule = /^(─{4,} )(\S.*?) (─)$/u;
const spinner = /^── [⠀-⣿] .+ ─{3,}/u;
const gauge = /\[[█░]{10}\]/u;
const initialFooter = /^ ☤ \S+ · ctx -- · \[░{10}\] -- · \d+[smh] · ⏲ \d+s · .+ {2}\/ commands · @ files · ! shell$/u;
const usage = /^ ☤ \S+ · ~?\d+(?:\.\d+)?[KM]?\/\d+(?:\.\d+)?[KM]? pinned · \[[░█]{10}\] ~?\d+% · (?<detail>◎ \d+(?:\.\d+)?% · )?◷ \d+(?:\.\d+)?s · ↑ \d+ t\/s · /u;
const duration = String.raw`(?:\d+h(?: \d+m)?|\d+m(?: \d+s)?|\d+(?:\.\d+)?s)`;
const idleTime = new RegExp('^' + duration + ' · ⏲ ' + duration + ' · ✓ ' + duration + '$', 'u');
const clippedIdleTime = new RegExp('^' + duration + ' · ⏲ ' + duration + ' ·\\.\\.\\.$', 'u');
const busyClock = '^' + duration + ' · ⏱ ' + duration;
const busyTime = new RegExp(busyClock + '(?: +enter interrupt · tab queue · ctrl\\+c stop)?$', 'u');
const compactBusyTime = new RegExp(busyClock + '(?: · …[^\\s·]+)?$', 'u');

/** Every character in the slice must have a measured style. */
export function ink(line: StyledLine, from: number, to: number, match: (style: CellStyle) => boolean): boolean {
  let end = from;
  for (const span of line.spans) {
    if (span.to <= end) continue;
    if (span.from > end || !match(span)) return false;
    end = span.to;
    if (end >= to) return true;
  }
  return false;
}

export function colour(line: StyledLine, fg: string, bold = false): boolean {
  return ink(line, 0, line.text.length, s => s.fg === fg && s.bold === bold && !s.dim && !s.italic && !s.inverse);
}

export function transcriptRule(line: StyledLine | undefined): boolean {
  return !!line && line.text === '─'.repeat(40) && colour(line, GOLD);
}

export function completed(line: StyledLine | undefined): boolean {
  return !!line && summary.test(line.text) && ink(line, 0, line.text.length, s => s.dim && s.fg === null);
}

function footerKind(text: string): 'welcome' | 'idle' | 'busy' | undefined {
  if (initialFooter.test(text)) return 'welcome';
  const prefix = usage.exec(text);
  if (prefix) {
    const time = text.slice(prefix[0].length);
    if (!prefix.groups?.detail) return compactBusyTime.test(time) ? 'busy' : undefined;
    if (idleTime.test(time) || clippedIdleTime.test(time)) return 'idle';
    if (busyTime.test(time)) return 'busy';
  }
  if (/^ ☤ \S+ · ctx -- · \[░{10}\] -- · \d+[smh] · ⏱ \d+s +enter interrupt · tab queue · ctrl\+c stop$/u.test(text)) return 'busy';
}

function welcomeAbove(rows: readonly string[], top: number): boolean {
  return top >= 3 && rows[top - 3] === welcome && rows[top - 2]!.startsWith('✦ Tip: ') && rows[top - 1] === '';
}

/** The start wait receives text only. Input additionally requires the live ink and cursor. */
export function readyScreen(screen: string): boolean {
  const rows = screen.trimEnd().split('\n').map(row => row.trimEnd());
  const [top, input, bottom, footer] = rows.slice(-4);
  if (!top || !(plainRule.test(top) || labelledRule.test(top)) || !input ||
      !(input.startsWith('❯ ') && hints.has(input.slice(2))) ||
      !bottom || !plainRule.test(bottom) || bottom.length !== top.length || !footer) return false;
  const kind = footerKind(footer);
  return kind === 'welcome' ? welcomeAbove(rows, rows.length - 4) :
    kind === 'idle' && summary.test(rows.at(-5) ?? '');
}

function upperRule(line: StyledLine): boolean {
  if (plainRule.test(line.text)) return colour(line, GREY);
  const m = labelledRule.exec(line.text);
  if (!m) return false;
  const start = m[1]!.length;
  return ink(line, 0, start, s => s.fg === GREY) &&
    ink(line, start, start + m[2]!.length, s => s.fg === '#daa520') &&
    ink(line, line.text.length - 1, line.text.length, s => s.fg === GREY);
}

export function spinning(line: StyledLine | undefined): boolean {
  return !!line && spinner.test(line.text) && ink(line, 0, 2, s => s.fg === GREY) &&
    ink(line, 3, 4, s => s.fg === GOLD && s.bold);
}

export interface Composer { top: number; first: number; bottom: number; busy: boolean; idle: boolean }

export function paintedFooter(footer: StyledLine, edge: StyledLine): ReturnType<typeof footerKind> {
  if (!plainRule.test(edge.text) || !colour(edge, GREY)) return;
  const kind = footerKind(footer.text);
  const bar = gauge.exec(footer.text);
  if (!kind || !bar) return;
  if (footer.text.endsWith('...')) {
    if (kind !== 'idle' || footer.text.length !== edge.text.length || !colour(footer, GREY)) return;
  } else if (!ink(footer, 1, 2, s => s.fg === '#c0c0c0') ||
      !ink(footer, 3, footer.text.indexOf(' · '), s => s.fg === '#ffd700' && s.bold) ||
      !ink(footer, bar.index, bar.index + bar[0].length, s => s.fg === '#8a7a4a' || (s.fg === '#8fbc8f' && s.bold))) return;
  return kind;
}

export function composer(lines: readonly StyledLine[]): Composer | undefined {
  const foot = lines.length - 1;
  const edge = lines[foot - 1];
  if (!edge) return;
  const kind = paintedFooter(lines[foot]!, edge);
  if (!kind) return;
  let first = foot - 2;
  while (first > 0) {
    const row = lines[first]!;
    const previous = lines[first - 1]!;
    // The classic input widget explicitly starts a new row one cell before
    // the physical margin. Its continuation has no prefix or indentation.
    if (!row.wrapped && !(previous.text.length === edge.text.length && /^[\x20-\x7e❯☤]+$/u.test(previous.text) &&
      row.text !== '' && ink(row, 0, row.text.length, s => s.fg === null && !s.bold && !s.italic))) break;
    first--;
  }
  const top = first - 1;
  const rule = lines[top];
  const head = lines[first];
  if (!rule || !head) return;
  if (kind === 'busy' && spinning(rule) && /^☤ ❯(?: |$)/u.test(head.text) && ink(head, 0, 3, s => s.fg === '#b8860b' && s.italic)) {
    return { top, first, bottom: foot - 1, busy: true, idle: false };
  }
  if (kind === 'busy' || !upperRule(rule) || rule.text.length !== edge.text.length ||
      !/^❯(?: |$)/u.test(head.text) || !ink(head, 0, 1, s => s.fg === CREAM && !s.bold && !s.italic)) return;
  const idle = kind === 'welcome' ? welcomeAbove(lines.slice(Math.max(0, top - 3), top).map(l => l.text), 3) :
    completed(lines[top - 1]);
  return { top, first, bottom: foot - 1, busy: false, idle };
}
