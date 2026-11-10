import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor, StallTracker } from '../../src/core/reasoning.js';
import { modernRefusal } from '../fixtures/stalls/modern-refusal.mjs';

const signature = signatureFor('mimo', 'mimo')!;
const modernCapture = readFileSync(new URL('../fixtures/stalls/modern-refusal.ansi', import.meta.url), 'utf8');
async function detect(screen: string, cols = 96, rows = 30) {
  const renderer = new ScreenRenderer({ cols, rows });
  try {
    await renderer.write(screen);
    const view = renderer.styledLines({ above: 128, extendWrapped: false });
    return detectStall(view.lines, signature, false, view.firstVisible);
  } finally { await renderer.dispose(); }
}

describe('modern MiMo refusal', () => {
  for (const [cols, rows] of [[80, 24], [96, 30], [120, 30], [160, 45]])
    for (const suggestion of [false, true]) for (const highRisk of [false, true])
      for (const panel of [false, true]) for (const footer of ['old', 'new'] as const) {
        it(`detects ${cols}x${rows}, suggestion ${suggestion}, risk ${highRisk}, panel ${panel}, ${footer} footer`, async () => {
          expect(await detect(modernRefusal({ cols, suggestion, highRisk, panel, footer }), cols, rows))
            .toMatchObject({ reason: 'provider-refused' });
        });
      }

  it('recognises full-width chrome after xterm marks each following row as wrapped', async () => {
    expect(await detect(modernRefusal({ fullWidthChrome: true })))
      .toMatchObject({ reason: 'provider-refused' });
  });
  it('recognises an isolated current panel frame with the earlier user turn off-screen', async () => {
    expect(await detect(modernCapture))
      .toMatchObject({ reason: 'provider-refused' });
  });
  it('does not count white typed input as a grey suggestion', async () => {
    const screen = modernRefusal({ suggestion: true }).replace(
      '\x1b[38;2;128;128;128mReview the sample task. (Tab to\x1b[0m', 'Draft text');
    expect(await detect(screen)).toBeNull();
  });
  it('does not count a mixed-ink draft as a grey suggestion', async () => {
    const screen = modernRefusal().replace(
      '\x1b[38;2;128;128;128mReview the sample task. (Tab to\x1b[0m',
      '\x1b[38;2;128;128;128mR\x1b[0meview the sample task. (Tab to');
    expect(await detect(screen)).toBeNull();
  });
  it('rejects a dark tool gutter on a grey composer phrase', async () => {
    const screen = modernRefusal().replace(
      '  \x1b[38;2;251;129;71m┃\x1b[0m  \x1b[38;2;128;128;128mReview the sample task. (Tab to',
      '  \x1b[38;2;10;10;10m┃\x1b[0m  \x1b[38;2;128;128;128mReview the sample task. (Tab to');
    expect(await detect(screen)).toBeNull();
  });
  it('does not report a historical refusal followed by another turn', async () => {
    const screen = modernRefusal().replace('  \x1b[38;2;251;129;71m┃\x1b[0m\r\n',
      '  \x1b[38;2;255;128;64m┃\x1b[0m  Continue the task.\r\n     New output.\r\n  \x1b[38;2;251;129;71m┃\x1b[0m\r\n');
    expect(await detect(screen)).toBeNull();
  });
  it('does not mistake a coloured listing in tool output for a live refusal', async () => {
    const screen = readFileSync(new URL('../fixtures/stalls/cat_ansi_in_tool_panel.ansi', import.meta.url), 'utf8');
    expect(await detect(screen, 120, 30)).toBeNull();
  });
  it('does not mistake an indented draft for an idle composer', async () => {
    const screen = readFileSync(new URL('../fixtures/stalls/multiline-indented-draft.ansi', import.meta.url), 'utf8');
    expect(await detect(screen, 120, 30)).toBeNull();
  });
  it('keeps an established notice when only the user turn changes', async () => {
    const first = await detect(modernRefusal());
    const changed = await detect(modernRefusal().replace('Review the sample.', 'Review the example.'));
    expect(first).not.toBeNull();
    expect(changed).not.toBeNull();
    const tracker = new StallTracker();
    expect(tracker.observe(first, 1000)).toBeUndefined();
    const state = tracker.observe(first, 2000);
    expect(state).toBeDefined();
    expect(tracker.observe(changed, 3000)).toBe(state);
  });
});
