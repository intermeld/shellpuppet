import type { ReadingRules } from '../types.js';

export const readingRules: ReadingRules = {
  liveContent(lines, turnStart, candidate, context) {
    // Check all available content even when the user-turn boundary is clipped.
    // Missing context cannot establish a new live answer.
    let tool = false;
    let fence = false;
    let quotation = false;
    for (let i = turnStart; i < candidate; i++) {
      const line = lines[i]!;
      // A leading soft-wrap continuation has no known origin. Its prompt
      // tail cannot establish tool, fence or quotation context. Logical
      // joining preserves this flag only when the start of the row is absent.
      if (i === 0 && line.wrapped) continue;
      const text = line.text.trim();
      const lead = context.ink(line)[0]?.fg;
      if (/^┃\s+\S/u.test(text) && lead === '#0a0a0a') tool = true;
      if (/^╹▀/u.test(text) && lead === '#0a0a0a') tool = false;
      if (/^(?:```|~~~)/u.test(text)) fence = !fence;
      if (/^>/u.test(text) || /:\s*$/u.test(text)) quotation = true;
      // MiMo's collapsed thought summary opens a new content block.
      if (/^\+ Thought:/u.test(text) && !tool && !fence) quotation = false;
    }
    if (tool || fence || quotation) return false;
    return turnStart === 0 ? 'inconclusive' : true;
  },
  inputRegion(lines, composer) {
    const edge = /^ {2}╹▀+/u.exec(lines[composer]!.text)?.[0].length;
    if (edge === undefined) return lines;
    // A separate panel needs a repeated framing column beyond the composer.
    // Indented draft lines, however far right, are still input. Crop only at
    // the proven divider so text between it and the closing edge is retained.
    const columns = new Map<number, number>();
    for (const line of lines.slice(0, composer)) {
      const column = line.text.indexOf('█', edge);
      if (column >= edge) columns.set(column, (columns.get(column) ?? 0) + 1);
    }
    const panel = [...columns].find(([, count]) => count >= 2)?.[0];
    if (panel === undefined) return lines;
    return lines.map(line => ({ ...line, text: line.text.slice(0, panel),
      spans: line.spans.filter(span => span.from < panel).map(span => ({ ...span, to: Math.min(span.to, panel) })) }));
  },
};
