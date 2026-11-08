import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor, validateStall } from '../../src/core/reasoning.js';

const fixture = readFileSync(new URL('../fixtures/stalls/mimo-refusal.ansi', import.meta.url), 'utf8');
const signature = signatureFor('mimo', 'mimo')!;
const markers = [
  { name: 'colon quotation', text: 'Sample:', ink: '' },
  { name: 'blockquote', text: '> sample', ink: '' },
  { name: 'backtick fence', text: '```text', ink: '' },
  { name: 'tilde fence', text: '~~~text', ink: '' },
  { name: 'tool panel', text: '┃  sample', ink: '\x1b[38;2;10;10;10m' },
];

for (const marker of markers) {
  it(`treats a clipped user continuation beginning with a ${marker.name} as unknown`, async () => {
    const renderer = new ScreenRenderer({ cols: 120, rows: 30 });
    try {
      // Align user-controlled markers with 80-column soft wraps. At 120
      // columns the whole user row fits inside the bounded context.
      const prompt = 'Neutral sample text'.padEnd(75) +
        (marker.ink + marker.text.padEnd(80) + '\x1b[0m').repeat(167);
      await renderer.write(fixture.replace('Summarise the sample.', prompt));
      const full = renderer.styledLines({ above: 128, extendWrapped: false });
      const candidate = detectStall(full.lines, signature, false, full.firstVisible);
      expect(candidate).not.toBeNull();
      renderer.resize(80, 24);
      const bounded = renderer.styledLines({ above: 128, extendWrapped: false });
      expect(bounded.lines.length).toBeLessThanOrEqual(152);
      expect(bounded.lines[0]?.wrapped).toBe(true);
      expect(bounded.lines[0]?.text.trim()).toBe(marker.text);
      expect(validateStall(bounded.lines, signature, false, bounded.firstVisible))
        .toEqual({ inconclusive: true, blockIdentity: candidate!.blockIdentity });
      expect(detectStall(bounded.lines, signature, false, bounded.firstVisible)).toBeNull();
    } finally { renderer.dispose(); }
  });

  it(`checks the framing of a complete ${marker.name} row after the unknown continuation`, async () => {
    const renderer = new ScreenRenderer({ cols: 80, rows: 24 });
    try {
      await renderer.write(fixture.replace('Summarise the sample.', 'Neutral sample text '.repeat(670))
        .replace('     Reading the sample.', `${marker.name === 'tool panel' ? '  ' : '     '}${marker.ink}${marker.text}\x1b[0m`));
      const bounded = renderer.styledLines({ above: 128, extendWrapped: false });
      expect(bounded.lines[0]?.wrapped).toBe(true);
      const complete = bounded.lines.findIndex(line => !line.wrapped && line.text.trim() === marker.text);
      expect(complete).toBeGreaterThan(0);
      const expected: unknown = marker.name === 'tool panel' ? null : expect.objectContaining({ inconclusive: true });
      expect(validateStall(bounded.lines, signature, false, bounded.firstVisible)).toEqual(expected);
      // Literal punctuation does not prove a quotation or a tool. Neither
      // result may discover without the user-turn boundary; a real dark
      // gutter still disqualifies the refusal even when that boundary is lost.
      expect(detectStall(bounded.lines, signature, false, bounded.firstVisible)).toBeNull();
      // A complete first row must also be checked when the turn is missing.
      expect(validateStall(bounded.lines.slice(complete), signature, false, Math.max(0, bounded.firstVisible - complete))).toEqual(expected);
    } finally { renderer.dispose(); }
  });
}
