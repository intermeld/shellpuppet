import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor } from '../../src/core/reasoning.js';
import { Session } from '../../src/core/session.js';
import { modernRefusal } from '../fixtures/stalls/modern-refusal.mjs';

const ALT_ON = '\x1b[?1049h';
/** A full-width layout with a sidebar the narrow layout no longer draws. */
const wideLayout = (cols: number, rows: number): string =>
  Array.from({ length: rows }, (_, row) =>
    `\x1b[${String(row + 1)};1H` + `main-${String(row)}`.padEnd(cols - 40, '.') + 'sidebar ' + 'S'.repeat(32)).join('');
/** The narrow layout repaints only its own columns, each row ending in erase to end of line. */
const narrowLayout = (rows: number): string =>
  '\x1b[H' + Array.from({ length: rows }, (_, row) => `\x1b[${String(row + 1)};1Hrow-${String(row)}\x1b[K`).join('');

async function narrowed(alt: boolean, repaint: string, wide = { cols: 200, rows: 50 }, narrow = { cols: 80, rows: 24 }) {
  const renderer = new ScreenRenderer({ cols: 80, rows: 24, scrollback: 1000 });
  if (alt) await renderer.write(ALT_ON);
  renderer.resize(wide.cols, wide.rows);
  await renderer.write(wideLayout(wide.cols, wide.rows));
  renderer.resize(narrow.cols, narrow.rows);
  await renderer.write(repaint);
  return renderer;
}

/** The same program output in a terminal that was always the narrow size. */
async function reference(alt: boolean, repaint: string, narrow = { cols: 80, rows: 24 }) {
  const renderer = new ScreenRenderer({ cols: narrow.cols, rows: narrow.rows, scrollback: 1000 });
  await renderer.write((alt ? ALT_ON : '') + repaint);
  return renderer;
}

describe('rows after the grid narrows', () => {
  for (const alt of [true, false]) {
    it(`reads no cells past the new width on the ${alt ? 'alternate' : 'normal'} screen`, async () => {
      const shrunk = await narrowed(alt, narrowLayout(24));
      const plain = await reference(alt, narrowLayout(24));
      try {
        const snapshot = shrunk.snapshot();
        expect(snapshot.cols).toBe(80);
        for (const line of snapshot.lines) expect(line.length).toBeLessThanOrEqual(80);
        if (alt) expect(snapshot.screen).not.toContain('sidebar');
        expect(snapshot.lines.slice(0, 24)).toEqual(plain.snapshot().lines.slice(0, 24));
        for (const line of shrunk.styledLines().lines) expect(line.text.length).toBeLessThanOrEqual(80);
        for (const line of shrunk.plainViewport()) expect(line.length).toBeLessThanOrEqual(80);
        expect(shrunk.lastLines(24).join('\n')).not.toContain('SSSS');
      } finally {
        await shrunk.dispose();
        await plain.dispose();
      }
    });
  }

  it('replays the narrowed alternate screen as the viewer of that width shows it', async () => {
    const shrunk = await narrowed(true, narrowLayout(24));
    const replay = new ScreenRenderer({ cols: 80, rows: 24, scrollback: 1000 });
    try {
      await replay.write('\x1bc' + await shrunk.serialize());
      expect(replay.snapshot().lines).toEqual(shrunk.snapshot().lines);
      const captured = await shrunk.capture({ above: 0, scrollback: 0 });
      expect(captured.cols).toBe(80);
      const check = new ScreenRenderer({ cols: 80, rows: 24 });
      try {
        await check.write('\x1bc' + captured.state);
        expect(check.styledLines().lines.map(line => line.text))
          .toEqual(captured.view.lines.slice(captured.view.firstVisible).map(line => line.text));
      } finally { await check.dispose(); }
    } finally {
      await replay.dispose();
      await shrunk.dispose();
    }
  });

  it('blanks a wide character split by the new right edge', async () => {
    const renderer = new ScreenRenderer({ cols: 200, rows: 10, scrollback: 0 });
    try {
      await renderer.write(ALT_ON + '\x1b[1;1H' + 'x'.repeat(79) + '中' + 'tail');
      renderer.resize(80, 10);
      await renderer.flush();
      const line = renderer.snapshot().lines[0]!;
      expect(line).toBe('x'.repeat(79));
    } finally { await renderer.dispose(); }
  });

  for (const method of ['getWidth', 'setCell'] as const) {
    it(`leaves a row as xterm left it when its ${method} method is missing`, async () => {
      const renderer = new ScreenRenderer({ cols: 200, rows: 10, scrollback: 0 });
      try {
        await renderer.write(ALT_ON + '\x1b[1;1H' + 'x'.repeat(79) + '中' + 'tail');
        const core = (renderer as unknown as { term: { _core: { buffers: { alt: {
          lines: { get(index: number): Record<string, unknown> } } } } } }).term._core;
        core.buffers.alt.lines.get(0)[method] = undefined;
        renderer.resize(80, 10);
        await renderer.flush();
        // Unchanged, as on a release without the trim: never a split wide character.
        expect(renderer.snapshot().lines[0]).toBe('x'.repeat(79) + '中tail');
      } finally { await renderer.dispose(); }
    });
  }

  it('still detects a MiMo refusal repainted on a narrowed alternate screen', async () => {
    const refusal = modernRefusal({ cols: 96 });
    // The synthetic refusal is taller than 30 rows; the alternate screen keeps no history.
    const renderer = await narrowed(true, refusal, { cols: 220, rows: 60 }, { cols: 96, rows: 45 });
    try {
      const view = renderer.styledLines({ above: 128, extendWrapped: false });
      for (const line of view.lines) expect(line.text.length).toBeLessThanOrEqual(96);
      expect(detectStall(view.lines, signatureFor('mimo', 'mimo')!, false, view.firstVisible))
        .toMatchObject({ reason: 'provider-refused' });
    } finally { await renderer.dispose(); }
  });

  it('keeps session snapshots to the session width after a plain resize narrows it', async () => {
    let data: (text: string) => void = () => undefined;
    let exit: () => void = () => undefined;
    const pty = {
      pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
      onData(listener: (text: string) => void) { data = listener; return { dispose() {} }; },
      onExit(listener: (event: { exitCode: number }) => void) {
        exit = () => listener({ exitCode: 0 }); return { dispose() {} };
      },
      write() {}, resize(cols: number, rows: number) { pty.cols = cols; pty.rows = rows; },
      kill() {}, clear() {}, pause() {}, resume() {},
    } satisfies IPty;
    const session = new Session('narrow', { command: process.execPath, shell: false, cols: 80, rows: 24 },
      { spawn: () => pty, registerConsoleHostWindow() {}, queueConsoleHostEnd() {} });
    try {
      data(ALT_ON);
      await session.resize(200, 50);
      data(wideLayout(200, 50));
      await session.snapshot();
      await session.resize(80, 24);
      data(narrowLayout(24));
      const snapshot = await session.snapshot();
      expect(snapshot.cols).toBe(80);
      expect(snapshot.screen).not.toContain('sidebar');
      for (const line of snapshot.screen.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    } finally {
      exit();
      await session.kill();
    }
  });
});
