import type { IPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';
import { ScreenRenderer } from '../../src/core/renderer.js';

/** Real Session and xterm, with deterministic delivery at the PTY boundary. */
function fixture(id: string): { session: Session; data: (text: string) => void; exit: () => void } {
  let data: (text: string) => void = () => {};
  let exit = (): void => {};
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
    onData(listener: (text: string) => void) { data = listener; return { dispose() {} }; },
    onExit(listener: (event: { exitCode: number }) => void) {
      exit = () => { listener({ exitCode: 0 }); };
      return { dispose() {} };
    },
    write() {}, resize() {}, kill() {}, clear() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session(id, { command: process.execPath, shell: false }, {
    spawn: () => pty, queueConsoleHostEnd() {}, registerConsoleHostWindow() {},
  });
  return { session, data: text => { data(text); }, exit: () => { exit(); } };
}

describe('session mouse encoding', () => {
  it.each([1005, 1006, 1015])('captures mode %i at the same point as the screen', async mode => {
    const f = fixture('mouse');
    const enable = '\x1b[?' + String(mode) + 'h';
    try {
      // Node-pty can deliver even the final h or l in a separate callback.
      for (const char of '\x1b[?1003;' + String(mode) + 'h') f.data(char);
      f.data('\x1b[?25lON');
      const connected = f.session.viewerState();
      const captured = f.session.captureViewerScreen(0, 0);
      for (const char of '\x1b[?1002;' + String(mode) + 'l') f.data(char);
      for (const state of [await connected, (await captured).state]) {
        expect(state).toContain(enable);
        expect(state).toContain('\x1b[?25l');
        expect(state).toContain('ON');
      }
      expect(await f.session.viewerState()).not.toContain(enable);
      expect((await f.session.captureViewerScreen(0, 0)).state).not.toContain(enable);
    } finally { f.exit(); await f.session.kill(); }
  });

  it('keeps SGR across unrelated mode changes and drops it on a full reset', async () => {
    const f = fixture('sgr');
    try {
      f.data('\x1b[?1006h\x1b[?1005h\x1b[?1015l\x1b[?1005l');
      expect(await f.session.viewerState()).toContain('\x1b[?1006h');
      f.data('\x1bc');
      expect(await f.session.viewerState()).not.toContain('\x1b[?1006h');
    } finally { f.exit(); await f.session.kill(); }
  });
});

describe('session output at exit and kill', () => {
  it('drops late PTY data before it reaches either xterm or viewers', async () => {
    const f = fixture('late');
    const viewer = vi.fn();
    f.session.onData(viewer);
    f.data('last output');
    await f.session.snapshot();
    f.exit();
    const write = vi.spyOn(ScreenRenderer.prototype, 'write');
    try {
      f.data('\x1b[?1049l\r\nlate');
      expect(write).not.toHaveBeenCalled();
      expect(viewer).toHaveBeenCalledTimes(1);
      expect((await f.session.snapshot()).screen).toBe('last output');
      expect(() => f.session.resize(100, 30)).toThrow();
      await f.session.kill();
      f.data('after kill\r\n');
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      await f.session.kill();
    }
  });

  it('survives 64 exit-then-kill cycles with concurrent parser queues', async () => {
    const chunk = 'burst\r\n'.repeat(2_000);
    const background = new ScreenRenderer();
    let completed = 0;
    try {
      for (let wave = 0; wave < 8; wave++) {
        const sessions = Array.from({ length: 8 }, (_, index) => fixture(`burst-${String(wave)}-${String(index)}`));
        try {
          for (const f of sessions) f.data('\x1b[?1049h');
          await Promise.all(sessions.map(f => f.session.snapshot()));
          void background.write(chunk.repeat(16));
          for (const f of sessions) {
            for (let i = 0; i < 32; i++) f.data(chunk);
            f.data('\x1b[?1049l\r\n');
            f.exit();
          }
          await Promise.all(sessions.map(async f => {
            await f.session.kill();
            f.data('late after kill\r\n');
            completed++;
          }));
          await background.flush();
        } finally {
          await Promise.all(sessions.map(f => f.session.kill()));
        }
      }
      expect(completed).toBe(64);
      expect(background.snapshot().screen).toContain('burst');
    } finally {
      await background.dispose();
    }
  }, 60_000);
});
