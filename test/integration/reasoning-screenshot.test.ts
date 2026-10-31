import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, startTestDaemon } from './helpers.js';
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
