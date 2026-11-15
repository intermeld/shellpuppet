import { describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor, StallTracker } from '../../src/core/reasoning.js';
import { outputLimit } from '../fixtures/stalls/output-limit.mjs';
import { serverLost } from '../fixtures/stalls/server-lost.mjs';
import { clippedError } from '../fixtures/stalls/clipped-error.mjs';
import { clippedSuggestion } from '../fixtures/stalls/clipped-suggestion.mjs';

async function candidate(screen: string, agent: string, cols = 80, rows = 24) {
  const renderer = new ScreenRenderer({ cols, rows });
  try {
    await renderer.write(screen);
    const view = renderer.styledLines({ above: 128, extendWrapped: false });
    return detectStall(view.lines, signatureFor(agent, agent)!, false, view.firstVisible);
  } finally { await renderer.dispose(); }
}
async function reason(screen: string, agent: string, cols = 80, rows = 24) {
  return (await candidate(screen, agent, cols, rows))?.reason;
}

describe('MiMo error blocks', () => {
  for (const [cols, rows] of [[80, 24], [120, 30]] as const) {
    it(`recognises a suggestion clipped at the composer edge at ${cols}x${rows}`, async () => {
      expect(await reason(clippedSuggestion({ cols }), 'mimo', cols, rows)).toBe('output-limit');
      expect(await reason(clippedSuggestion({ cols, noShortcut: true }), 'mimo', cols, rows)).toBeUndefined();
      for (const shortcut of ['(T', '(Ta', '(Tab', '(Tab ', '(Tab t']) {
        expect(await reason(clippedSuggestion({ cols, shortcut }), 'mimo', cols, rows), shortcut).toBe('output-limit');
      }
      expect(await reason(clippedSuggestion({ cols, shortcut: '(Tx' }), 'mimo', cols, rows)).toBeUndefined();
      expect(await reason(clippedSuggestion({ cols, message: 'Example service stopped.' }), 'mimo', cols, rows)).toBe('error');
      expect(await reason(clippedSuggestion({ cols, short: true }), 'mimo', cols, rows)).toBeUndefined();
      expect(await reason(clippedSuggestion({ cols, draft: '    Example draft.' }), 'mimo', cols, rows)).toBeUndefined();
      expect(await reason(clippedSuggestion({ cols, busy: true }), 'mimo', cols, rows)).toBeUndefined();
    });
  }
  it('settles and retains a clipped suggestion through a redraw', async () => {
    const tracker = new StallTracker();
    const first = await candidate(clippedSuggestion(), 'mimo');
    expect(tracker.observe(first, 1000)).toBeUndefined();
    const state = tracker.observe(first, 2000);
    expect(state?.reason).toBe('output-limit');
    expect(tracker.observe(await candidate(clippedSuggestion(), 'mimo'), 3000)).toBe(state);
  });
  for (const [cols, rows] of [[80, 24], [120, 30]] as const) {
    it(`recognises output limits and unfamiliar errors at ${cols}x${rows}`, async () => {
      expect(await reason(outputLimit({ cols }), 'mimo', cols, rows)).toBe('output-limit');
      expect(await reason(outputLimit({ cols, message: 'Example service stopped.' }), 'mimo', cols, rows)).toBe('error');
    });
    it(`keeps error words in ordinary text at ${cols}x${rows}`, async () => {
      const screen = outputLimit({ cols });
      expect(await reason(screen.replaceAll('\x1b[38;2;251;113;133m', '\x1b[0m'), 'mimo', cols, rows)).toBeUndefined();
      expect(await reason(outputLimit({ cols, draft: '    Example draft.' }), 'mimo', cols, rows)).toBeUndefined();
      expect(await reason(outputLimit({ cols, busy: true }), 'mimo', cols, rows)).toBeUndefined();
      expect(await reason(outputLimit({ cols, toolOpen: true }), 'mimo', cols, rows)).toBeUndefined();
      expect(await reason(outputLimit({ cols, laterTurn: true }), 'mimo', cols, rows)).toBeUndefined();
    });
    it(`anchors new marker details and message text at ${cols}x${rows}`, async () => {
      for (const marker of ['✗ Error', '✗ Error · example detail'])
        expect(await reason(outputLimit({ cols, marker }), 'mimo', cols, rows)).toBe('output-limit');
      expect(await reason(outputLimit({ cols, marker: '✗ Error · example detail',
        message: 'Request failed: Example connection closed.' }), 'mimo', cols, rows)).toBe('request-failed');
      expect(await reason(outputLimit({ cols, marker: '✗ Error · example detail',
        message: "The response was withheld by the model provider's content safety filter." }), 'mimo', cols, rows)).toBe('provider-refused');
      const more = outputLimit({ cols, message: 'Example service stopped.\r\n  \x1b[38;2;251;113;133m┃\x1b[0m     Another example detail.' });
      expect(await reason(more, 'mimo', cols, rows)).toBe('error');
      for (const phrase of ['✗ Error · example detail', 'Output length limit reached', 'Example service stopped.']) {
        const quoted = outputLimit({ cols }).replace('Neutral sample output.', phrase);
        expect(await reason(quoted, 'mimo', cols, rows)).toBe('output-limit');
      }
    });
  }
  it('retains the same output limit across redraw and resize', async () => {
    const tracker = new StallTracker();
    const first = await candidate(outputLimit({ cols: 80 }), 'mimo');
    tracker.observe(first, 1000);
    const state = tracker.observe(first, 2000);
    expect(state?.reason).toBe('output-limit');
    expect(tracker.observe(await candidate(outputLimit({ cols: 120, suggestion: true }), 'mimo', 120, 30), 3000)).toBe(state);
  });
});

describe('new error marker text anchoring', () => {
  const phrases = ['✗ Error · example detail', 'Output length limit reached', '↻ /recover',
    '▣  Build · Example Model', 'esc interrupt', '```text'];
  for (const [cols, rows] of [[80, 24], [120, 30]] as const)
    for (const place of ['prompt', 'output', 'tool'] as const)
      it(`keeps ${place} text separate at ${cols}x${rows}`, async () => {
        for (const phrase of phrases) for (const indent of [0, 4, 8]) {
          const text = ' '.repeat(indent) + phrase;
          let screen = outputLimit({ cols });
          if (place === 'prompt') screen = screen.replace('Summarise the example.', text);
          if (place === 'output') screen = screen.replace('Neutral sample output.', text);
          if (place === 'tool') screen = screen.replace('     Neutral sample output.',
            `  \x1b[38;2;10;10;10m┃\x1b[0m  ${text}\r\n` +
            `  \x1b[38;2;10;10;10m╹${'▀'.repeat(20)}\x1b[0m`);
          expect(await reason(screen, 'mimo', cols, rows)).toBe('output-limit');
          expect(await reason(screen.replaceAll('\x1b[38;2;251;113;133m', '\x1b[0m'), 'mimo', cols, rows)).toBeUndefined();
        }
      });
});

describe('MiMo error body with its marker above the viewport', () => {
  it('recognises the coloured JSON body at 80x24', async () => {
    expect(await reason(clippedError(), 'mimo')).toBe('error');
  });
  it('requires the red gutter, recovery footer and idle composer', async () => {
    for (const options of [{ redGutter: false }, { recover: false },
      { draft: '    Example draft.' }, { busy: true }, { laterTurn: true }])
      expect(await reason(clippedError(options), 'mimo')).toBeUndefined();
  });
});

describe('OpenCode connection banner', () => {
  for (const [cols, rows] of [[80, 24], [120, 30]] as const) {
    it(`recognises the live banner above a busy row at ${cols}x${rows}`, async () => {
      for (const agent of ['opencode', 'mimo'])
        expect(await reason(serverLost({ cols, rows }), agent, cols, rows)).toBe('server-lost');
    });
    it(`rejects quoted, typed, unstyled and displaced text at ${cols}x${rows}`, async () => {
      for (const option of [{ banner: false, quoted: true }, { banner: false, fileOutput: true },
        { banner: false, typed: true },
        { styled: false }, { shifted: true }])
        expect(await reason(serverLost({ cols, rows, ...option }), 'opencode', cols, rows)).toBeUndefined();
    });
  }
  it('settles through spinner redraws and clears when the banner goes', async () => {
    const tracker = new StallTracker();
    tracker.observe(await candidate(serverLost(), 'opencode'), 1000);
    expect(tracker.observe(await candidate(serverLost({ spinner: '⠼' }), 'opencode'), 2000)?.reason).toBe('server-lost');
    expect(tracker.observe(await candidate(serverLost({ banner: false }), 'opencode'), 2001)).toBeUndefined();
  });
});
