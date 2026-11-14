import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/** Exercise the shipped pane script without starting a browser or a daemon. */
function fixture(captureMode = false) {
  const calls: string[] = [];
  const writes: (() => void)[] = [];
  const frames: (() => void)[] = [];
  class Terminal {
    cols = 80;
    rows = 24;
    options = { fontSize: 13 };
    element = { querySelector: () => null, style: {} };
    buffer = { active: { cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0 } };
    _core = {
      _coreBrowserService: { onDprChange: () => ({ dispose() {} }) },
      _viewport: { queueSync() {} },
      _renderService: { addRefreshCallback() {} },
    };
    open() {}
    attachCustomKeyEventHandler() {}
    onCursorMove() { return { dispose() {} }; }
    onData() {}
    write(data: string | Uint8Array, done: () => void) {
      calls.push(data.length === 0 ? 'marker' : 'write');
      writes.push(done);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      calls.push(`resize ${String(cols)} ${String(rows)}`);
    }
    dispose() { calls.push('dispose'); }
  }
  let message: (event: { data: string | ArrayBuffer }) => void = () => {};
  class Socket {
    readyState = 1;
    set onmessage(callback: typeof message) { message = callback; }
    close() {}
  }
  const window: Record<string, unknown> = {
    queueMicrotask,
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); },
    cancelAnimationFrame() {},
    // Browser APIs the pane uses for notice placement.
    performance: { now: () => Date.now() },
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  vm.runInNewContext(fs.readFileSync('src/viewer/pane.js', 'utf8'), {
    window, document: { addEventListener() {}, removeEventListener() {} },
    navigator: { userAgent: 'test' }, location: { host: 'localhost' },
    Terminal, WebSocket: Socket, ArrayBuffer, Uint8Array, setTimeout, clearTimeout,
  });
  const pane = (window['ShellPuppetPane'] as { create(config: unknown): {
    destroy(): void; relayout(deliberate: boolean): void; setFontOverride(value: number): void;
  } }).create({ container: { parentElement: null, dataset: {} }, sessionId: 'fixture',
    captureMode, initialFontOverride: 13 });
  return {
    pane, calls, window,
    bytes: () => { message({ data: new Uint8Array([65, 10]).buffer }); },
    geometry: (cols: number) => { message({ data: JSON.stringify({ type: 'geometry', cols, rows: 24, control: 'held' }) }); },
    drain: () => { while (writes.length > 0) writes.shift()!(); },
    paint: () => { while (frames.length > 0) frames.shift()!(); },
  };
}

describe('pane parser lifetime', () => {
  it('defers dashboard disposal, drops late frames and disposes once', async () => {
    const f = fixture();
    f.bytes();
    f.geometry(100);
    f.pane.destroy();
    f.pane.destroy();
    f.bytes();
    f.geometry(120);
    f.pane.relayout(true);
    f.pane.setFontOverride(14);
    expect(f.calls).toEqual(['write', 'marker']);
    f.drain();
    await Promise.resolve();
    expect(f.calls).toEqual(['write', 'marker', 'dispose']);
  });

  it('keeps output and repeated geometry frames in wire order', () => {
    const f = fixture();
    f.bytes();
    f.geometry(100);
    f.geometry(80);
    expect(f.calls).toEqual(['write', 'marker', 'marker']);
    f.drain();
    expect(f.calls).toEqual(['write', 'marker', 'marker', 'resize 100 24', 'resize 80 24']);
    f.pane.destroy();
  });

  it('does not publish screenshot readiness after a capture is closed', async () => {
    const f = fixture(true);
    f.bytes();
    f.drain();
    f.pane.destroy();
    f.paint();
    await Promise.resolve();
    expect(f.window['__shellpuppetPainted']).toBeUndefined();
    expect(f.calls.filter(call => call === 'dispose')).toHaveLength(1);
  });
});
