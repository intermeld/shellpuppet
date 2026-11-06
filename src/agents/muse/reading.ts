import type { AgentSignature } from '../../core/reasoning.js';

const RULE = '^[─━]{10,}$';

export const reading: AgentSignature = {
  // Muse Code 1.4.14. A completed answer is a bold ◆ block. Tool calls
  // use a green ◆, and the live reasoning summary uses a grey ◆. The
  // composer is the last ❯ row followed only by chrome, with or without
  // typed text. Submitted turns sit above it. The Muse Code banner
  // sits above the transcript, and the status line ending in Launch overrides
  // sits below the composer. A
  // finished turn may have no Worked for line.
  name: 'muse',
  programs: ['muse', 'muse-bin-*'],
  measured: 'Muse Code 1.4.14',
  composer: { text: '^❯(?:\\s*$| \\S)' },
  typed: { text: '^❯ \\S', body: { dim: false, fg: ['#ccd3db'] } },
  chrome: [{ text: '^── Voice input \\(Alt\\+V to start\\)' }, { text: RULE }],
  frame: { text: RULE },
  busy: [
    { text: '^[◇◈◆] .*esc to interrupt\\)' },
    { text: '^└ (?:Hooks running|last event|Meta Model )' },
  ],
  turn: { text: '^❯ \\S' },
  reasoning: [{
    start: { text: '^◆ (?!Worked for )', lead: { fg: ['#676c74'] } },
    continues: { text: '^ {2}(?![◆◇◈❯])\\S', lead: { fg: ['#676c74', '#8a9098'] } },
  }],
  answer: {
    start: { text: '^◆ (?!Worked for |(?:Wrote|Ran command|Write)\\b)', lead: { bold: true, fg: ['#ccd3db'] } },
    continues: { text: '^ {2}\\S', lead: { fg: ['#ccd3db'] } },
    upward: true,
  },
  trailer: { text: '^◆ Worked for ' },
};
