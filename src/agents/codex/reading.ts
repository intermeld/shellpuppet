import type { AgentSignature } from '../../core/reasoning.js';

export const reading: AgentSignature = {
  // Codex CLI 0.165.0, default view. The answer is
  // a dim "•" with plain text after it; a tool group is a dim "•" with a
  // bold heading ("Explored"), a command a bold green "•" ("Ran"). While a
  // turn runs, "Working (Ns • esc to interrupt)" sits above the composer.
  name: 'codex',
  programs: ['codex'],
  measured: 'Codex CLI 0.165.0',
  composer: { text: '^› ' },
  // The placeholder ("Ask Codex to do anything") is dim; typed text is not.
  typed: { text: '^› \\S', word: { dim: false } },
  chrome: [{ text: 'esc to interrupt' }],
  busy: [{ text: 'esc to interrupt' }],
  turn: { text: '^› \\S' },
  answer: {
    start: { text: '^• ', lead: { dim: true }, word: { bold: false, italic: false } },
    continues: { text: '^ {2}(?!Worked for )[^\\s└]' },
  },
  trailer: { text: '^ {2}Worked for ' },
  requireTrailer: true,
};
