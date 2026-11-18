/**
 * Shared reading of a composer for modules that already tell typed text from
 * a placeholder. The busy, turn and composer patterns are that module's own
 * signature. They are applied here, rather than by calling the reading
 * engine, so loading a module does not cycle back through the module registry.
 */
import type { AgentSignature } from '../core/reasoning.js';
import type { CellStyle, StyledLine } from '../core/renderer.js';
import type { NudgeReadiness, NudgeView } from './types.js';

/** How one module treats the composer its signature already names. */
export interface ReadingNudgeRule {
  /** Composer text that is a placeholder, once the prompt glyph is removed. */
  placeholder: string;
  /** Keep rows after the composer until the signature's frame or status row. */
  continuations: boolean;
  /**
   * The recorded placeholder's own ink. Both the exact words and this ink
   * are required. A row with no spans does not match.
   */
  placeholderInk: (line: StyledLine) => boolean;
  /** A status row that ends the input region and is not composer text. */
  /**
   * A status row that ends the composer. It receives the rows below so a
   * module can require that the row really is the footer, not draft text
   * shaped like it.
   */
  status?: (line: StyledLine, below: readonly StyledLine[]) => boolean;
  /**
   * A non-blank row before the status is not a proven continuation.
   * It is unknown, never ready.
   */
  unprovenContinuations?: boolean;
  /**
   * Full-width rule rows the program paints directly above its composer, such
   * as a labelled rule. When exactly one row on the screen matches, the row
   * below it is a fresh row, even if xterm marked it as a wrap.
   */
  ruleRows?: readonly RegExp[];
  /** The ink a declared rule row is drawn in. Typed text in a draft has other ink. */
  ruleInk?: (line: StyledLine) => boolean;
}

const GLYPH = /^\s*[❯›>]/u;
const STRIP_GLYPH = /^\s*(?:❯[\u00a0 ]?|›[\u00a0 ]?|>[\u00a0 ]*)/u;

/** Ink after the prompt glyph, or every ink cell when the row has no glyph. */
export function bodyStyles(line: StyledLine): CellStyle[] {
  const ink: CellStyle[] = [];
  for (const span of line.spans) {
    for (let i = span.from; i < span.to; i++) {
      if (!/\s/u.test(line.text[i] ?? ' ')) ink.push(span);
    }
  }
  return GLYPH.test(line.text) ? ink.slice(1) : ink;
}

/** A complete composer leaves no visible output after its final footer row. */
export function onlyBlankRowsAfter(rows: readonly string[], footer: number): boolean {
  return rows.slice(footer + 1).every((row) => row.trim() === '');
}

function stripGlyph(text: string): string {
  return text.replace(STRIP_GLYPH, '').trim();
}

/**
 * Plain rows and styled rows are one visible viewport. When both are set
 * their text must match, and the styled rows are the ones read. A difference
 * is not one screen.
 */
function linesOf(view: NudgeView): readonly StyledLine[] | null {
  if (view.styled !== undefined && view.styled.length > 0) {
    if (view.styled.length !== view.rows.length) return null;
    for (let i = 0; i < view.styled.length; i++) {
      if (view.styled[i]?.text !== view.rows[i]) return null;
    }
    return view.styled;
  }
  return view.rows.map((text) => ({ text, spans: [] }));
}

function pattern(source: string | undefined): RegExp | null {
  return source === undefined ? null : new RegExp(source, 'u');
}

/** Last non-wrapped row matching the signature's composer, or -1. */
function composerIndex(lines: readonly StyledLine[], composer: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.wrapped === true) continue;
    if (composer.test(line.text)) return i;
  }
  return -1;
}

/**
 * A busy line counts only from the latest echoed turn down, including the
 * status under the composer. An older spinner left in the scrollback does not.
 * With no echoed turn, the whole screen counts: a false busy only waits.
 */
function turnIsBusy(lines: readonly StyledLine[], reading: AgentSignature, composerAt: number): boolean {
  const tests = (reading.busy ?? []).flatMap((test) => {
    const compiled = pattern(test.text);
    return compiled === null ? [] : [compiled];
  });
  if (tests.length === 0) return false;
  const turn = pattern(reading.turn?.text);
  let start = 0;
  if (turn !== null) {
    for (let i = composerAt - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || line.wrapped === true) continue;
      if (turn.test(line.text)) {
        start = i + 1;
        break;
      }
    }
  }
  // Every row counts, wrapped or not: xterm marks a separately painted busy
  // row as a wrap after a full-width row, and a false busy only waits.
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (tests.some((test) => test.test(line.text))) return true;
  }
  return false;
}

/**
 * Rows of the live composer. Continuations stop at the signature's frame,
 * and at a status row the module names, so the footer under that boundary
 * is not part of the draft. A non-blank row before an unproven boundary is
 * reported separately and is never treated as empty. When the caller holds
 * the exact line it typed, those rows are kept instead: the whole region must
 * then spell that line, so any row that is not part of it fails the match.
 */
function composerRegion(
  lines: readonly StyledLine[],
  reading: AgentSignature,
  at: number,
  rule: ReadingNudgeRule,
  matchingExpected: boolean,
): { rows: readonly StyledLine[]; unproven: boolean } | null {
  const first = lines[at];
  if (first === undefined) return null;
  if (!rule.continuations) return { rows: [first], unproven: false };
  const frame = pattern(reading.frame?.text);
  const rows: StyledLine[] = [first];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    // xterm can mark the frame row under a wrapped draft as a wrap too. While
    // matching the exact line the daemon typed, a frame row in the module's
    // own rule ink still ends the region: typed text is never drawn in it.
    if (frame !== null && frame.test(line.text) &&
      (line.wrapped !== true || (matchingExpected && rule.ruleInk?.(line) === true))) break;
    if (rule.status?.(line, lines.slice(i + 1)) === true) break;
    if (rule.unprovenContinuations === true && !matchingExpected && line.text.trim() !== '') {
      return { rows, unproven: true };
    }
    rows.push(line);
  }
  return { rows, unproven: false };
}

/** Blank, or the exact placeholder drawn in the placeholder's own ink. */
function rowClear(line: StyledLine, rule: ReadingNudgeRule): boolean {
  const text = stripGlyph(line.text);
  if (text === '') return true;
  return text === rule.placeholder && rule.placeholderInk(line);
}

/**
 * For a composer whose continuation rows are otherwise unproven: one space
 * after the prompt glyph, then rows each indented by exactly two spaces with
 * no blank row between them. Extra spaces or a blank row are not a plain
 * wrap of one line. A typed line break looks the same as a wrap on screen;
 * the input checks before Enter are what exclude it.
 */
function plainWrapRows(rows: readonly StyledLine[]): boolean {
  let end = rows.length;
  while (end > 1 && rows[end - 1]!.text.trim() === '') end--;
  const [first, ...rest] = rows.slice(0, end);
  if (first === undefined || !/^\s*[❯›>] \S/u.test(first.text)) return false;
  return rest.every((line) => /^ {2}\S/u.test(line.text));
}

/** Rejoin only visual composer wraps, allowing a space lost at a wrap edge. */
function holdsExpectedDraft(rows: readonly StyledLine[], expected: string): boolean {
  const [first, ...rest] = rows;
  const pieces = [stripGlyph(first?.text ?? '').trimEnd(), ...rest.map((line) => line.text.trim())]
    .filter((piece) => piece !== '');
  let positions = new Set([0]);
  for (const piece of pieces) {
    const next = new Set<number>();
    for (const position of positions) {
      if (expected.startsWith(piece, position)) next.add(position + piece.length);
      const spaces = /^\s+/u.exec(expected.slice(position))?.[0].length ?? 0;
      if (spaces > 0 && expected.startsWith(piece, position + spaces)) next.add(position + spaces + piece.length);
    }
    positions = next;
    if (positions.size === 0) return false;
  }
  return positions.has(expected.length);
}

/**
 * Busy wins over an empty composer: a running turn often leaves the
 * placeholder in place. A blank row, or the exact placeholder in its own
 * ink, is empty. Any other text is a draft, including unstyled text.
 * A row that might continue the composer, and a viewport whose plain and
 * styled rows disagree, are unknown. No composer at all is unknown.
 */
/**
 * xterm marks the row after a row that fills the full width as a wrap, even
 * when the program painted it separately. A program that pads every row to
 * the full width, as Muse Code does once its transcript has text, leaves
 * almost every row marked, the rule above its composer included. A module may
 * declare the rule row it paints directly above its composer. When exactly
 * one row on the screen matches it in the module's rule ink, that row and the
 * row below are fresh rows, so the composer under a full-width rule is still
 * found. Typed text cannot stand in for the rule: the ink check refuses typed
 * ink, and a copy would make two matches. Every other wrap keeps its mark.
 */
function unwrapBelowRules(lines: readonly StyledLine[], rule: ReadingNudgeRule): readonly StyledLine[] {
  const rules = rule.ruleRows ?? [];
  if (rules.length === 0) return lines;
  // A wrapped match must prove itself by its ink: without a module ink check
  // only an unwrapped row counts, as before.
  const matches = lines.flatMap((line, i) =>
    rules.some((test) => test.test(line.text)) &&
    (rule.ruleInk === undefined ? line.wrapped !== true : rule.ruleInk(line)) ? [i] : []);
  if (matches.length !== 1) return lines;
  const at = matches[0]!;
  if (lines[at]?.wrapped !== true && lines[at + 1]?.wrapped !== true) return lines;
  return lines.map((item, i) => (i === at || i === at + 1 ? { ...item, wrapped: false } : item));
}

export function readingReadiness(view: NudgeView, reading: AgentSignature, rule: ReadingNudgeRule): NudgeReadiness {
  const composer = pattern(reading.composer.text);
  if (composer === null) return 'unknown';
  const viewport = linesOf(view);
  if (viewport === null) return 'unknown';
  const lines = unwrapBelowRules(viewport, rule);
  const at = composerIndex(lines, composer);
  if (at < 0) return 'unknown';
  if (turnIsBusy(lines, reading, at)) return 'busy';
  const region = composerRegion(lines, reading, at, rule, view.expectedDraft !== undefined);
  if (region === null || region.unproven) return 'unknown';
  if (view.expectedDraft !== undefined) {
    if (rule.unprovenContinuations === true && !plainWrapRows(region.rows)) return 'draft';
    return holdsExpectedDraft(region.rows, view.expectedDraft) ? 'ready' : 'draft';
  }
  return region.rows.every((line) => rowClear(line, rule)) ? 'ready' : 'draft';
}
