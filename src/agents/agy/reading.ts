import type { AgentSignature } from '../../core/reasoning.js';

const RULE_INDENTED = '^\\s*[─━]{10,}';

export const reading: AgentSignature = {
  // Antigravity CLI 1.4.10. A summary of
  // the model's reasoning stays on screen as one line, "○ Thought for 4.2s
  // (Create the file, then…)"; while it works, the spinner's label is the
  // subject of what it is thinking about. "▸ Thought for 5s, 228 tokens"
  // carries no text. Tool calls are a green "●"; the answer is plain text
  // indented two spaces. While a turn runs, "esc to cancel" is under the
  // composer.
  name: 'agy',
  programs: ['agy', 'antigravity'],
  measured: 'Antigravity CLI 1.4.10',
  composer: { text: '^>' },
  chrome: [{ text: RULE_INDENTED }, { text: '^[⠀-⣿] {2}' }, { text: '^└ ' }],
  frame: { text: RULE_INDENTED },
  busy: [{ text: '^[⠀-⣿] {2}\\S' }, { text: '^esc to cancel' }],
  turn: { text: '^> \\S' },
  reasoning: [
    { start: { text: '^○ Thought for ' } },
    { start: { text: '^[⠀-⣿] {2}\\S' } },
  ],
  answer: {
    start: { text: '^ {2}\\S', lead: { fg: ['default', '#ffffff', '#000000', 'p7', 'p15'] } },
    continues: { text: '^ {2}\\S', lead: { fg: ['default', '#ffffff', '#000000', 'p7', 'p15'] } },
    upward: true,
  },
};
