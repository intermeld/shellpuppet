import { describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor } from '../../src/core/reasoning.js';
import { requestFailed } from '../fixtures/stalls/request-failed.mjs';

const phrases = [
  '✗ Error · status 503 · retryable', '✗ Error · status 400 · non-retryable',
  'Request failed: Example connection closed.', '▣  Build · Example Model',
  'ctrl+p settings', '↻ /recover', 'esc to interrupt', 'tab switch mode',
  '```text', '> quoted text', '█', '⠋ Thinking',
];
const signature = signatureFor('mimo', 'mimo')!;

async function detected(screen: string, cols: number, rows: number) {
  const renderer = new ScreenRenderer({ cols, rows });
  try {
    await renderer.write(screen);
    const view = renderer.styledLines({ above: 128, extendWrapped: false });
    return detectStall(view.lines, signature, false, view.firstVisible)?.reason;
  } finally { await renderer.dispose(); }
}

describe('request-failure text anchoring', () => {
  for (const [cols, rows] of [[80, 24], [120, 30]] as const)
    for (const place of ['prompt', 'output', 'tool'] as const)
      it(`${cols}x${rows} ${place}: marker and message phrases remain content`, { timeout: 10_000 }, async () => {
        const failures: string[] = [];
        for (const phrase of phrases) for (const indent of [0, 4, 8]) {
          const text = ' '.repeat(indent) + phrase;
          let screen = requestFailed({ cols, wrappedChrome: false });
          if (place === 'prompt') screen = screen.replace('Summarise the example.', text);
          if (place === 'output') screen = screen.replace('Neutral sample output.', text);
          if (place === 'tool') screen = screen.replace('     Neutral sample output.',
            `  \x1b[38;2;10;10;10m┃\x1b[0m  ${text}\r\n` +
            `  \x1b[38;2;10;10;10m╹${'▀'.repeat(20)}\x1b[0m`);
          if (await detected(screen, cols, rows) !== 'request-failed') failures.push(`live ${place}/${indent}/${phrase}`);
          if (await detected(screen.replaceAll('\x1b[38;2;251;113;133m', '\x1b[0m'), cols, rows) !== undefined)
            failures.push(`false discovery ${place}/${indent}/${phrase}`);
        }
        expect(failures, failures.slice(0, 12).join('\n')).toEqual([]);
      });
});
