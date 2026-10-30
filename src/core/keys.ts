/**
 * Semantic key names → terminal escape sequences.
 *
 * Agents are bad at raw escape sequences, so the tool surface exposes readable
 * names (`enter`, `escape`, `ctrl+c`, `f5`…), mapped to the sequences xterm
 * sends. `shift+tab` (backtab) is included because TUI focus navigation needs
 * it.
 *
 * Pure data + lookup. No I/O.
 */

const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  arrow_up: '\x1b[A',
  arrow_down: '\x1b[B',
  arrow_right: '\x1b[C',
  arrow_left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
};

/** F1 to F4 use SS3 codes; F5+ use CSI codes, as xterm does. */
const FUNCTION_KEYS: Readonly<Record<number, string>> = {
  1: '\x1bOP',
  2: '\x1bOQ',
  3: '\x1bOR',
  4: '\x1bOS',
  5: '\x1b[15~',
  6: '\x1b[17~',
  7: '\x1b[18~',
  8: '\x1b[19~',
  9: '\x1b[20~',
  10: '\x1b[21~',
  11: '\x1b[23~',
  12: '\x1b[24~',
};

/**
 * Translate a semantic key name to the byte sequence to write to the PTY.
 * Names are case-insensitive and surrounding whitespace is ignored.
 * Returns `null` for names that are not recognised, and callers turn that into
 * a clear client error rather than writing garbage into the session.
 */
export function keyToBytes(key: string): string | null {
  const name = key.toLowerCase().trim();

  const named = NAMED_KEYS[name];
  if (named !== undefined) return named;

  // ctrl+a … ctrl+z → 0x01 … 0x1a
  const ctrl = /^ctrl\+([a-z])$/.exec(name);
  if (ctrl !== null && ctrl[1] !== undefined) {
    return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  }

  // f1 … f12
  const fn = /^f(\d{1,2})$/.exec(name);
  if (fn !== null && fn[1] !== undefined) {
    const sequence = FUNCTION_KEYS[Number(fn[1])];
    if (sequence !== undefined) return sequence;
  }

  return null;
}

/**
 * Every accepted key name, for tool schemas and error messages. The patterned
 * forms are described rather than enumerated.
 */
export function knownKeys(): string[] {
  return [...Object.keys(NAMED_KEYS), 'ctrl+<a-z>', 'f1-f12'];
}
