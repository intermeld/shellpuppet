import type { AgentSignature } from '../../core/reasoning.js';

export const reading: AgentSignature = {
  // MiMoCode 0.1.16, built from OpenCode: no reasoning text
  // is drawn. A collapsed "+ Thought: Ns" sits before each tool group and
  // before the answer; tool calls are boxes behind a bar drawn in the
  // background colour, the person's prompt and the composer behind one in
  // the agent's colour. The answer is plain paragraphs closed by a build
  // footer, which carries no time while the turn runs. A side
  // panel on the right shares the rows (the session's title, context and
  // cost). The composer can hold a suggestion of its own after a turn.
  name: 'mimo',
  programs: ['mimo', 'mimocode', 'mimo-code'],
  measured: 'MiMoCode 0.1.16',
  composer: { text: '^ {2}╹▀+' },
  chrome: [{ text: '^ {2}┃', lead: { notFg: ['#0a0a0a', '#fb7185'] } }],
  busy: [
    { text: '^ {3}esc (?:to )?interrupt\\s*$' },
    { text: '^ {5}▣ {2}\\S+ · [^·]+?\\s*(?:[⎘█].*)?$' },
    { text: '^ {3,}[⠀-⣿] ' },
  ],
  turn: { text: '^ {2}┃', lead: { notFg: ['#0a0a0a', '#fb7185'] } },
  answer: {
    start: { text: '^ {5}[^\\s→+⠀-⣿▣]' },
    continues: { text: '^ {5}[^\\s→+⠀-⣿▣]' },
    upward: true,
  },
  trailer: { text: '^ {5}▣ {2}\\S+ · [^·]+ · \\d' },
  requireTrailer: true,
  // The scrollbar, the side panel and the copy button, on the same rows.
  tidy: '\\s+[⎘█].*$',
};
