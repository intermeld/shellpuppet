import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, expect, it } from 'vitest';
import { codex } from '../../src/agents/codex/index.js';
import type { StyledLine } from '../../src/core/renderer.js';
import { nudgeVerdict } from '../../src/core/nudge.js';
import { Session } from '../../src/core/session.js';

const ink = { bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null };
const footer = '  GPT-X high fast · Context 99% left · weekly 76% left · active';

function styled(text: string, inverse = false): StyledLine {
  return { text, spans: text ? [{ ...ink, inverse, bold: text.startsWith('›'), from: 0, to: 1 },
    { ...ink, inverse, from: 1, to: text.length }] : [] };
}

function screen(cols: number, rows: number, body: string, popup = false, cursorY = rows - 4) {
  const lines = Array.from({ length: rows }, () => styled(''));
  const at = rows - 4;
  lines[at] = styled('› ' + body);
  lines[at + 2] = styled(footer);
  if (popup) lines[at - 2] = styled('› ' + body + '  command suggestion', true);
  return { rows: lines.map(line => line.text), styled: lines, viewportCols: cols,
    viewportRows: rows, cursor: { x: 2 + body.length, y: cursorY }, unchangedMs: 5000,
    expectedDraft: body };
}

it.each([ [80, 24], [120, 30] ])('recognises the live slash composer at %ix%i', (cols, rows) => {
  expect(nudgeVerdict(codex, screen(cols, rows, '/mcp', true))).toEqual({ ready: true });
  expect(nudgeVerdict(codex, screen(cols, rows, '/model', true))).toEqual({ ready: true });
});

it('keeps a plain draft ready without a popup', () => {
  expect(nudgeVerdict(codex, screen(80, 24, 'plain line'))).toEqual({ ready: true });
});

it('withholds Enter when the popup owns the cursor', () => {
  expect(nudgeVerdict(codex, screen(80, 24, '/mcp', true, 18)).ready).toBe(false);
});

it('withholds Enter for a different draft in the input', () => {
  expect(nudgeVerdict(codex, { ...screen(80, 24, 'other draft', true), expectedDraft: '/mcp' }).ready).toBe(false);
});

it('retains the captured short suffix verdict with styled rows and its cursor', () => {
  const captures = JSON.parse(readFileSync(new URL('../fixtures/nudge/codex-review-screens.json', import.meta.url), 'utf8')) as
    { name: string; rows: string[]; viewportRows: number; viewportCols: number;
      cursor: { x: number; y: number }; expectedDraft: string }[];
  const capture = captures.find(item => item.name === 'short-suffix-after');
  if (!capture) throw new Error('Missing short suffix capture');
  expect(nudgeVerdict(codex, { ...capture, styled: capture.rows.map(text => styled(text)), unchangedMs: 5000 }))
    .toEqual({ ready: true });
});

it('ignores an inverse popup choice when the footer is clipped', () => {
  const frame = screen(80, 24, '/mcp', true);
  const lines = frame.styled.slice(0, 21);
  const clipped = { ...frame, rows: lines.map(line => line.text), styled: lines };
  expect(nudgeVerdict(codex, clipped)).toEqual({ ready: true });
  expect(nudgeVerdict(codex, { ...clipped, cursor: { x: 6, y: 18 } }).ready).toBe(false);
  const withoutComposer = lines.map((line, i) => i === 20 ? styled('') : line);
  expect(nudgeVerdict(codex, { ...clipped, rows: withoutComposer.map(line => line.text),
    styled: withoutComposer }).ready).toBe(false);
});

it.each([
  { name: 'cursor on the prompt glyph', inverse: false, bold: true, withFooter: false, x: 1 },
  { name: 'inverse ink in the input body', inverse: true, bold: true, withFooter: false, x: 7 },
  { name: 'ordinary styled prompt glyph', inverse: false, bold: false, withFooter: true, x: 7 },
])('keeps the no-popup verdict with $name', ({ inverse, bold, withFooter, x }) => {
  const height = withFooter ? 24 : 10;
  const at = withFooter ? 20 : 8;
  const lines = Array.from({ length: height }, () => styled(''));
  lines[at] = { text: '› hello', spans: [
    { ...ink, bold, from: 0, to: 1 },
    { ...ink, inverse, from: 1, to: 7 },
  ] };
  if (withFooter) lines[at + 2] = styled('  GPT-X high · Context 99% left · weekly 76% left · active');
  expect(nudgeVerdict(codex, { rows: lines.map(line => line.text), styled: lines,
    viewportCols: 80, viewportRows: height, cursor: { x, y: at },
    expectedDraft: 'hello', unchangedMs: 5000 })).toEqual({ ready: true });
});

it('keeps a wrapped marker row outside the composer', () => {
  const lines = Array.from({ length: 10 }, () => styled(''));
  lines[7] = styled('x'.repeat(80));
  lines[8] = { ...styled('› hello'), wrapped: true };
  expect(nudgeVerdict(codex, { rows: lines.map(line => line.text), styled: lines,
    viewportCols: 80, viewportRows: 10, cursor: { x: 7, y: 8 },
    expectedDraft: 'hello', unchangedMs: 5000 })).toEqual({ ready: false, reason: 'unknown' });
});

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session['renderer'].dispose();
});

it('writes the slash body and Enter through the recording PTY', async () => {
  let output!: (data: string) => void;
  const writes: string[] = [];
  const frame = (body: string) => '\x1b[2J\x1b[H' +
    '\x1b[19;1H\x1b[7m› /mcp  list tools and connections\x1b[0m' +
    '\x1b[21;1H\x1b[1m›\x1b[0m ' + body +
    '\x1b[23;1H' + footer + '\x1b[21;' + String(body.length + 3) + 'H';
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
    onData(listener) { output = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
    write(data: string) { writes.push(data); output(frame(data === '\r' ? '' : data)); },
    resize() {}, kill() {}, clear() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('s1', { command: process.execPath, cwd: resolve('.'), agent: 'codex', shell: false },
    { platform: 'linux', spawn: () => pty });
  sessions.push(session);
  output(frame(''));
  await session['renderer'].flush();
  await session.writeWithResult('/mcp', { submitMode: 'on' });
  expect(writes).toEqual(['/mcp', '\r']);
}, 10_000);
