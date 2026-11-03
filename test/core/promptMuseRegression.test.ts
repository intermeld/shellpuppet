import { describe, expect, it } from 'vitest';
import { detectPrompt } from '../../src/core/promptDetector.js';

const menu = [
  'Would you like to run the following command?',
  '  Stage 1/1',
  '  Current argv: ["x"]',
  '⟩ 1. Allow this stage once (y)',
  '  2. Abort the entire command (esc)',
].join('\n');

describe('Muse menu false positives', () => {
  it('does not treat a quoted menu at the end of an answer as live', () => {
    expect(detectPrompt(`❯ Show a menu example\n◆ Example:\n${menu}`)).toBeNull();
  });

  it('does not offer a menu once the program has resumed work below it', () => {
    expect(detectPrompt(`${menu}\n◇ Calling tools (1s · esc to interrupt)`)).toBeNull();
  });
});
