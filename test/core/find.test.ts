import { describe, expect, it } from 'vitest';
import { findOnScreen } from '../../src/core/find.js';

describe('findOnScreen', () => {
  const lines = ['$ goose session', 'Loading 7 extensions…', 'ready — type a prompt', ''];

  it('returns 1-based line numbers with the matched substring', () => {
    const result = findOnScreen(lines, '\\d+ extensions');
    expect(result.matches).toEqual([
      { line: 2, text: 'Loading 7 extensions…', match: '7 extensions' },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(findOnScreen(lines, 'READY').matches).toHaveLength(1);
  });

  it('returns empty for no matches', () => {
    expect(findOnScreen(lines, 'absent-text').matches).toEqual([]);
  });

  it('caps runaway matches and flags truncation', () => {
    const many = Array.from({ length: 150 }, (_, i) => `row ${String(i)}`);
    const result = findOnScreen(many, 'row');
    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('throws on an invalid pattern for the caller to map to a client error', () => {
    expect(() => findOnScreen(lines, '(unclosed')).toThrow(SyntaxError);
  });
});
