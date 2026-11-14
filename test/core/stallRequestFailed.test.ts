import { describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { detectStall, signatureFor, StallTracker } from '../../src/core/reasoning.js';
import { requestFailed } from '../fixtures/stalls/request-failed.mjs';

const signature = signatureFor('mimo', 'mimo')!;
async function detect(screen: string, cols = 80, rows = 24) {
  const renderer = new ScreenRenderer({ cols, rows });
  try {
    await renderer.write(screen);
    const view = renderer.styledLines({ above: 128, extendWrapped: false });
    return detectStall(view.lines, signature, false, view.firstVisible);
  } finally { await renderer.dispose(); }
}

describe('MiMo request failures', () => {
  for (const [cols, rows] of [[80, 24], [96, 30], [120, 30], [160, 45]])
    for (const duration of [false, true]) for (const retryable of [false, true])
      for (const suggestion of [false, true]) {
        it(`detects ${cols}x${rows}, duration ${duration}, retryable ${retryable}, suggestion ${suggestion}`, async () => {
          expect(await detect(requestFailed({ cols, duration, retryable, suggestion }), cols, rows))
            .toMatchObject({ reason: 'request-failed', description: 'The model request failed.' });
        });
      }
  it('recognises other status codes and failure text, without recovery', async () => {
    expect(await detect(requestFailed({ status: 503, failure: 'Example service unavailable.', recover: false })))
      .toMatchObject({ reason: 'request-failed' });
  });
  it('recognises a footer without recovery or a trailing glyph', async () => {
    expect(await detect(requestFailed({ recover: false, trailingGlyph: false })))
      .toMatchObject({ reason: 'request-failed' });
  });
  it('recognises independently optional marker details', async () => {
    const full = requestFailed();
    const suffix = '\x1b[38;2;128;128;128m · status 400 · non-retryable\x1b[0m';
    expect(await detect(full.replace(suffix, ''))).toMatchObject({ reason: 'request-failed' });
    expect(await detect(full.replace(suffix, '\x1b[38;2;128;128;128m · status 400\x1b[0m')))
      .toMatchObject({ reason: 'request-failed' });
    expect(await detect(full.replace(suffix, '\x1b[38;2;128;128;128m · non-retryable\x1b[0m')))
      .toMatchObject({ reason: 'request-failed' });
  });
  it('rejects an unsent indented draft', async () => {
    expect(await detect(requestFailed({ draft: '    Draft example.' }))).toBeNull();
  });
  it('rejects an old error after a later turn ran', async () => {
    expect(await detect(requestFailed({ laterTurn: true }))).toBeNull();
  });
  it('rejects an error block inside tool output', async () => {
    expect(await detect(requestFailed({ toolOpen: true }))).toBeNull();
  });
  it('rejects an error quoted in a user turn', async () => {
    const screen = requestFailed({ quoted: true }).replaceAll('\x1b[38;2;251;113;133m', '\x1b[38;2;255;128;64m');
    expect(await detect(screen)).toBeNull();
  });
  it('keeps an established stall when only user text changes', async () => {
    const first = await detect(requestFailed());
    const changed = await detect(requestFailed().replace('Summarise the example.', 'Explain the example.'));
    const tracker = new StallTracker();
    expect(tracker.observe(first, 1000)).toBeUndefined();
    const state = tracker.observe(first, 2000);
    expect(state).toBeDefined();
    expect(tracker.observe(changed, 3000)).toBe(state);
  });
  it('keeps an established stall across a resize redraw', async () => {
    const first = await detect(requestFailed({ cols: 80 }), 80, 24);
    const changed = await detect(requestFailed({ cols: 120 }), 120, 30);
    const tracker = new StallTracker();
    tracker.observe(first, 1000);
    const state = tracker.observe(first, 2000);
    expect(state).toBeDefined();
    expect(tracker.observe(changed, 3000)).toBe(state);
  });
  it('does not report a retrying busy turn', async () => {
    expect(await detect(requestFailed({ retryable: true, busy: true }))).toBeNull();
  });
});
