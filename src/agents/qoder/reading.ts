import type { AgentSignature } from '../../core/reasoning.js';

const RULE_INDENTED = '^\\s*[─━]{10,}';

export const reading: AgentSignature = {
  // Qoder CLI 1.1.80, default thinking: a "Thinking" heading in
  // italics, then the reasoning behind a grey "│" bar in grey italics, as
  // the model works and after it has answered. Messages start with a "▪"
  // in the text colour, tool calls with a green one. While a turn runs, a
  // braille spinner line says "(esc to cancel, Ns)".
  name: 'qoder',
  programs: ['qodercli', 'qoder'],
  measured: 'Qoder CLI 1.1.80',
  composer: { text: '^ > ' },
  // The placeholder ("Type your message or @path/to/file") is grey; typed text is not.
  typed: { text: '^ > ', word: { notFg: ['#95958f'] } },
  chrome: [
    { text: RULE_INDENTED },
    { text: 'Shift\\+Tab' },
    { text: '\\? for shortcuts\\s*$' },
    { text: '\\(esc to cancel' },
  ],
  frame: { text: RULE_INDENTED },
  busy: [{ text: '\\(esc to cancel' }],
  turn: { text: '^ > \\S' },
  reasoning: [
    // The bar by its text alone: a code span or a table inside the
    // reasoning is drawn upright, and an upright line is still reasoning.
    {
      start: { text: '^ Thinking\\s*$', lead: { italic: true } },
      continues: { text: '^ │( |$)' },
    },
    // The same bar on its own: the heading may have scrolled away.
    {
      start: { text: '^ │ ' },
      continues: { text: '^ │( |$)' },
    },
  ],
  answer: {
    start: { text: '^ ▪ ', lead: { fg: ['default', '#eeeeeb', '#ffffff', '#000000'] } },
    continues: { text: '^ {3}[^\\s└│]' },
  },
};
