import { describe, expect, it } from 'vitest';
import { keyToBytes, knownKeys } from '../../src/core/keys.js';

describe('keyToBytes', () => {
  // Design §6: every semantic name → expected byte sequence.
  it.each([
    ['enter', '\r'],
    ['tab', '\t'],
    ['shift+tab', '\x1b[Z'],
    ['escape', '\x1b'],
    ['esc', '\x1b'],
    ['backspace', '\x7f'],
    ['delete', '\x1b[3~'],
    ['space', ' '],
    ['up', '\x1b[A'],
    ['down', '\x1b[B'],
    ['right', '\x1b[C'],
    ['left', '\x1b[D'],
    ['arrow_up', '\x1b[A'],
    ['arrow_down', '\x1b[B'],
    ['arrow_right', '\x1b[C'],
    ['arrow_left', '\x1b[D'],
    ['home', '\x1b[H'],
    ['end', '\x1b[F'],
    ['pageup', '\x1b[5~'],
    ['pagedown', '\x1b[6~'],
  ])('maps %s', (name, expected) => {
    expect(keyToBytes(name)).toBe(expected);
  });

  it('maps every ctrl+letter to its control byte', () => {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(97 + i); // a…z
      expect(keyToBytes(`ctrl+${letter}`)).toBe(String.fromCharCode(i + 1));
    }
    expect(keyToBytes('ctrl+c')).toBe('\x03'); // the one everybody reaches for
  });

  it.each([
    ['f1', '\x1bOP'],
    ['f2', '\x1bOQ'],
    ['f3', '\x1bOR'],
    ['f4', '\x1bOS'],
    ['f5', '\x1b[15~'],
    ['f6', '\x1b[17~'],
    ['f7', '\x1b[18~'],
    ['f8', '\x1b[19~'],
    ['f9', '\x1b[20~'],
    ['f10', '\x1b[21~'],
    ['f11', '\x1b[23~'],
    ['f12', '\x1b[24~'],
  ])('maps %s', (name, expected) => {
    expect(keyToBytes(name)).toBe(expected);
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(keyToBytes('Enter')).toBe('\r');
    expect(keyToBytes(' CTRL+C ')).toBe('\x03');
    expect(keyToBytes('F5')).toBe('\x1b[15~');
  });

  it('returns null for unknown names rather than writing garbage', () => {
    expect(keyToBytes('bogus')).toBeNull();
    expect(keyToBytes('ctrl+1')).toBeNull();
    expect(keyToBytes('ctrl+cc')).toBeNull();
    expect(keyToBytes('f0')).toBeNull();
    expect(keyToBytes('f13')).toBeNull();
    expect(keyToBytes('f99')).toBeNull();
    expect(keyToBytes('')).toBeNull();
  });
});

describe('knownKeys', () => {
  it('lists every named key plus the patterned forms', () => {
    const keys = knownKeys();
    expect(keys).toContain('enter');
    expect(keys).toContain('shift+tab');
    expect(keys).toContain('ctrl+<a-z>');
    expect(keys).toContain('f1-f12');
    // Every concrete name in the list must actually resolve.
    for (const key of keys.filter((k) => !k.includes('<') && !k.includes('-f'))) {
      expect(keyToBytes(key), `knownKeys() lists '${key}' but it does not resolve`).not.toBeNull();
    }
  });
});
