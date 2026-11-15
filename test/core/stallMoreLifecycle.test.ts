import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor, stallTranscriptContent } from '../../src/core/reasoning.js';
import { stalls } from '../../src/agents/mimo/stalls.js';
import { clippedError } from '../fixtures/stalls/clipped-error.mjs';

const refusal = readFileSync(new URL('../fixtures/stalls/mimo-refusal.ansi', import.meta.url), 'utf8');

async function transcript(screen: string) {
  const renderer = new ScreenRenderer({ cols: 120, rows: 30 });
  try {
    await renderer.write(screen);
    const columns = [...new Set(stalls.flatMap(shape => shape.frameColumns))];
    return stallTranscriptContent(renderer.framedViewport(columns), stalls, signatureFor('mimo', 'mimo')!);
  } finally { await renderer.dispose(); }
}

it('keeps real answer text in the comparison when an overlay signature is present', async () => {
  const original = await transcript(refusal);
  expect(original).toContain('Reading the sample.');
  expect(await transcript(refusal.replace('Reading the sample.', 'Changed real output.'))).not.toBe(original);
  expect(await transcript(refusal.replace('⎘ copy', '⎘ copied'))).toBe(original);
});

it('rejects a clipped body inside a black tool gutter', async () => {
  const renderer = new ScreenRenderer({ cols: 80, rows: 24 });
  try {
    await renderer.write(clippedError().replaceAll('\x1b[38;2;251;113;133m', '\x1b[38;2;10;10;10m'));
    const view = renderer.styledLines({ above: 128, extendWrapped: false });
    expect(detectStall(view.lines, signatureFor('mimo', 'mimo')!, false, view.firstVisible)).toBeNull();
  } finally { await renderer.dispose(); }
});
