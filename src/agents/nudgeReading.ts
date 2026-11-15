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
  /** Keep rows after the composer until the signature's frame. Codex does not. */
  continuations: boolean;
  /** Grey suggestion ink. A row with no spans is never a suggestion. */
  suggestion: (line: StyledLine) => boolean;
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

function stripGlyph(text: string): string {
  return text.replace(STRIP_GLYPH, '').trim();
}

function asStyled(view: NudgeView): readonly StyledLine[] {
  if (view.styled !== undefined && view.styled.length > 0) return view.styled;
  return view.rows.map((text) => ({ text, spans: [] }));
}

function pattern(source: string | undefined): RegExp | null {
  return source === undefined ? null : new RegExp(source, 'u');
}

/**
 * The live composer is the last non-wrapped row matching the signature.
 * Continuations, where the module draws them, stop at its frame so the
 * status line under that frame is not part of the draft.
 */
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
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.wrapped === true) continue;
    if (tests.some((test) => test.test(line.text))) return true;
  }
  return false;
}

function composerRegion(
  lines: readonly StyledLine[],
  reading: AgentSignature,
  at: number,
  continuations: boolean,
): readonly StyledLine[] | null {
  const first = lines[at];
  if (first === undefined) return null;
  if (!continuations) return [first];
  const frame = pattern(reading.frame?.text);
  const rows: StyledLine[] = [first];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (frame !== null && line.wrapped !== true && frame.test(line.text)) break;
    rows.push(line);
  }
  return rows;
}

function rowClear(line: StyledLine, rule: ReadingNudgeRule): boolean {
  const text = stripGlyph(line.text);
  return text === '' || text === rule.placeholder || rule.suggestion(line);
}

/**
 * Busy wins over an empty composer: a running turn often leaves the
 * placeholder in place. Anything that is not a known empty composer is a
 * draft, including unstyled text. No composer at all is unknown.
 */
export function readingReadiness(view: NudgeView, reading: AgentSignature, rule: ReadingNudgeRule): NudgeReadiness {
  const composer = pattern(reading.composer.text);
  if (composer === null) return 'unknown';
  const lines = asStyled(view);
  const at = composerIndex(lines, composer);
  if (at < 0) return 'unknown';
  if (turnIsBusy(lines, reading, at)) return 'busy';
  const region = composerRegion(lines, reading, at, rule.continuations);
  if (region === null) return 'unknown';
  return region.every((line) => rowClear(line, rule)) ? 'ready' : 'draft';
}
