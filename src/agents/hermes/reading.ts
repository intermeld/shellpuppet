import type { AgentSignature } from '../../core/reasoning.js';
import type { StyledLine } from '../../core/renderer.js';
import { colour, completed, composer, CREAM, GOLD, ink, summary, transcriptRule } from './frame.js';
import { activePrompt } from './prompts.js';

const body = { text: '^\\S', lead: { fg: [CREAM], bold: false } };
export const reading: AgentSignature = {
  name: 'hermes', programs: ['hermes'], measured: 'Hermes Agent, November 2026',
  composer: { text: '^❯(?: |$)', lead: { fg: [CREAM], bold: false } },
  chrome: [{ text: '^─', lead: { fg: ['#8b8682'] } }],
  frame: { text: '^─+$' },
  turn: { text: '^❯ ', lead: { fg: [GOLD], bold: true } },
  typed: { text: '^❯ \\S', word: { italic: false } },
  answer: { start: body, continues: body, upward: true },
  trailer: { text: summary.source, lead: { dim: true } }, requireTrailer: true,
};

/** Only restore content whose enclosing frame identifies its speaker or tool. */
export function hiddenRanges(lines: readonly StyledLine[], limit: number): [number, number][] {
  const kept = new Set<number>();
  const frame = composer(lines);
  const modal = activePrompt(lines.map(line => line.text), lines);
  for (let i = 0; i < limit; i++) {
    const line = lines[i]!;
    if ((frame && i >= frame.top) || (modal && i >= modal.rows[0] && i <= modal.rows[1]) ||
        line.text === '' || transcriptRule(line) ||
        completed(line)) {
      kept.add(i);
      continue;
    }
    if (line.wrapped) continue;
    const header = line.text === '☤ Hermes' && colour(line, GOLD, true);
    const echo = /^❯ \S/u.test(line.text) && ink(line, 0, 1, s => s.fg === GOLD && s.bold) &&
      ink(line, 2, line.text.length, s => s.fg === null && s.bold && !s.italic);
    if ((header || echo) && transcriptRule(lines[i - 1])) {
      let end = i + 1;
      while (end < limit && (header ? lines[end]!.text === '' || colour(lines[end]!, CREAM) :
        lines[end]!.wrapped && ink(lines[end]!, 0, lines[end]!.text.length, s => s.bold && s.fg === null))) end++;
      if (transcriptRule(lines[end]) && (echo || end > i + 1)) {
        for (; i < end; i++) kept.add(i);
        kept.add(end);
      }
      continue;
    }
    if (/^🧠 Memory [~+]memory: /u.test(line.text) && ink(line, 3, 9, s => s.bold && s.fg === null) &&
        ink(line, 9, line.text.length, s => !s.bold && s.fg === null && !s.italic)) {
      kept.add(i);
      while (i + 1 < limit && lines[i + 1]!.wrapped &&
          ink(lines[i + 1]!, 0, lines[i + 1]!.text.length, s => s.fg === null && !s.bold && !s.italic)) kept.add(++i);
    }
  }
  const ranges: [number, number][] = [];
  for (let i = 0; i < limit; i++) {
    if (kept.has(i)) continue;
    const start = i;
    while (i + 1 < limit && !kept.has(i + 1)) i++;
    ranges.push([start, i + 1]);
  }
  return ranges;
}
