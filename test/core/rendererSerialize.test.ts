/**
 * ScreenRenderer.serialize: the renderer's state as bytes that rebuild it in
 * a fresh renderer of the same size, which is what a viewer receives (design §5).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';

const renderers: ScreenRenderer[] = [];

function makeRenderer(cols = 40, rows = 5, scrollback = 100): ScreenRenderer {
  const r = new ScreenRenderer({ cols, rows, scrollback });
  renderers.push(r);
  return r;
}

async function rebuild(bytes: string, cols = 40, rows = 5): Promise<ScreenRenderer> {
  const twin = makeRenderer(cols, rows);
  await twin.write(bytes);
  return twin;
}

afterEach(() => {
  while (renderers.length > 0) renderers.pop()?.dispose();
});

describe('ScreenRenderer.serialize', () => {
  it('keeps the final source cell when replay adds a combining mark at full width', async () => {
    const r = makeRenderer(3, 2);
    await r.write('abc');
    const rawState = 'abc\u0301';
    vi.spyOn((r as unknown as { serializer: { serialize: () => string } }).serializer, 'serialize')
      .mockReturnValue(rawState);

    const { state } = await r.capture({ above: 0, scrollback: 0 });
    const twin = await rebuild('\x1bc\x1b[3J' + state, 3, 2);
    expect(state).toBe(rawState);
    expect(state).not.toContain('\x1b[1;4H');
    expect(twin.styledLines().lines[0]?.text).toContain('c');
  });

  it('falls back to the raw state if a suffix erase cannot match every source row', async () => {
    const r = makeRenderer(3, 2);
    await r.write('ab');
    const rawState = 'ab\u0301';
    vi.spyOn((r as unknown as { serializer: { serialize: () => string } }).serializer, 'serialize')
      .mockReturnValue(rawState);

    const { state } = await r.capture({ above: 0, scrollback: 0 });
    expect(state).toBe(rawState);
  });

  it('discards a valid suffix erase when another replay row still differs', async () => {
    const r = makeRenderer(4, 3);
    await r.write('ab\r\nok');
    const rawState = 'abc\r\nxy';
    vi.spyOn((r as unknown as { serializer: { serialize: () => string } }).serializer, 'serialize')
      .mockReturnValue(rawState);

    const { state } = await r.capture({ above: 0, scrollback: 0 });
    expect(state).toBe(rawState);
  });

  it('corrects an extra replay cell after a synchronised wrapped-row deletion', async () => {
    const r = makeRenderer(129, 31);
    await r.write('\x1b[5;20H\x1b[?2026h' + ' a'.repeat(140) + '\x1b[5;20H\x1b[1M\x1b[?2026l');
    const { view, state } = await r.capture({ above: 2000, scrollback: 2000 });
    const twin = await rebuild('\x1bc\x1b[3J' + state, 129, 31);
    expect(twin.styledLines().lines.map((line) => line.text)).toEqual(
      view.lines.slice(view.firstVisible).map((line) => line.text),
    );
    expect(twin.snapshot().screen).toBe(r.snapshot().screen);
    expect(twin.snapshot().cursor).toEqual(r.snapshot().cursor);
  });

  it('rebuilds text, attributes, a wrapped line and the cursor in a fresh renderer', async () => {
    const r = makeRenderer();
    await r.write('one\r\n\x1b[31mred\x1b[0m two\r\n' + 'x'.repeat(50) + '\r\nend');
    const state = await r.serialize();
    const twin = await rebuild(state);
    expect(twin.snapshot()).toEqual(r.snapshot());
    // Attributes travel too, not just text.
    expect(state).toContain('\x1b[31m');
  });

  it('carries the alternate screen', async () => {
    const r = makeRenderer();
    await r.write('normal\r\n\x1b[?1049h\x1b[H\x1b[2Jalt frame\x1b[3;1Hstatus');
    const twin = await rebuild(await r.serialize());
    expect(twin.snapshot()).toEqual(r.snapshot());
    expect(twin.snapshot().screen).toBe('alt frame\n\nstatus');
  });

  it('includes everything written before the call and nothing written after', async () => {
    const r = makeRenderer();
    void r.write('before');
    const state = r.serialize();
    void r.write(' after');
    const twin = await rebuild(await state);
    expect(twin.snapshot().screen).toBe('before');
    await r.flush();
    expect(r.snapshot().screen).toBe('before after');
  });

  it('bounds the scrollback it carries while keeping the viewport complete', async () => {
    const r = makeRenderer(40, 5, 100);
    await r.write(Array.from({ length: 60 }, (_, i) => `line ${String(i)}`).join('\r\n'));
    const twin = await rebuild(await r.serialize({ scrollback: 10 }));
    // 10 lines of history plus the 5 visible rows.
    expect(twin.lastLines(1_000)).toHaveLength(15);
    expect(twin.snapshot()).toEqual(r.snapshot());
  });
});
