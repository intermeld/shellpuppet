import type { StallSignature } from '../types.js';
import { readingRules } from './readingRules.js';

// MiMoCode's evidenced error ink and left bar. OpenCode's measured footer
// differs, and there is no captured OpenCode refusal to seed its module.
const error = { fg: ['#fb7185'] };
const bar = { text: '^ {2}┃\\s*$', lead: error };
export const stalls: StallSignature[] = [{
  reason: 'provider-refused',
  description: 'The model provider refused the turn.',
  contentRegion: readingRules.contentRegion,
  chrome: [{ text: '^ {2}┃', lead: { notFg: ['#0a0a0a', '#fb7185'] } }],
  frameColumns: [2, 5],
  marker: { text: '  ┃     ✗ Error', fg: error.fg },
  // Controls belong to the completed footer or the framed right-hand panel.
  // The same symbols inside ordinary transcript text are still output.
  cosmetic: /^( {5}▣ {2}Build · [^·]+ · (?:\d+m )?\d+(?:\.\d+)?s)\s+(?:⎘.*|↻ \/recover(?:\s+⎘.*)?\s*$)/u,
  before: { text: '^ {5}The request was rejected because it was considered high risk\\s*$' },
  rows: [
    bar,
    { text: '^ {2}┃ {5}✗ Error\\s*$', lead: error, body: error },
    bar,
    { text: "^ {2}┃ {5}The response was withheld by the model provider's content safety filter\\.\\s*$", lead: error },
    bar,
  ],
  footer: { text: '^ {5}▣ {2}Build · [^·]+ · (?:\\d+m )?\\d+(?:\\.\\d+)?s\\s*(?:↻ /recover\\s*)?$' },
  composer: { text: '^ {2}╹▀+\\s*$' },
  composerStatus: { text: '^ {2}┃ {2}Build · ', lead: { notFg: ['#0a0a0a', '#fb7185'] } },
  idle: [
    { text: '^ {2}┃\\s*$' },
    { text: '^ {2}┃ {2}Build · ' },
    // MiMo can offer a grey suggestion in an otherwise idle composer.
    { text: '^ {2}┃ {2}.+\\(Tab to accept\\)\\s*$', word: { fg: ['#808080'] } },
    { text: '^ {2}╹▀+\\s*$' },
  ],
  bottom: [{ text: '^ {3}ctrl\\+p settings\\s*$' }],
}];
