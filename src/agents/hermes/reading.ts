import type { AgentSignature } from '../../core/reasoning.js';
import type { StyledLine } from '../../core/renderer.js';
import { colour, completed, composer, CREAM, GOLD, ink, summary, transcriptRule } from './frame.js';
import { activePrompt } from './prompts.js';

const body = { text: '\\S', lead: { fg: [CREAM], bold: false } };
export const reading: AgentSignature = {
  name: 'hermes', programs: ['hermes'], measured: 'Hermes Agent, November 2026',
  composer: { text: '^❯(?: |$)', lead: { fg: [CREAM], bold: false } },
  chrome: [{ text: '^─', lead: { fg: ['#8b8682'] } }],
  frame: { text: '^─+$' },
  busy: [{ text: '^☤ ❯(?: |$)', lead: { fg: ['#b8860b'], italic: true } }],
  turn: { text: '^❯ ', lead: { fg: [GOLD], bold: true } },
  typed: { text: '^❯ \\S', word: { italic: false } },
  answer: { start: body, continues: body, upward: true },
  trailer: { text: summary.source, lead: { dim: true } }, requireTrailer: true,
};

function toolRow(line: StyledLine): boolean {
  const label = /^(?:🧠 Memory(?= [~+]memory: )|🔎 (?:Grep|Find)|💻 \$|✗ \$|❓ Clarify)(?= )/u.exec(line.text);
  if (!label || !ink(line, line.text.indexOf(' ') + 1, label[0].length, s => s.bold && s.fg === null)) return false;
  let end = line.text.length;
  if (label[0] === '✗ $') {
    const suffix = ' [You denied this command \u2014 it did not run.]';
    end -= suffix.length;
    if (!line.text.endsWith(suffix) || !ink(line, 0, 1, s => s.fg === '#ef5350') ||
        !ink(line, end, line.text.length, s => s.fg === '#ef5350')) return false;
  }
  return ink(line, label[0].length, end, s => !s.bold && s.fg === null && !s.italic);
}

/** A previous reply can remain above tool output from the same turn. */
export function answerFloor(lines: readonly StyledLine[], limit: number): number {
  let i = limit - 1;
  if (!completed(lines[i])) return limit;
  while (i > 0 && lines[i - 1]!.text === '') i--;
  if (!transcriptRule(lines[--i])) return limit;
  while (i > 0 && !transcriptRule(lines[i - 1])) i--;
  return lines[i]?.text === '☤ Hermes' ? i + 1 : limit;
}

/** Only restore content whose enclosing frame identifies its speaker or tool. */
export function hiddenRanges(lines: readonly StyledLine[], limit: number): [number, number][] {
  const kept = new Set<number>();
  const frame = composer(lines);
  const modal = activePrompt(lines.map(line => line.text), lines);
  for (let i = 0; i < limit; i++) {
    const line = lines[i]!;
    if ((frame && i >= frame.top + (frame.busy ? 1 : 0)) ||
        (modal && ((i >= modal.rows[0] && i <= modal.rows[1]) || i > modal.rows[1] + 1)) ||
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
    if (toolRow(line)) {
      kept.add(i);
      while (i + 1 < limit && lines[i + 1]!.wrapped &&
          ink(lines[i + 1]!, 0, lines[i + 1]!.text.length, s => s.fg === null && !s.bold && !s.italic)) kept.add(++i);
    }
  }
  if (frame?.busy) {
    let first = frame.top;
    while (first > 0 && /^ \d+\. /u.test(lines[first - 1]!.text) && colour(lines[first - 1]!, '#c0c0c0')) first--;
    const title = lines[first - 1];
    const count = title && /^ Queue · (\d+) queued · \/queue list · Ctrl\+R collapse$/u.exec(title.text);
    if (count && Number(count[1]) === frame.top - first && colour(title, '#ffd700', true)) {
      for (let i = first - 1; i < frame.top; i++) kept.add(i);
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
