import type { AgentSignature } from '../../core/reasoning.js';

/**
 * Grok draws its permission box behind the same bar as its reasoning: a
 * question row (`> `), a command's rows (`│` starts one, `:` continues it)
 * and option rows (`1 (○)`). No Grok reasoning rule starts or continues on
 * them, so a permission box keeps every row of its own, whatever wording
 * its question is asked in.
 */
const GROK_BOX_ROW = ' {2}(?:> |\\d+ \\([○•●]\\) |[│:])';

export const reading: AgentSignature = {
  // Grok Build 1.0.70. While the model thinks, its
  // reasoning streams into a block behind a fading "│" bar, headed
  // "♦ Thinking…"; once it is done the block collapses to "♦ Thought for
  // Ns" with nothing under it. Messages and the answer are plain text
  // indented five spaces; tool work is a "♦" line ("♦ Edited primes.py, ran
  // 1 command"); "Worked for Ns" closes the turn. While a turn runs, a
  // spinner line ("| Thinking… 3.1s") sits above the composer's box.
  name: 'grok',
  programs: ['grok'],
  measured: 'Grok Build 1.0.70',
  composer: { text: '^ {2}│ >' },
  chrome: [{ text: '^ {2}╭' }, { text: '^ {3}[|/\\\\-] \\S' }, { text: '^ {3}\\S.*shift\\+tab', }],
  frame: { text: '^ {2}[╭╰]' },
  busy: [{ text: '^ {3}[|/\\\\-] .* \\d+(?:\\.\\d+)?s\\s*$' }, { text: '♦ Thinking…' }],
  turn: { text: '^ {5}> \\S' },
  reasoning: [
    {
      start: { text: '^ {2}│ {2}♦ Thinking' },
      continues: { text: `^ {2}│(?!${GROK_BOX_ROW})` },
    },
    // The spinner's label can be the model's own words about what it is
    // doing; it goes too, and the busy state still shows in the result.
    { start: { text: '^ {3}[|/\\\\-] \\S' } },
    // The bar on its own: the heading may have scrolled away.
    {
      start: { text: `^ {2}│(?!${GROK_BOX_ROW}) {2}\\S` },
      continues: { text: `^ {2}│(?!${GROK_BOX_ROW})` },
    },
  ],
  answer: {
    start: { text: '^ {5}(?!Worked for )[^\\s♦>]', lead: { fg: ['default', '#c8c8c8', '#ffffff', '#000000'] } },
    continues: { text: '^ {5}(?!Worked for )[^\\s♦>]', lead: { fg: ['default', '#c8c8c8', '#ffffff', '#000000'] } },
    upward: true,
  },
  trailer: { text: '^ {5}Worked for ' },
  requireTrailer: true,
  // A right-aligned time on each message row.
  tidy: ' {2,}\\d{1,2}:\\d{2}(?: ?[A-Za-z]{2})?\\s*$',
};
