import type { AgentSignature } from '../../core/reasoning.js';

export const reading: AgentSignature = {
  // OpenCode 2.0.26: no reasoning text is drawn. While the model
  // thinks it shows "⠇ Thinking"; afterwards a collapsed "+ Thought · Ns"
  // with nothing under it. The answer is plain paragraphs, in the same
  // colour and indent as any other text, closed by a footer naming the
  // agent, the model and the elapsed time. A sidebar
  // can share the rows on the right.
  name: 'opencode',
  programs: ['opencode'],
  measured: 'OpenCode 2.0.26',
  composer: { text: '^ {2}[┃╹]' },
  chrome: [{ text: '^ {2}┃' }, { text: '^\\s{60,}\\S' }],
  busy: [
    { text: '\\besc interrupt\\b' },
    { text: '^ {3,}[⠀-⣿] ' },
    { text: '^ {3,}\\+ Thought\\s*$' },
  ],
  turn: { text: '^ {2}┃ {2}\\S' },
  answer: {
    start: { text: '^ {5}[^\\s→+⠀-⣿]', lead: { fg: ['default', '#eeeeee', '#ffffff', '#000000'] } },
    continues: { text: '^ {5}[^\\s→+⠀-⣿]', lead: { fg: ['default', '#eeeeee', '#ffffff', '#000000'] } },
    upward: true,
  },
  trailer: { text: '^ {5}\\S+ · [^·]+ · \\d[\\d.]*m?s\\b' },
  requireTrailer: true,
  // The sidebar, on the same rows to the right.
  tidy: ' {20,}\\S.*$',
};
