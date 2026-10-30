/**
 * Pixels: the viewer page, in a real browser, shows what the daemon renders
 * (design §5).
 *
 * The renderer-level test (viewer-sync) proves the bytes; this one proves the
 * page, because a fault that lives entirely in the browser, with the
 * daemon's snapshot right throughout, is invisible to every text-level
 * check. The viewer is opened headless in the same Chromium the isolated viewer
 * window uses, driven over DevTools, and the rows xterm drew are compared
 * with the daemon's snapshot. The PNG is kept under `test-results/` for a
 * human to look at (CI uploads it).
 *
 * Skipped where no Chromium-family browser is installed; every GitHub runner
 * image has one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

function fixturePath(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let td: TestDaemon;
let browser: string | null = null;

beforeAll(async () => {
  td = await startTestDaemon();
  browser = await findBrowser();
}, 60_000);

afterAll(async () => {
  await td.stop();
});

describe('the viewer page in a browser', () => {
  it('draws the frame the daemon renders, row for row', async (context) => {
    if (browser === null) {
      context.skip();
      return;
    }
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        // Few updates: the byte volume is the sync test's concern, not this one's.
        args: [fixturePath('partial-repaint-tui.mjs'), '40'],
        shell: false,
        cols: 100,
        rows: 30,
        purpose: 'viewer capture test',
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const viewerUrl = String(started.body['viewerUrl']);
    expect(viewerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/view\?/);
    const done = await api(td.port, td.token, `/sessions/${id}/wait?text=DONE&timeout=30000`);
    expect(done.body['matched']).toBe(true);

    const capture = await captureViewer({
      browser,
      viewerUrl,
      width: 1100,
      height: 720,
      timeoutMs: 45_000,
    });

    const outDir = path.join(repoRoot, 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'viewer-capture.png'), capture.png);

    expect(capture.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    // The daemon keeps spaces a program wrote; the capture right-trims rows.
    const daemonRows = String(snapshot.body['screen'])
      .split('\n')
      .map((row) => row.replace(/\s+$/, ''));
    expect(capture.rows).toEqual(daemonRows);
    // And the rows a mid-frame tail could never contain are among them.
    expect(capture.rows[0]).toContain('PARTIAL REPAINT TUI header');
    expect(capture.rows.at(-1)).toContain('footer 100x30');
  }, 90_000);

  it('serves a screenshot over the API without touching the session', async (context) => {
    if (browser === null) {
      context.skip();
      return;
    }
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [fixturePath('partial-repaint-tui.mjs'), '40'],
        shell: false,
        cols: 100,
        rows: 30,
        // Held, so the grid cannot move for any reason and a change would
        // have to be the screenshot's doing.
        hold: true,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await api(td.port, td.token, `/sessions/${id}/wait?text=DONE&timeout=30000`);

    const shot = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
      body: { width: 900, height: 600 },
    });
    expect(shot.status).toBe(200);
    const png = Buffer.from(String(shot.body['png']), 'base64');
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(shot.body['width']).toBe(900);
    expect(shot.body['height']).toBe(600);
    // ...and those are the picture's own dimensions, not an echo of the
    // request: set as the outer window size alone, a request for 900×600
    // comes back as 782×504.
    expect(png.readUInt32BE(16)).toBe(900);
    expect(png.readUInt32BE(20)).toBe(600);
    expect(shot.body['cols']).toBe(100);

    const lines = shot.body['lines'] as string[];
    expect(lines[0]).toContain('PARTIAL REPAINT TUI header');
    expect(lines.at(-1)).toContain('footer 100x30');

    // Photographing a session must not resize it or type into it: the capture
    // holds the grid and carries a read-only credential.
    const after = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(after.body['cols']).toBe(100);
    expect(after.body['rows']).toBe(30);
    expect(String(after.body['screen'])).toContain('footer 100x30');
  }, 90_000);

  it('a window past the bound grows its text so the bounded grid fills it (§5)', async (context) => {
    // A driving page, which is the human's window and not a capture, asks for
    // the grid its window holds at the text size the human chose. Past the daemon's
    // bound it will never be given that grid, so it grows the text until the
    // most it can be given fills the window.
    if (browser === null) {
      context.skip();
      return;
    }
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [fixturePath('partial-repaint-tui.mjs'), '40'],
        shell: false,
        cols: 100,
        rows: 30,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await api(td.port, td.token, `/sessions/${id}/wait?text=DONE&timeout=30000`);

    // 4000 px across is about 500 columns at the default 13 px text, past the
    // 400 the daemon allows; 1000 px down is about 55 rows, well within 150.
    const capture = await captureViewer({
      browser,
      viewerUrl: String(started.body['viewerUrl']),
      width: 4000,
      height: 1000,
      drive: true,
      timeoutMs: 45_000,
      // Settled once the daemon has answered a proposal with a grid far wider
      // than the 100 columns it started with, and the label has then stayed
      // put for a moment: the first answer can be followed by one more
      // exchange (a scrollbar appearing costs a column), and a probe taken
      // between the two would see the page and the daemon a column apart. The
      // values say how the page was drawn.
      probe:
        "(() => { const size = document.getElementById('size').textContent; const now = Date.now();" +
        ' if (window.__probeSize !== size) { window.__probeSize = size; window.__probeSince = now; return null; }' +
        ' if (now - window.__probeSince < 1500) return null;' +
        ' const parts = size.split(String.fromCharCode(215));' +
        ' const cols = parseInt(parts[0], 10); const rows = parseInt(parts[1], 10);' +
        ' if (!(cols >= 300)) return null;' +
        " const screen = document.querySelector('.xterm-screen');" +
        ' return JSON.stringify({ cols, rows, screenWidth: screen.offsetWidth, windowWidth: window.innerWidth }); })()',
    });
    const probe = JSON.parse(String(capture.probe)) as {
      cols: number;
      rows: number;
      screenWidth: number;
      windowWidth: number;
    };
    expect(probe.cols).toBeLessThanOrEqual(400);
    // The text grew: at 13 px the 400 columns would span about 3100 of the
    // 4000 px and leave the rest empty.
    expect(probe.screenWidth).toBeGreaterThan(probe.windowWidth * 0.9);
    const after = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(after.body['cols']).toBe(probe.cols);
  }, 90_000);

  it('rejects an absurd screenshot size rather than trying it', async () => {
    const session = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', "console.log('shot-bounds'); setInterval(() => {}, 200)"],
        shell: false,
      },
    });
    const id = String(session.body['id']);
    const bad = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
      body: { width: 99_999, height: 600 },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body['error'])).toContain('between 200 and 4000');
  });
});
