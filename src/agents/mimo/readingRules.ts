import type { ReadingRules } from '../types.js';
import type { StyledLine } from '../../core/renderer.js';

/** The composer edge and its gutter run establish the adjacent panel columns. */
function contentRegion(lines: readonly StyledLine[], composer?: number): readonly StyledLine[] {
  if (composer === undefined) {
    composer = lines.length - 1;
    while (composer >= 0 && (lines[composer]!.wrapped || !/^ {2}╹▀+/u.test(lines[composer]!.text))) composer--;
  }
  if (composer < 0) return lines;
  const edge = /^ {2}╹▀+/u.exec(lines[composer]!.text)?.[0].length;
  if (edge === undefined) return lines;
  const columns = new Map<number, number>();
  const frameColumns = new Set<number>();
  for (let i = composer; i >= 0; i--) {
    const text = lines[i]!.text;
    if (i !== composer && !/^ {2}┃/u.test(text) && text.trim() !== '' && !/^ +█/u.test(text)) break;
    const column = text.indexOf('█', edge);
    if (column >= edge) {
      columns.set(column, (columns.get(column) ?? 0) + 1);
      // Draft rows can contain aligned glyphs too. Require a divider on the
      // closing edge or the program-owned mode row, independent of input text.
      if (i === composer || /^ {2}┃ {2}Build · /u.test(text)) frameColumns.add(column);
    }
  }
  const panel = [...columns].find(([column, count]) => count >= 2 && frameColumns.has(column))?.[0];
  if (panel === undefined) return lines;
  return lines.map(line => ({ ...line, text: line.text.slice(0, panel).trimEnd(),
    spans: line.spans.filter(span => span.from < panel).map(span => ({ ...span, to: Math.min(span.to, panel) })) }));
}

export const readingRules: ReadingRules = {
  contentRegion,
  busy(lines, _turnStart, chrome, signature, context) {
    // Interrupt hints belong below the composer. A running turn also has an
    // unfinished footer immediately before it. Printed instructions in the
    // answer or a completed tool block are not status.
    if (lines.slice(chrome).some(line => signature.busy.some(test => context.matches(line, test)))) return true;
    let last = chrome - 1;
    while (last >= 0 && lines[last]!.text.trim() === '') last--;
    return last >= 0 && signature.busy.some(test => context.matches(lines[last]!, test));
  },
  liveContent(lines, turnStart, candidate, context) {
    // Check all available content even when the user-turn boundary is clipped.
    // Missing context cannot establish a new live answer.
    let tool = false;
    for (let i = turnStart; i < candidate; i++) {
      const line = lines[i]!;
      // A leading soft-wrap continuation has no known origin. Its prompt
      // tail cannot establish tool, fence or quotation context. Logical
      // joining preserves this flag only when the start of the row is absent.
      if (i === 0 && line.wrapped) continue;
      const lead = context.ink(line)[0]?.fg;
      if (/^ {2}┃/u.test(line.text) && lead === '#0a0a0a') tool = true;
      if (/^ {2}╹▀/u.test(line.text) && lead === '#0a0a0a') tool = false;
    }
    // Punctuation in a file or answer is content. Only the module's gutter
    // and closing frame establish a tool region; error ink proves the refusal.
    if (tool) return false;
    return turnStart === 0 ? 'inconclusive' : true;
  },
  inputRegion: contentRegion,
};
