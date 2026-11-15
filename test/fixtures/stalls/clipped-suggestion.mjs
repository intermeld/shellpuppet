import { outputLimit } from './output-limit.mjs';

const grey = text => `\x1b[38;2;128;128;128m${text}\x1b[0m`;

// The suggestion fills the 80-column composer to its inset right edge.
// Its shortcut starts at that edge, so only a prefix of it is drawn: by
// default the opening parenthesis alone.
export function clippedSuggestion({ cols = 80, short = false, noShortcut = false, shortcut = '(', ...options } = {}) {
  const edge = cols - 7;
  const body = short ? 'Consider the neutral example.' :
    ('Consider the neutral example. '.repeat(8)).slice(0, edge - 5 - (noShortcut ? 1 : shortcut.length)) +
    (noShortcut ? 'x' : shortcut);
  return outputLimit({ cols, suggestion: true, ...options })
    .replace(grey('Review the example. (Tab to'), grey(body));
}
