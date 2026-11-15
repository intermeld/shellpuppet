import type { StallSignature } from '../types.js';
import { readingRules } from './readingRules.js';
import { serverLost } from '../opencode/stalls.js';

// MiMoCode's evidenced error ink and left bar. OpenCode's measured footer
// differs, and there is no captured OpenCode refusal to seed its module.
const error = { fg: ['#fb7185'] };
const bar = { text: '^ {2}┃\\s*$', lead: error };
const shared: Omit<StallSignature, 'reason' | 'description' | 'marker' | 'rows'> = {
  contentRegion: readingRules.contentRegion,
  chrome: [{ text: '^ {2}┃', lead: { notFg: ['#0a0a0a', '#fb7185'] } }],
  frameColumns: [2, 5],
  // Controls belong to the completed footer or the framed right-hand panel.
  // The same symbols inside ordinary transcript text are still output.
  cosmetic: /^( {5}▣ {2}Build · [^·]+(?: · (?:\d+m )?\d+(?:\.\d+)?s)?)\s+(?:⎘.*|↻ \/recover(?:\s+⎘.*)?|▄.*)$/u,
  before: { text: '^ {5}The request was rejected because it was considered high risk\\s*$' },
  beforeOptional: true,
  footer: { text: '^ {5}▣ {2}Build · [^·]+(?: · (?:\\d+m )?\\d+(?:\\.\\d+)?s)?\\s*(?:↻ /recover\\s*)?(?:▄\\s*)?$' },
  composer: { text: '^ {2}╹▀+\\s*$' },
  composerStatus: { text: '^ {2}┃ {2}Build · ', lead: { notFg: ['#0a0a0a', '#fb7185'] } },
  idle: [
    { text: '^ {2}┃\\s*$' },
    { text: '^ {2}┃ {2}Build · ' },
    // MiMo can offer a grey suggestion in an otherwise idle composer.
    { text: '^ {2}┃ {2}.+\\(Tab to(?: accept\\))?\\s*$', lead: { fg: ['#fb8147', '#ff8040', '#808080'] }, body: { fg: ['#808080'] } },
    { text: '^ {2}╹▀+\\s*$' },
  ],
  idleClipped: {
    // The `(Tab to` shortcut cut off at the edge after any of its prefixes.
    row: { text: '^ {2}┃ {2}.+\\((?:T(?:a(?:b(?: t?)?)?)?)?$', lead: { fg: ['#fb8147', '#ff8040', '#808080'] }, body: { fg: ['#808080'] } },
    rightInset: 5,
  },
  bottom: [
    { text: '^(?: {3}ctrl\\+p settings| {3}[\\d.]+[KMG]?/[\\d.]+[KMG]?↓ \\(\\d+%\\) · \\$[\\d.]+\\s+tab switch\\s+ctrl\\+p\\s+@ attach file\\s*\\$ subagent\\s+/ commands(?:\\s+mode\\s+settings)?| {3}[\\d.]+[KMG]?/[\\d.]+[KMG]?↓.{0,25}tab.{0,20}ctrl\\+p.{0,20}@ attach.{0,20}\\$.{0,20}/)\\s*$' },
    { text: '^(?:\\s+mode\\s+settings|.{0,80}switch.{0,20}settings.{0,20}file.{0,20}subagent.{0,20}commands)\\s*$' },
    { text: '^\\s*(?:[a-z]\\s+)?mode(?:\\s+[a-z]){0,3}\\s*$' },
  ],
};

export const stalls: StallSignature[] = [
  {
    ...shared,
    reason: 'provider-refused',
    description: 'The model provider refused the turn.',
    marker: { text: /^ {2}┃ {5}✗ Error(?: · .+)?$/u, fg: error.fg },
    rows: [bar, { text: '^ {2}┃ {5}✗ Error(?: · .+)?\\s*$', lead: error, word: error }, bar,
      { text: "^ {2}┃ {5}The response was withheld by the model provider's content safety filter\\.\\s*$", lead: error }, bar],
  },
  {
    ...shared,
    reason: 'request-failed',
    description: 'The model request failed.',
    marker: { text: /^ {2}┃ {5}✗ Error(?: · .+)?$/u, fg: error.fg },
    rows: [bar, { text: '^ {2}┃ {5}✗ Error(?: · .+)?\\s*$', lead: error, word: error }, bar,
      { text: '^ {2}┃ {5}Request failed: .+\\s*$', lead: error }, bar],
  },
  {
    ...shared,
    reason: 'output-limit',
    description: 'The model reached its output length limit.',
    marker: { text: /^ {2}┃ {5}✗ Error(?: · .+)?$/u, fg: error.fg },
    rows: [bar, { text: '^ {2}┃ {5}✗ Error(?: · .+)?\\s*$', lead: error, word: error }, bar,
      { text: '^ {2}┃ {5}Output length limit reached\\s*$', lead: error }, bar],
  },
  {
    ...shared,
    reason: 'error',
    description: 'The model reported an error.',
    flexibleMessage: true,
    marker: { text: /^ {2}┃ {5}✗ Error(?: · .+)?$/u, fg: error.fg },
    rows: [bar, { text: '^ {2}┃ {5}✗ Error(?: · .+)?\\s*$', lead: error, word: error }, bar,
      { text: '^ {2}┃ {5}.+\\s*$', lead: error }, bar],
  },
  {
    ...shared,
    reason: 'error',
    description: 'The model reported an error.',
    marker: { text: /^ {2}┃ {3,}.+$/u, fg: error.fg },
    rows: [],
    clippedBody: true,
  },
  serverLost,
];
