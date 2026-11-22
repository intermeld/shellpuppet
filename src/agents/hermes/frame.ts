import type { CellStyle, StyledLine } from '../../core/renderer.js';

export const GOLD = '#ffbf00';
export const CREAM = '#fff8dc';
const GREY = '#8b8682';
export const suggestion = 'Set a reminder or schedule a recurring task';

/** Every printable character in the slice must have a measured style. */
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
  return ink(line, 0, line.text.length, s => s.fg === fg && s.bold === bold && !s.italic && !s.inverse);
}

export function transcriptRule(line: StyledLine | undefined): boolean {
  return !!line && /^─{40}$/u.test(line.text) && colour(line, GOLD);
}

export const summary = /^─ \d+(?:\.\d+)?s · (?:updated \d+ memor(?:y|ies) · )?\d{1,2}:\d{2} [AP]M$/u;
export function completed(line: StyledLine | undefined): boolean {
  return !!line && summary.test(line.text) && ink(line, 0, line.text.length, s => s.dim && s.fg === null);
}
const usage = /^ ☤ \S+ · ~\d+(?:\.\d+)?[KM]?\/\d+(?:\.\d+)?[KM]? pinned · \[[░█]{10}\] ~\d+% · ◎ \d+(?:\.\d+)?% · ◷ \d+(?:\.\d+)?s · ↑ \d+ t\/s · \d+[smh] · ⏲ \d+s · ✓ \d+s$/u;
const plainRule = /^─{4,}$/u;
const labelledRule = /^(─{4,} )(\S.*?) (─)$/u;

/** The opt-in start wait sees text only. Input additionally requires the live colours and cursor. */
export function readyScreen(screen: string): boolean {
  const rows = screen.trimEnd().split('\n');
  const [before, top, input, bottom, footer] = rows.slice(-5);
  return before !== undefined && summary.test(before) && top !== undefined &&
    (plainRule.test(top) || labelledRule.test(top)) &&
    (input === '❯' || input === `❯ ${suggestion}`) &&
    bottom !== undefined && plainRule.test(bottom) && bottom.length === top.length &&
    footer !== undefined && usage.test(footer);
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

export interface Composer { top: number; first: number; bottom: number }

/** Locate both edges from the physical footer. An echoed prompt has gold edges. */
export function composer(lines: readonly StyledLine[]): Composer | undefined {
  let foot = lines.length - 1;
  while (foot >= 0 && lines[foot]!.text.trim() === '') foot--;
  const footer = lines[foot];
  const edge = lines[foot - 1];
  if (!footer || !usage.test(footer.text) ||
      !ink(footer, 1, 2, s => s.fg === '#c0c0c0') ||
      !ink(footer, 3, footer.text.indexOf(' · '), s => s.fg === '#ffd700' && s.bold) ||
      !ink(footer, footer.text.indexOf('['), footer.text.indexOf(']') + 1, s => s.fg === '#8fbc8f' && s.bold) ||
      !edge || !plainRule.test(edge.text) || !colour(edge, GREY)) return;
  let first = foot - 2;
  while (first > 0 && lines[first]!.wrapped) first--;
  const top = first - 1;
  const head = lines[top + 1];
  if (top < 0 || !upperRule(lines[top]!) || lines[top]!.text.length !== edge.text.length || !head ||
      !/^❯(?: |$)/u.test(head.text) || !ink(head, 0, 1, s => s.fg === CREAM && !s.bold && !s.italic)) return;
  return { top, first, bottom: foot - 1 };
}
