import { createRequire } from 'node:module';
import type { Terminal } from '@xterm/headless';
import type { IPty } from 'node-pty';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { Session } from '../../src/core/session.js';

const require = createRequire(import.meta.url);
type Internals = Terminal & { _core: { buffer: { lines: { length: number } } } };
const terminal = (renderer: ScreenRenderer): Internals =>
  (renderer as unknown as { term: Internals }).term;
afterEach(() => { vi.useRealTimers(); });

it('pins the private buffer repair to the audited xterm release', () => {
  expect((require('@xterm/headless/package.json') as { version: string }).version).toBe('6.0.0');
});

it('finds the private row fields the narrowing trim relies on', async () => {
  const renderer = new ScreenRenderer({ cols: 20, rows: 4, scrollback: 0 });
  try {
    await renderer.write('\x1b[?1049h');
    type Line = { length: number; resize: unknown; getWidth: unknown; setCell: unknown };
    type Buffer = { lines: { length: number; get: (index: number) => Line }; getNullCell: unknown };
    const core = (terminal(renderer) as unknown as { _core: { buffers: { normal: Buffer; alt: Buffer } } })._core;
    for (const buffer of [core.buffers.normal, core.buffers.alt]) {
      expect(typeof buffer.getNullCell).toBe('function');
      expect(typeof buffer.lines.get).toBe('function');
      const line = buffer.lines.get(0);
      expect(typeof line.length).toBe('number');
      for (const method of [line.resize, line.getWidth, line.setCell]) expect(typeof method).toBe('function');
    }
  } finally { await renderer.dispose(); }
});

it('backfills #6063 missing viewport lines before the next parser timer', async () => {
  vi.useFakeTimers();
  const renderer = new ScreenRenderer({ cols: 39, rows: 18, scrollback: 100 });
  void renderer.write(Array.from({ length: 22 }, (_, i) => `line-${String(i)}\r\n`).join('') + '\x1b[4A');
  await vi.runAllTimersAsync();
  const term = terminal(renderer);
  expect(term.buffer.active.baseY).toBe(5);
  expect(term.buffer.active.cursorY).toBe(13);
  // Upstream's forced logical length stands in for the masked stale slots.
  term._core.buffer.lines.length = 18;
  renderer.resize(37, 23);
  void renderer.write('\n');
  // On 6.0.0 without repair this throws the incident's exact isWrapped error.
  await vi.runAllTimersAsync();
  expect(term.buffer.active.length).toBeGreaterThanOrEqual(term.buffer.active.baseY + term.rows);
  expect(term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)).toBeDefined();
  for (let row = 18; row <= 22; row++) {
    void renderer.write(`\x1b[${String(row + 1)};1H\x1b[2Kbottom-${String(row)}`);
    await vi.runAllTimersAsync();
    expect(term.buffer.active.getLine(row)?.translateToString(true)).toBe(`bottom-${String(row)}`);
  }
  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('line-0');
  await renderer.dispose();
});

it('checks growing scrolled session panes after neighbouring panes end', async () => {
  const panes = Array.from({ length: 4 }, (_, index) => {
    let data: (text: string) => void = () => undefined;
    let exit: () => void = () => undefined;
    const pty = {
      pid: 0, cols: 39, rows: 18, process: 'fixture', handleFlowControl: false,
      onData(listener: (text: string) => void) { data = listener; return { dispose() {} }; },
      onExit(listener: (event: { exitCode: number }) => void) {
        exit = () => listener({ exitCode: 0 }); return { dispose() {} };
      },
      write() {}, resize(cols: number, rows: number) { pty.cols = cols; pty.rows = rows; },
      kill() {}, clear() {}, pause() {}, resume() {},
    } satisfies IPty;
    const session = new Session(`pane-${String(index)}`, { command: process.execPath, shell: false,
      cols: 39, rows: 18 }, { spawn: () => pty, registerConsoleHostWindow() {}, queueConsoleHostEnd() {} });
    return { session, data: (text: string) => data(text), exit: () => exit() };
  });
  try {
    for (const pane of panes) {
      pane.data(Array.from({ length: 55 }, (_, i) => `line-${String(i)}\r\n`).join(''));
      await pane.session.snapshot();
    }
    panes[0]!.exit();
    panes[1]!.exit();
    await panes[0]!.session.kill();
    await panes[1]!.session.kill();
    for (const pane of panes.slice(2)) {
      for (const rows of [23, 30, 40]) {
        await pane.session.resize(37, rows);
        await pane.session.snapshot();
        const renderer = (pane.session as unknown as { renderer: ScreenRenderer }).renderer;
        const term = terminal(renderer);
        const b = term.buffer.active;
        expect(b.length).toBeGreaterThanOrEqual(b.baseY + rows);
        expect(b.length).toBeGreaterThan(b.baseY + b.cursorY);
      }
    }
  } finally {
    for (const pane of panes) pane.exit();
    await Promise.all(panes.map(pane => pane.session.kill()));
  }
});
