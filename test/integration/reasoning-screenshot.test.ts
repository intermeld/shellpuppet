import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import type { ScreenRenderer } from '../../src/core/renderer.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import { captureDashboard } from './dashboardCapture.js';
import { api, connectWs, connectWsWithCookie, eventually, redeemViewerUrl, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const SECRET = 'VELVET_ZEPPELIN_42';
let td: TestDaemon;
let browser: string | null;

beforeAll(async () => {
  td = await startTestDaemon({ policy: { mode: 'allow-all' } });
  browser = await findBrowser();
}, 60_000);
afterAll(async () => { await td.stop(); }, 120_000);

/** Decode Chromium's eight-bit RGB or RGBA PNG for a direct pixel comparison. */
function pixels(png: Buffer): { width: number; height: number; stride: number; data: Buffer } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  expect([2, 6]).toContain(png[25]);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = Buffer.alloc(height * stride);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[source++]!;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[y * stride + x - channels]! : 0;
      const above = y > 0 ? data[(y - 1) * stride + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) {
        const p = left + above - upperLeft;
        const distances = [Math.abs(p - left), Math.abs(p - above), Math.abs(p - upperLeft)];
        predictor = distances[0]! <= distances[1]! && distances[0]! <= distances[2]!
          ? left : distances[1]! <= distances[2]! ? above : upperLeft;
      }
      data[y * stride + x] = (raw[source++]! + predictor) & 255;
    }
  }
  return { width, height, stride, data };
}

function horizontalDetail(png: Buffer, top: number, bottom: number): number {
  const image = pixels(png);
  const channels = image.stride / image.width;
  let total = 0;
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(image.height, Math.ceil(bottom)); y++) {
    for (let x = 6; x < image.width - 6; x++) {
      for (let colour = 0; colour < 3; colour++) {
        total += Math.abs(image.data[y * image.stride + x * channels + colour]! -
          image.data[y * image.stride + (x - 1) * channels + colour]!);
      }
    }
  }
  return total;
}

describe('filtered screenshot in Chromium', () => {
  it('matches a watched inline TUI after a wrapped row is deleted', async (context) => {
    if (browser === null) { context.skip(); return; }
    const dashboardUrls: string[] = [];
    const watched = await startTestDaemon({
      launcher: (url) => { dashboardUrls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
      idleCheckIntervalMs: 600_000,
    });
    try {
      const started = await api(watched.port, watched.token, '/sessions', { body: {
        command: process.execPath,
        args: [path.join(__dirname, '..', 'fixtures', 'serialise-delete-tui.mjs')],
        shell: false, agent: 'codex', cols: 120, rows: 34, openViewer: false,
      } });
      expect(started.status).toBe(200);
      const id = String(started.body['id']);
      expect((await api(watched.port, watched.token, '/dashboard/open', { body: {} })).status).toBe(200);
      expect(dashboardUrls).toHaveLength(1);
      await captureDashboard({
        browser, viewerUrl: dashboardUrls[0]!, width: 1400, height: 900,
        drive: true, timeoutMs: 120_000,
        probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
          document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`,
        interact: async () => {
          expect((await api(watched.port, watched.token, `/sessions/${id}/resize`,
            { body: { cols: 129, rows: 31 } })).status).toBe(200);
          await eventually(async () => {
            const screen = String((await api(watched.port, watched.token,
              `/sessions/${id}/snapshot`)).body['screen']);
            return screen.includes('Working (') && screen.includes('a a a');
          }, 30_000);
          // ConPTY canonicalises the stand-in's control stream. Feed the exact
          // wrapped-line deletion at the renderer boundary to retain the case.
          const manager = (watched.daemon as unknown as { manager: {
            get: (key: string) => { renderer: ScreenRenderer } | undefined;
          } }).manager;
          const renderer = manager.get(id)?.renderer;
          expect(renderer).toBeDefined();
          await renderer!.write('\x1b[2J\x1b[H\x1b[5;20H\x1b[?2026h' +
            ' a'.repeat(140) + '\x1b[5;20H\x1b[1M\x1b[?2026l');
          const before = await api(watched.port, watched.token, `/sessions/${id}/snapshot`);
          expect(String(before.body['screen']).split('\n')[3]?.length).toBe(0);
          await eventually(async () => String((await api(watched.port, watched.token,
            `/sessions/${id}/snapshot`)).body['screen']).includes('Working ('), 5_000);
          const shot = await api(watched.port, watched.token, `/sessions/${id}/screenshot`,
            { body: { width: 1000, height: 800, hideReasoning: true } });
          expect(shot.status, JSON.stringify(shot.body['diagnostics'] ?? shot.body['error'])).toBe(200);
          expect((shot.body['lines'] as string[]).some((line) =>
            line.includes('Working ('))).toBe(true);
          return true;
        },
      });
    } finally {
      await watched.stop();
    }
  }, 180_000);

  it('leaves visible rows of an answer longer than the context uncovered', async (context) => {
    if (browser === null) { context.skip(); return; }
    const fixture = path.join(td.home, 'long-answer.ansi');
    fs.writeFileSync(fixture, ` ▪ ${'M'.repeat(30 * 410)}\r\n\x1b[38;2;149;149;143m >  Type\x1b[0m`);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8')); setInterval(() => {}, 500)`],
        shell: false, agent: 'qoder', cols: 30, rows: 10, hold: true,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('MMMM'), 30_000);
    const plain = await captureViewer({
      browser, viewerUrl: String(started.body['viewerUrl']), width: 1000, height: 900,
      probe: `(() => { const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find(r => r.textContent.includes('MMMM')); const box = row?.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom } : null; })()`,
    });
    const box = plain.probe as { top: number; bottom: number };
    expect(box.bottom).toBeGreaterThan(box.top);
    const hidden = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
      body: { width: 1000, height: 900, hideReasoning: true }, method: 'POST',
    });
    expect(hidden.status, String(hidden.body['error'])).toBe(200);
    expect((hidden.body['lines'] as string[]).join('\n')).toContain('MMMM');
    const hiddenPng = Buffer.from(String(hidden.body['png']), 'base64');
    expect(horizontalDetail(hiddenPng, box.top, box.bottom)).toBeGreaterThan(horizontalDetail(plain.png, box.top, box.bottom) * 0.75);
  }, 120_000);

  it('covers a continuation whose parent has left the buffer', async (context) => {
    if (browser === null) { context.skip(); return; }
    const fixture = path.join(td.home, 'lost-parent.ansi');
    fs.writeFileSync(fixture, ` │ ${'S'.repeat(30 * 5010)}\r\n\x1b[38;2;149;149;143m >  Type\x1b[0m`);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8')); setInterval(() => {}, 500)`],
        shell: false, agent: 'qoder', cols: 30, rows: 10, hold: true,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('SSSS'), 60_000);
    const plain = await captureViewer({
      browser, viewerUrl: String(started.body['viewerUrl']), width: 1000, height: 900,
      probe: `(() => { const row = Array.from(document.querySelectorAll('.xterm-rows > div')).filter(r => r.textContent.includes('SSSS'))[1]; const box = row?.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom } : null; })()`,
    });
    const box = plain.probe as { top: number; bottom: number };
    expect(box.bottom).toBeGreaterThan(box.top);
    const hidden = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
      body: { width: 1000, height: 900, hideReasoning: true }, method: 'POST',
    });
    expect(hidden.status, String(hidden.body['error'])).toBe(200);
    expect((hidden.body['lines'] as string[]).join('\n')).not.toContain('SSSS');
    expect((hidden.body['lines'] as string[]).join('\n')).toContain('[reasoning hidden:');
    const hiddenPng = Buffer.from(String(hidden.body['png']), 'base64');
    expect(horizontalDetail(plain.png, box.top, box.bottom)).toBeGreaterThan(500);
    expect(horizontalDetail(hiddenPng, box.top, box.bottom)).toBeLessThan(horizontalDetail(plain.png, box.top, box.bottom) * 0.01);
  }, 120_000);

  it('covers every physical row of a soft-wrapped reasoning bar', async (context) => {
    if (browser === null) { context.skip(); return; }
    const fixture = path.join(td.home, 'wrapped-reasoning.ansi');
    fs.writeFileSync(fixture, ` │ ${SECRET.repeat(5)}\r\n ▪ MANGO`);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8')); setInterval(() => {}, 500)`],
        shell: false, agent: 'qoder', cols: 30, rows: 20, hold: true,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes(SECRET), 30_000);
    const plain = await captureViewer({
      browser, viewerUrl: String(started.body['viewerUrl']), width: 1000, height: 900,
      probe: `(() => Array.from(document.querySelectorAll('.xterm-rows > div')).filter(r => /VELVET|ZEPPELIN|_42/.test(r.textContent)).map(r => { const box = r.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }))()`,
    });
    const boxes = plain.probe as { top: number; bottom: number }[];
    expect(boxes.length).toBeGreaterThan(1);
    const hidden = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
      body: { width: 1000, height: 900, hideReasoning: true }, method: 'POST',
    });
    expect(hidden.status, String(hidden.body['error'])).toBe(200);
    const lines = hidden.body['lines'] as string[];
    expect(lines.join('\n')).not.toMatch(/VELVET|ZEPPELIN|_42/);
    expect(lines.join('\n')).toContain('MANGO');
    const hiddenPng = Buffer.from(String(hidden.body['png']), 'base64');
    for (const [index, box] of boxes.entries()) {
      const detail = horizontalDetail(plain.png, box.top, box.bottom);
      expect(detail).toBeGreaterThan(500);
      // The first covered row carries the small 'reasoning hidden' label.
      expect(horizontalDetail(hiddenPng, box.top, box.bottom)).toBeLessThan(detail * (index === 0 ? 0.25 : 0.01));
    }
  }, 120_000);

  it('covers reasoning on a screen that redraws while Chromium starts', async (context) => {
    if (browser === null) { context.skip(); return; }
    const original = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'reasoning', 'qoder-answered-after-reasoning.ansi'), 'utf8');
    const fixture = path.join(td.home, 'ticking-reasoning.ansi');
    fs.writeFileSync(fixture, original.replace('The xxxx xxxxx xx to reason', `${SECRET} to reason`));
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [path.join(__dirname, '..', 'fixtures', 'ticking-screen.mjs'), fixture],
        shell: false, agent: 'qoder', cols: 194, rows: 101, hold: true,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(async () => {
      const snap = await api(td.port, td.token, `/sessions/${id}/snapshot`);
      return String(snap.body['screen']).includes(SECRET) && /Tick \d{8}/.test(String(snap.body['screen']));
    }, 30_000);
    const plain = await captureViewer({
      browser, viewerUrl: String(started.body['viewerUrl']), width: 1000, height: 900,
      probe: `(() => { const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find(r => r.textContent.includes('${SECRET}')); const box = row?.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom } : null; })()`,
    });
    const box = plain.probe as { top: number; bottom: number };
    expect(box.bottom).toBeGreaterThan(box.top);
    const hidden = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
      body: { width: 1000, height: 900, hideReasoning: true }, method: 'POST',
    });
    expect(hidden.status, String(hidden.body['error'])).toBe(200);
    const lines = hidden.body['lines'] as string[];
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).toMatch(/\[reasoning hidden: \d+ lines?\]/);
    expect(lines.join('\n')).toContain('MANGO');
    const hiddenPng = Buffer.from(String(hidden.body['png']), 'base64');
    expect(hiddenPng.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(horizontalDetail(hiddenPng, box.top, box.bottom)).toBeLessThan(horizontalDetail(plain.png, box.top, box.bottom) * 0.01);
  }, 120_000);

  it('replaces the secret row text and removes its pixel detail', async (context) => {
    if (browser === null) { context.skip(); return; }
    const original = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'reasoning', 'qoder-answered-after-reasoning.ansi'), 'utf8');
    const fixture = path.join(td.home, 'reasoning-redaction.ansi');
    expect(original).toContain('The xxxx xxxxx xx to reason');
    fs.writeFileSync(fixture, original.replace('The xxxx xxxxx xx to reason', `${SECRET} to reason`));
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8')); setInterval(() => {}, 500)`],
        shell: false, agent: 'qoder', cols: 194, rows: 101, hold: true,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(async () => {
      const snap = await api(td.port, td.token, `/sessions/${id}/snapshot`);
      return String(snap.body['screen']).includes(SECRET);
    }, 30_000);
    const plain = await captureViewer({
      browser, viewerUrl: String(started.body['viewerUrl']), width: 1000, height: 900,
      probe: `(() => { const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find(r => r.textContent.includes('${SECRET}')); const box = row?.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom } : null; })()`,
    });
    const box = plain.probe as { top: number; bottom: number };
    expect(box.bottom).toBeGreaterThan(box.top);
    const hidden = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
      body: { width: 1000, height: 900, hideReasoning: true }, method: 'POST',
    });
    expect(hidden.status).toBe(200);
    const lines = hidden.body['lines'] as string[];
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).toMatch(/\[reasoning hidden: \d+ lines?\]/);
    const hiddenPng = Buffer.from(String(hidden.body['png']), 'base64');
    const plainDetail = horizontalDetail(plain.png, box.top, box.bottom);
    const hiddenDetail = horizontalDetail(hiddenPng, box.top, box.bottom);
    expect(plainDetail).toBeGreaterThan(500);
    // The cover should leave almost no fine detail in the planted text row.
    // A cover shifted by one row leaves much more than this one per cent bound.
    expect(hiddenDetail).toBeLessThan(plainDetail * 0.01);
  }, 120_000);
});

describe('the screenshot capture credential', () => {
  it('refuses a filtered picture when the browser reports different rows', async () => {
    const warnings: Record<string, unknown>[] = [];
    const shooter = await startTestDaemon({
      viewer: { browserPath: process.execPath },
      logger: { ...NULL_LOGGER, warn: (_message, meta) => { warnings.push(meta ?? {}); } },
      capture: () => Promise.resolve({ png: Buffer.from('not-a-png'), width: 800, height: 600, rows: ['wrong rows'] }),
    });
    try {
      const fixture = path.join(__dirname, '..', 'fixtures', 'reasoning', 'qoder-answered-after-reasoning.ansi');
      const started = await api(shooter.port, shooter.token, '/sessions', {
        body: { command: process.execPath, args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8')); setInterval(() => {}, 500)`], shell: false, agent: 'qoder', cols: 194, rows: 101, hold: true },
      });
      const id = String(started.body['id']);
      await eventually(async () => String((await api(shooter.port, shooter.token, `/sessions/${id}/snapshot`)).body['screen']).includes('MANGO'), 30_000);
      const shot = await api(shooter.port, shooter.token, `/sessions/${id}/screenshot`, { body: { hideReasoning: true } });
      expect(shot.status).toBe(409);
      const diagnostics = shot.body['diagnostics'] as Record<string, unknown>;
      expect(typeof diagnostics['expectedRowCount']).toBe('number');
      expect(diagnostics['actualRowCount']).toBe(1);
      expect(diagnostics['differenceCount']).toBeGreaterThan(0);
      const differingRows = diagnostics['differingRows'] as Record<string, unknown>[];
      expect(differingRows.length).toBeGreaterThan(0);
      expect(differingRows.length).toBeLessThanOrEqual(5);
      for (const row of differingRows) {
        expect(typeof row['row']).toBe('number');
        expect(typeof row['expectedLength']).toBe('number');
        expect(typeof row['actualLength']).toBe('number');
        expect(typeof row['firstColumn']).toBe('number');
      }
      expect(warnings.some((warning) => warning['differenceCount'] === diagnostics['differenceCount'] &&
        warning['actualRowCount'] === diagnostics['actualRowCount'])).toBe(true);
      expect(JSON.stringify(shot.body) + JSON.stringify(warnings)).not.toContain('MANGO');
    } finally {
      await shooter.stop();
    }
  }, 90_000);

  it('sends one frozen snapshot to the capture while an ordinary viewer keeps streaming', async () => {
    let port = 0;
    const shooter = await startTestDaemon({
      viewer: { browserPath: process.execPath },
      capture: async (options) => {
        const id = new URL(options.viewerUrl).searchParams.get('s') ?? '';
        const cookie = await redeemViewerUrl(options.viewerUrl);
        const capture = await connectWsWithCookie(port, id, cookie);
        const identity = await capture.waitForControl((frame) => frame['type'] === 'identity');
        const geometry = await capture.waitForControl((frame) => frame['type'] === 'geometry');
        expect(identity['readOnly']).toBe(true);
        expect(geometry['control']).toBe('adopt');
        await capture.waitForData('Tick ');
        const frozen = capture.received();
        const ordinary = await connectWs(port, id, shooter.token);
        await ordinary.waitForData('Tick ');
        const live = ordinary.received();
        await eventually(() => Promise.resolve(ordinary.received() !== live), 5_000);
        expect(capture.received()).toBe(frozen);
        capture.close();
        ordinary.close();
        return { png: Buffer.from('not-a-png'), width: 800, height: 600, rows: ['captured'] };
      },
    });
    port = shooter.port;
    try {
      const started = await api(port, shooter.token, '/sessions', {
        body: { command: process.execPath, args: [path.join(__dirname, '..', 'fixtures', 'ticking-screen.mjs')], shell: false, cols: 80, rows: 24 },
      });
      const id = String(started.body['id']);
      await eventually(async () => /Tick \d{8}/.test(String((await api(port, shooter.token, `/sessions/${id}/snapshot`)).body['screen'])), 30_000);
      const shot = await api(port, shooter.token, `/sessions/${id}/screenshot`, { body: {} });
      expect(shot.status, String(shot.body['error'])).toBe(200);
    } finally {
      await shooter.stop();
    }
  }, 90_000);
});
