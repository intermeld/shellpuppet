import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Exercise the shipped pane script without starting a browser or a daemon. */
function fixture(captureMode = false, withNotice = false, initialRow = 0) {
  const fonts = new EventTarget();
  const cell = { width: 8, height: 16 };
  let glyphWidth = cell.width;
  const screen = { clientWidth: 889, clientHeight: 606, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ top: 0, bottom: 240, height: 240 }) };
  const notice = { style: { top: '', bottom: '' }, getBoundingClientRect: () => ({ height: 20 }) };
  let move: (row: number) => void = () => {};
  let input: (data: string) => void = () => {};
  let binaryInput: (data: string) => void = () => {};
  const sent: (string | Uint8Array)[] = [];
  const calls: string[] = [];
  const writes: (() => void)[] = [];
  const frames: (() => void)[] = [];
  const textarea = new EventTarget();
  const element = new EventTarget();
  const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined) };
  const document = Object.assign(new EventTarget(), { fonts, activeElement: textarea, hasFocus: (): boolean => true });
  let osc!: (data: string) => boolean;
  class Terminal {
    cols = 80;
    rows = 24;
    options = { fontSize: 13 };
    element = Object.assign(element, { querySelector: (selector: string) => withNotice && selector === '.xterm-screen' ? screen : null, style: {} });
    textarea = textarea;
    parser = { registerOscHandler: (code: number, handler: typeof osc) => {
      expect(code).toBe(52);
      osc = handler;
    } };
    buffer = { active: { cursorX: 0, cursorY: initialRow, baseY: 0, viewportY: 0 } };
    _core = {
      _coreBrowserService: { onDprChange: () => ({ dispose() {} }) },
      _viewport: { queueSync() {} },
      _renderService: { dimensions: { device: { cell } }, addRefreshCallback() {} },
      _charSizeService: { measure() { cell.width = glyphWidth; } },
    };
    open() {}
    attachCustomKeyEventHandler() {}
    onCursorMove(callback: () => void) {
      move = row => { this.buffer.active.cursorY = row; callback(); };
      return { dispose() {} };
    }
    onData(callback: (data: string) => void) { input = callback; }
    onBinary(callback: (data: string) => void) { binaryInput = callback; }
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
    send(data: string | Uint8Array) { sent.push(data); }
    close() {}
  }
  const window = Object.assign(new EventTarget(), {
    atob, btoa, TextDecoder,
    queueMicrotask, devicePixelRatio: 1,
    getComputedStyle: () => ({ paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 }),
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); },
    cancelAnimationFrame() {},
    // Browser APIs the pane uses for notice placement.
    performance: { now: () => Date.now() },
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  vm.runInNewContext(fs.readFileSync('src/viewer/pane.js', 'utf8'), {
    window, document,
    navigator: { userAgent: 'test', clipboard }, location: { host: 'localhost' },
    Terminal, WebSocket: Socket, ArrayBuffer, Uint8Array, Date, setTimeout, clearTimeout,
  });
  const pane = (Reflect.get(window, 'ShellPuppetPane') as { create(config: unknown): {
    belowDashboardFloor(): boolean; destroy(): void; relayout(deliberate: boolean): void;
    setFontOverride(value: number): void; setReadOnly(value: boolean): void;
  } }).create({ container: { parentElement: withNotice ? screen : null, dataset: {} },
    elements: withNotice ? { promptAlert: { parentElement: notice } } : {}, sessionId: 'fixture',
    captureMode, initialFontOverride: 13 });
  return {
    pane, calls, window, move, notice, clipboard, document, textarea, sent,
    input: (data: string) => input(data), binaryInput: (data: string) => binaryInput(data),
    osc: (data: string) => osc(data),
    gesture(type = 'keydown', trusted = true, values: Record<string, unknown> = {}) {
      const event = new Event(type);
      for (const [name, value] of Object.entries({
        key: 'x', repeat: false, button: 0, isTrusted: trusted, timeStamp: Date.now(), ...values,
      })) Object.defineProperty(event, name, { value });
      element.dispatchEvent(event);
    },
    loadFont(width: number) { glyphWidth = width; fonts.dispatchEvent(new Event('loadingdone')); },
    frame: () => { for (const callback of frames.splice(0)) callback(); },
    bytes: () => { message({ data: new Uint8Array([65, 10]).buffer }); },
    geometry: (cols: number) => { message({ data: JSON.stringify({ type: 'geometry', cols, rows: 24, control: 'held' }) }); },
    drain: () => { while (writes.length > 0) writes.shift()!(); },
    paint: () => { while (frames.length > 0) frames.shift()!(); },
  };
}

describe('pane binary input', () => {
  it('sends one byte per onBinary character in one binary frame', () => {
    const f = fixture();
    try {
      f.sent.length = 0;
      f.binaryInput('\x1b[M \x84%');
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(f.sent[0] as Uint8Array)).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x84, 0x25]);
      f.input('x');
      expect(f.sent[1]).toBe('x');
    } finally { f.pane.destroy(); }
  });

  it('suppresses binary reports while the pane is read-only', () => {
    const f = fixture();
    try {
      f.pane.setReadOnly(true);
      f.sent.length = 0;
      f.binaryInput('\x1b[M \x84%');
      expect(f.sent).toHaveLength(0);
    } finally { f.pane.destroy(); }
  });
});

describe('OSC 52 clipboard writes', () => {
  it('validates the OSC handler payload as canonical base64 and UTF-8 up to one MiB', () => {
    const f = fixture();
    try {
      const limit = 1024 * 1024;
      f.gesture();
      for (const payload of ['c;?', 'p;YQ==', 'cp;YQ==', 'YQ==', 'c;YQ', 'c;Y Q=',
        'c;AA=A', 'c;YR==', 'c;____', 'c;/w==',
        'c;' + Buffer.alloc(limit + 1).toString('base64'), 'c;' + 'A'.repeat(4 * Math.ceil(limit / 3) + 4)]) {
        expect(f.osc(payload)).toBe(true);
      }
      expect(f.clipboard.writeText).not.toHaveBeenCalled();
      for (const [target, text] of [['c', ''], ['', 'line\n✓'], ['c', 'a'.repeat(limit)]] as const) {
        expect(f.osc(target + ';' + Buffer.from(text).toString('base64'))).toBe(true);
        expect(f.clipboard.writeText).toHaveBeenLastCalledWith(text);
      }
    } finally { f.pane.destroy(); }
  });

  it('admits printable characters, the listed editing and navigation keys, and the primary button', () => {
    const f = fixture();
    const admits = (type: string, values: Record<string, unknown>) => {
      f.textarea.dispatchEvent(new Event('blur'));
      f.clipboard.writeText.mockClear();
      f.gesture(type, true, values);
      f.osc('c;YQ==');
      return f.clipboard.writeText.mock.calls.length === 1;
    };
    try {
      for (const key of [' ', '5', '?', 'é', 'a\u0301', '界', '😀', 'Enter', 'Tab', 'Backspace',
        'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
        expect(admits('keydown', { key }), key).toBe(true);
      }
      for (const key of ['Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'FnLock', 'Hyper', 'Meta',
        'NumLock', 'ScrollLock', 'Shift', 'Super', 'Symbol', 'SymbolLock', 'F1', 'Paste', 'MediaPlayPause',
        'Unidentified', 'Dead', 'Insert', '', '\n', '\u0001', '\ud800', 'x\n', 'xy']) {
        expect(admits('keydown', { key }), key).toBe(false);
      }
      for (const button of [0, 1, 2, 3, 4]) expect(admits('mousedown', { button })).toBe(button === 0);
      f.document.activeElement = new EventTarget();
      f.gesture();
      f.document.activeElement = f.textarea;
      f.osc('c;YQ==');
      expect(f.clipboard.writeText).not.toHaveBeenCalled();
    } finally { f.pane.destroy(); }
  });

  it('requires both clocks to show a recent press, including time spent waiting for dispatch', () => {
    vi.useFakeTimers();
    const f = fixture();
    let eventNow = 8000;
    f.window.performance.now = () => eventNow;
    try {
      for (const [dispatchDelay, elapsedEvent, elapsedWall, accepted] of [
        [0, 2000, 2000, true], [0, 2001, 0, false], [0, 0, 2001, false],
        [1000, 0, 0, true], [1001, 0, 0, false], [1000, 0, 1001, false],
        [2001, 0, 0, false], [-1, 0, 0, false],
        [0, -1, 0, false], [0, 0, -1, false], [NaN, 0, 0, false], [0, Infinity, 0, false],
      ] as const) {
        f.clipboard.writeText.mockClear();
        eventNow = 8000;
        vi.setSystemTime(10_000);
        f.gesture('keydown', true, { timeStamp: eventNow - dispatchDelay });
        eventNow += elapsedEvent;
        vi.setSystemTime(10_000 + elapsedWall);
        f.osc('c;YQ==');
        expect(f.clipboard.writeText).toHaveBeenCalledTimes(accepted ? 1 : 0);
        if (!accepted) {
          eventNow = 8000;
          vi.setSystemTime(10_000);
          f.osc('c;YQ==');
          expect(f.clipboard.writeText).not.toHaveBeenCalled();
        }
      }
    } finally { f.pane.destroy(); vi.useRealTimers(); }
  });

  it.each(['event clock', 'wall clock', 'focus'])('rechecks the %s after decoding and before writing', change => {
    vi.useFakeTimers({ now: 10_000 });
    const f = fixture();
    try {
      let eventNow = 10_000;
      f.window.performance.now = () => eventNow;
      f.gesture();
      eventNow += 1999;
      vi.setSystemTime(11_999);
      f.window.atob = vi.fn((encoded: string) => {
        if (change === 'event clock') eventNow += 2;
        if (change === 'wall clock') vi.setSystemTime(12_001);
        if (change === 'focus') f.document.activeElement = new EventTarget();
        return atob(encoded);
      });
      expect(f.osc('c;YQ==')).toBe(true);
      expect(f.window.atob).toHaveBeenCalledOnce();
      expect(f.clipboard.writeText).not.toHaveBeenCalled();
    } finally { f.pane.destroy(); vi.useRealTimers(); }
  });

  it('requires a trusted press in the focused pane within two seconds and forgets it on blur', () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const copy = () => f.osc('c;YQ==');
      try {
        copy();
        f.gesture('mousemove');
        f.gesture('mousedown', false);
        copy();
        expect(f.clipboard.writeText).not.toHaveBeenCalled();
        f.gesture('mousedown');
        vi.advanceTimersByTime(2000);
        copy();
        expect(f.clipboard.writeText).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        copy();
        f.gesture();
        f.document.hasFocus = () => false;
        copy();
        f.window.dispatchEvent(new Event('blur'));
        f.document.hasFocus = () => true;
        copy();
        f.gesture();
        f.document.activeElement = new EventTarget();
        copy();
        f.textarea.dispatchEvent(new Event('blur'));
        f.document.activeElement = f.textarea;
        copy();
        expect(f.clipboard.writeText).toHaveBeenCalledTimes(1);
        f.gesture();
        copy();
        expect(f.clipboard.writeText).toHaveBeenCalledTimes(2);
      } finally { f.pane.destroy(); }
      copy();
      expect(f.clipboard.writeText).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('pane parser lifetime', () => {
  it('uses the loaded font for a floor check before the font refresh frame', () => {
    const f = fixture(false, true);
    try {
      expect(f.pane.belowDashboardFloor()).toBe(false);
      f.loadFont(13);
      const beforeRefresh = f.pane.belowDashboardFloor();
      f.frame();
      expect({ beforeRefresh, afterRefresh: f.pane.belowDashboardFloor() })
        .toEqual({ beforeRefresh: true, afterRefresh: true });
    } finally { f.pane.destroy(); }
  });

  it('clears a covered rest on the first delivered frame even if its timer has not run', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const f = fixture(false, true);
      try {
        f.move(23);
        vi.setSystemTime(300);
        f.frame();
        expect(f.notice.style.top).toBe('auto');
        vi.setSystemTime(1100);
        f.frame();
        expect(f.notice.style.bottom).toBe('auto');
      } finally { f.pane.destroy(); }
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { word: 'rlong', nextRowAt: 906, earlyFrame: 990, deadlineFrame: 1001 },
    { word: 'rrest', nextRowAt: null, earlyFrame: 300, deadlineFrame: 1065 },
  ])('clears the observed $word upper rest before the delayed timer', ({ nextRowAt, earlyFrame, deadlineFrame }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const f = fixture(false, true, 22);
      try {
        f.move(0);
        if (nextRowAt !== null) {
          vi.setSystemTime(nextRowAt);
          f.move(1);
        }
        vi.setSystemTime(earlyFrame);
        f.frame();
        expect(f.notice.style.bottom).toBe('auto');
        vi.setSystemTime(deadlineFrame);
        f.frame();
        expect(f.notice.style.top).toBe('auto');
      } finally { f.pane.destroy(); }
    } finally { vi.useRealTimers(); }
  });

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
    expect(Reflect.get(f.window, '__shellpuppetPainted')).toBeUndefined();
    expect(f.calls.filter(call => call === 'dispose')).toHaveLength(1);
  });
});
