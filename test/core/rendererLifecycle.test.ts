import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';

afterEach(() => { vi.useRealTimers(); });

describe('renderer lifecycle with output in flight', () => {
  it('orders geometry at the write callback, before later output', async () => {
    const renderer = new ScreenRenderer({ cols: 10, rows: 3 });
    const terminal = (renderer as unknown as { term: { resize(cols: number, rows: number): void } }).term;
    const resize = vi.spyOn(terminal, 'resize');
    void renderer.write('before\r\n');
    renderer.resize(20, 5);
    const resizedEarly = resize.mock.calls.length;
    void renderer.write('\x1b[5;20HX');
    await renderer.flush();
    expect(resizedEarly).toBe(0);
    expect(renderer.snapshot().lines[4]).toBe('                   X');
    await renderer.dispose();
  });

  it('settles queued captures and refuses reads and mutations once closed', async () => {
    const renderer = new ScreenRenderer();
    void renderer.write('pending\r\n');
    const state = renderer.serialize();
    const capture = renderer.capture({ above: 0, scrollback: 0 });
    const disposed = renderer.dispose();
    expect(renderer.dispose()).toBe(disposed);
    await disposed;
    const terminal = (renderer as unknown as { term: { resize(): void; buffer: unknown } }).term;
    const resize = vi.spyOn(terminal, 'resize');
    const buffer = vi.spyOn(terminal, 'buffer', 'get');
    renderer.resize(100, 30);
    expect(renderer.snapshot().screen).toBe('');
    expect(renderer.lastLines(20)).toEqual([]);
    expect(renderer.styledLines().lines).toEqual([]);
    expect(await state).toBe('');
    expect((await capture).state).toBe('');
    expect(await renderer.serialize()).toBe('');
    expect((await renderer.capture({ above: 0, scrollback: 0 })).state).toBe('');
    expect(resize).not.toHaveBeenCalled();
    expect(buffer).not.toHaveBeenCalled();
  });

  it('bounds the wait without disposing underneath a stalled parser', async () => {
    vi.useFakeTimers();
    const renderer = new ScreenRenderer();
    const terminal = (renderer as unknown as { term: { write(data: string, callback: () => void): void; dispose(): void } }).term;
    let complete = (): void => {};
    vi.spyOn(terminal, 'write').mockImplementation((_data, callback) => { complete = callback; });
    const release = vi.spyOn(terminal, 'dispose');
    const written = renderer.write('pending');
    const disposed = renderer.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    await disposed;
    expect(release).not.toHaveBeenCalled();
    complete();
    await written;
    await renderer.flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('defers disposal until pending output has parsed', async () => {
    vi.useFakeTimers();
    const renderer = new ScreenRenderer({ cols: 80, rows: 24 });
    const initial = renderer.write('\x1b[?1049hworking');
    await vi.runAllTimersAsync();
    await initial;
    const terminal = (renderer as unknown as { term: { dispose(): void } }).term;
    const release = vi.spyOn(terminal, 'dispose');
    const written = renderer.write('burst\r\n'.repeat(100_000) + '\x1b[?1049l\r\n');
    const disposed = renderer.dispose();
    const releasedBeforeDrain = release.mock.calls.length;
    await vi.runAllTimersAsync();
    await written;
    await disposed;
    expect(releasedBeforeDrain).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('drops output arriving after disposal', async () => {
    vi.useFakeTimers();
    const renderer = new ScreenRenderer();
    const initial = renderer.write('\x1b[?1049hworking');
    await vi.runAllTimersAsync();
    await initial;
    await renderer.dispose();
    const terminal = (renderer as unknown as { term: { write(data: string): void } }).term;
    const write = vi.spyOn(terminal, 'write');
    const written = renderer.write('\x1b[?1049l\r\n');
    await vi.runAllTimersAsync();
    await written;
    expect(write).not.toHaveBeenCalled();
  });

  it('orders a resize after the pending output', async () => {
    const renderer = new ScreenRenderer({ cols: 10, rows: 3 });
    const reference = new ScreenRenderer({ cols: 10, rows: 3 });
    try {
      const data = '\x1b[3;10HX\r\nlast';
      void renderer.write(data);
      renderer.resize(20, 5);
      await renderer.flush();
      await reference.write(data);
      reference.resize(20, 5);
      await reference.flush();
      expect(renderer.snapshot()).toEqual(reference.snapshot());
    } finally {
      await renderer.dispose();
      await reference.dispose();
    }
  });
});
