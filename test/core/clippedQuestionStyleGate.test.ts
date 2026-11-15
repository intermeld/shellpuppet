import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { hasClippedQuestionShape } from '../../src/agents/opencode/prompts.js';
import { detectPrompt } from '../../src/core/promptDetector.js';
import { ScreenRenderer } from '../../src/core/renderer.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dialogs');
afterEach(() => vi.restoreAllMocks());

it('reads no styled rows while ordinary output is rendered', async () => {
  const renderer = new ScreenRenderer({ cols: 80, rows: 24, agent: 'opencode' });
  try {
    const styled = vi.spyOn(renderer, 'styledLines');
    await renderer.write([...Array<string>(20).fill('Earlier output'),
      'Questions', '1. Keep', '2. Change', '3. Finish'].join('\r\n'));
    const screen = renderer.snapshot();
    expect(screen.lines).toHaveLength(24);
    expect(hasClippedQuestionShape(screen.lines, screen.rows)).toBe(false);
    expect(styled).not.toHaveBeenCalled();
  } finally {
    await renderer.dispose();
  }
});

it('reads styles and reports the visible choices when a live panel reaches the bottom', async () => {
  const renderer = new ScreenRenderer({ cols: 80, rows: 24, agent: 'opencode' });
  try {
    await renderer.write(fs.readFileSync(path.join(fixtures, 'opencode-question-live-transcript.ansi'), 'utf8'));
    const styled = vi.spyOn(renderer, 'styledLines');
    const screen = renderer.snapshot();
    expect(hasClippedQuestionShape(screen.lines, screen.rows)).toBe(true);
    expect(styled).toHaveBeenCalled();
    expect(detectPrompt(screen.screen, 'opencode', screen.rows, renderer.styledLines().lines)?.options).toEqual([
      'teams planning it sample task (assignments)', 'teams the, sample task', 'teams teams the example',
    ]);
  } finally {
    await renderer.dispose();
  }
});
