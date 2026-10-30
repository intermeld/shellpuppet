/**
 * The viewer shows what the daemon renders (design §5), not the tail of the
 * raw PTY stream. A program that paints its frame once and then only touches
 * part of the screen leaves that frame further back than any bounded tail
 * reaches, so a viewer sent a tail would paint the churn and nothing else:
 * missing header and footer, stacked partial frames. That is the shape of
 * every agent CLI once its chrome is up, and on Windows the shape ConPTY
 * gives every program.
 *
 * The stand-in for the browser here is the daemon's own headless renderer,
 * fed exactly the frames a viewer receives, in wire order. Pixels are covered
 * separately by the headless-Chromium capture test.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { api, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

function fixturePath(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);
}

let td: TestDaemon;

beforeAll(async () => {
  td = await startTestDaemon();
});

afterAll(async () => {
  await td.stop();
});

/** A browser viewer minus the browser: frames applied in wire order. */
interface ViewerSim {
  screen: () => Promise<string>;
  cols: () => number;
  /** What the page does when the human changes the grid: resize locally, tell the daemon. */
  resize: (cols: number, rows: number) => void;
  binaryFrames: () => number;
  /** Binary frames that BEGAN a snapshot: a wipe is how one is recognised. */
  wipes: () => number;
  close: () => void;
}

/**
 * The prefix every snapshot starts with (RIS, then erase saved lines). It is
 * how a snapshot is told from live mirror bytes on the wire, which is the only
 * way to see that one was sent at all: the fixture repaints its whole frame on
 * SIGWINCH, so the screen agrees afterwards either way.
 */
const VIEWER_WIPE = '\x1bc\x1b[3J';

function openViewer(id: string): Promise<ViewerSim> {
  return new Promise((resolve, reject) => {
    // A fresh page starts at xterm's default grid and follows the daemon's
    // geometry frame before anything paints, exactly as viewer.js does.
    const term = new ScreenRenderer({ cols: 80, rows: 24 });
    let binaryFrames = 0;
    let wipes = 0;
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(td.port)}/sessions/${id}/stream?token=${td.token}`,
    );
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        binaryFrames++;
        const text = Buffer.from(data as Buffer).toString('utf8');
        if (text.startsWith(VIEWER_WIPE)) wipes++;
        void term.write(text);
        return;
      }
      const control = JSON.parse(String(data)) as { type?: string; cols?: number; rows?: number };
      if (
        control.type === 'geometry' &&
        typeof control.cols === 'number' &&
        typeof control.rows === 'number'
      ) {
        term.resize(control.cols, control.rows);
      }
    });
    ws.on('open', () => {
      resolve({
        screen: async () => {
          await term.flush();
          return term.snapshot().screen;
        },
        cols: () => term.cols,
        resize: (cols, rows) => {
          term.resize(cols, rows);
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        },
        binaryFrames: () => binaryFrames,
        wipes: () => wipes,
        close: () => {
          ws.close();
          term.dispose();
        },
      });
    });
    ws.on('error', reject);
  });
}

/** The viewer's screen once it has painted and stopped changing. */
async function settled(viewer: ViewerSim): Promise<string> {
  let last: string | null = null;
  let stableReads = 0;
  await eventually(
    async () => {
      const now = await viewer.screen();
      stableReads = viewer.binaryFrames() > 0 && now === last ? stableReads + 1 : 0;
      last = now;
      return stableReads >= 3;
    },
    20_000,
    100,
  );
  return last ?? '';
}

async function daemonScreen(id: string): Promise<{ screen: string; cols: number }> {
  const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
  expect(snapshot.status).toBe(200);
  return { screen: String(snapshot.body['screen']), cols: Number(snapshot.body['cols']) };
}

describe('a viewer is a mirror of the daemon renderer', () => {
  let id = '';

  beforeAll(async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [fixturePath('partial-repaint-tui.mjs')],
        shell: false,
        cols: 120,
        rows: 30,
      },
    });
    expect(started.status).toBe(200);
    id = String(started.body['id']);
    // The fixture churns until its frame is well beyond any replay bound,
    // then says so and idles.
    const done = await api(td.port, td.token, `/sessions/${id}/wait?text=DONE&timeout=45000`);
    expect(done.body['matched']).toBe(true);
  });

  it('a late-joining viewer sees the frame the daemon renders, not the tail of the stream', async () => {
    const viewer = await openViewer(id);
    try {
      const shown = await settled(viewer);
      // The rows the churn never touched are the ones a tail cannot contain.
      expect(shown).toContain('PARTIAL REPAINT TUI header');
      expect(shown).toContain('footer 120x30');
      expect(shown).toBe((await daemonScreen(id)).screen);
    } finally {
      viewer.close();
    }
  });

  it('live output after the join lands once, in order', async () => {
    const viewer = await openViewer(id);
    try {
      await settled(viewer);
      const typed = await api(td.port, td.token, `/sessions/${id}/input`, {
        body: { data: 'x' },
      });
      expect(typed.status).toBe(200);
      const ticked = await api(
        td.port,
        td.token,
        `/sessions/${id}/wait?text=tick%201&timeout=10000`,
      );
      expect(ticked.body['matched']).toBe(true);
      const shown = await settled(viewer);
      expect(shown).toContain('tick 1');
      expect(shown).toBe((await daemonScreen(id)).screen);
    } finally {
      viewer.close();
    }
  });

  it('a viewer that changes the grid is brought back in step at the new size', async () => {
    const viewer = await openViewer(id);
    try {
      await settled(viewer);
      viewer.resize(100, 24);
      await eventually(async () => (await daemonScreen(id)).cols === 100);
      const shown = await settled(viewer);
      expect(viewer.cols()).toBe(100);
      // The program saw the resize and repainted at the new size...
      expect(shown).toContain('footer 100x24');
      // ...and the viewer shows exactly what the daemon now renders.
      expect(shown).toBe((await daemonScreen(id)).screen);
    } finally {
      viewer.close();
    }
  });

  it('every grid change is followed by a snapshot on the wire, twice over', async () => {
    // "After every grid change, the daemon sends the viewer a snapshot" (§5).
    // This fixture repaints its own frame on SIGWINCH, so the screens would
    // agree without the snapshot: the wire is where the claim lives, so the
    // wire is where it is asserted, and twice in a row, because a window
    // being dragged does exactly that, faster than a serialisation resolves.
    const viewer = await openViewer(id);
    try {
      await settled(viewer);
      const beforeAny = viewer.wipes();

      const first = await api(td.port, td.token, `/sessions/${id}/resize`, {
        body: { cols: 96, rows: 26 },
      });
      expect(first.status).toBe(200);
      await eventually(() => viewer.wipes() > beforeAny, 20_000);
      const afterFirst = viewer.wipes();

      const second = await api(td.port, td.token, `/sessions/${id}/resize`, {
        body: { cols: 88, rows: 22 },
      });
      expect(second.status).toBe(200);
      await eventually(() => viewer.wipes() > afterFirst, 20_000);

      // And the overlapping snapshots left the page exactly on the daemon's
      // screen at the final grid, with nothing doubled and nothing missing.
      await eventually(async () => (await daemonScreen(id)).cols === 88, 20_000);
      const shown = await settled(viewer);
      expect(viewer.cols()).toBe(88);
      expect(shown).toContain('footer 88x22');
      expect(shown).toBe((await daemonScreen(id)).screen);
    } finally {
      viewer.close();
    }
  }, 90_000);

  it('an API resize brings every watcher in step at the new size', async () => {
    const first = await openViewer(id);
    const second = await openViewer(id);
    try {
      await settled(first);
      await settled(second);
      const resized = await api(td.port, td.token, `/sessions/${id}/resize`, {
        body: { cols: 90, rows: 20 },
      });
      expect(resized.status).toBe(200);
      for (const viewer of [first, second]) {
        const shown = await settled(viewer);
        expect(viewer.cols()).toBe(90);
        expect(shown).toContain('footer 90x20');
        expect(shown).toBe((await daemonScreen(id)).screen);
      }
    } finally {
      first.close();
      second.close();
    }
  });
});
