import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { visibleMessageText } from '../../src/core/messageText.js';

describe('visible peer text', () => {
  it('escapes directional, zero-width and terminal controls in core and dashboard alike', () => {
    const viewer = readFileSync(new URL('../../src/viewer/dashboard.js', import.meta.url), 'utf8');
    const start = viewer.indexOf('const visibleMessageText =');
    const end = viewer.indexOf(';\n\n  function unreadCount', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const dashboardText = runInNewContext(`${viewer.slice(start, end + 1)} visibleMessageText`) as
      (value: string) => string;
    const controls = [0x1b, 0x7f, 0x9f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
    for (const code of controls) {
      const input = `left${String.fromCharCode(code)}right`;
      const expected = `left\\u${code.toString(16).padStart(4, '0')}right`;
      expect(visibleMessageText(input)).toBe(expected);
      expect(dashboardText(input)).toBe(expected);
    }
    for (const input of ['plain text', 'line\nnext', 'a\t b', '<script>alert(1)</script>'])
      expect(dashboardText(input)).toBe(visibleMessageText(input));
  });
});
