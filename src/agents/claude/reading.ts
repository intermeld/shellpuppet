import type { AgentSignature } from '../../core/reasoning.js';

const RULE = '^[─━]{10,}$';

export const reading: AgentSignature = {
  // Claude Code 2.1.312, default view and the ctrl+o transcript: no
  // reasoning text is drawn in either, only a spinner line while the model
  // thinks ("✻ Pondering… (2s · thinking with xhigh effort)"). The answer
  // is a `●` in the text colour; tool calls get a grey or coloured `●`.
  name: 'claude',
  programs: ['claude'],
  measured: 'Claude Code 2.1.312',
  // The composer's prompt glyph is followed by a non-breaking space once
  // something is typed; the echo of a sent prompt by an ordinary one.
  composer: { text: '^❯( |\\xa0|$)' },
  typed: { text: '^❯[ \\xa0]\\S', word: { dim: false } },
  chrome: [{ text: RULE }, { text: '/effort\\s*$' }],
  frame: { text: RULE },
  busy: [{ text: '^[✻✽✶✢✳·*] \\S+…' }],
  turn: { text: '^❯ \\S' },
  answer: {
    start: { text: '^● ', lead: { fg: ['default', '#ffffff', '#000000'] } },
    continues: { text: '^ {2}' },
  },
  trailer: { text: '^✻ \\S' },
  requireTrailer: true,
};
