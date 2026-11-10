import { describe, expect, it } from 'vitest';
import { detectPrompt } from '../../src/core/promptDetector.js';

const menu = [
  'Would you like to run the following command?',
  '  Stage 1/1',
  '  Current argv: ["x"]',
  '⟩ 1. Allow this stage once (y)',
  '  2. Abort the entire command (esc)',
].join('\n');

/** The plain two-choice approval, a long command wrapped at 80 columns. */
const declineMenu = [
  '  ◇ Calling tools (2h 20m 28s · esc to interrupt)',
  '  └ last event 2h 14m 23s ago',
  '── Voice input (Alt+V to start) ──────────────────────────────────────────────',
  'Would you like to run the following command?',
  '  $ $env:TEMP=(Resolve-Path scratch/tmp).Path; dotnet test',
  '    src/Example.Tests/Example.Tests.csproj -c Debug --no-restore --filter',
  '    "FullyQualifiedName~ExampleTests" --disable-build-servers -m:4',
  '⟩ 1. Yes, proceed (y)',
  '  2. No, and tell Muse Code what to do differently (esc)',
  'Change approval defaults in /permissions',
  '──────────────────────────────────────────────────────────────────────────────',
  '  example-model · high · example-session · Launch overrides',
].join('\n');

describe('Muse approval with a decline choice', () => {
  it('reports the two choices of the plain approval form', () => {
    const prompt = detectPrompt(declineMenu, 'muse');
    expect(prompt).toMatchObject({
      question: 'Would you like to run the following command?',
      options: ['1. Yes, proceed (y)', '2. No, and tell Muse Code what to do differently (esc)'],
      selectedOption: 0,
    });
  });

  it('still reads three choices when the second is not the decline', () => {
    const three = [
      'Would you like to run the following command?',
      '  $ npm install',
      '⟩ 1. Yes, proceed (y)',
      '  2. Yes, and always allow npm install in this workspace (p)',
      '  3. No, and tell Muse Code what to do differently (esc)',
    ].join('\n');
    expect(detectPrompt(three, 'muse')?.options).toHaveLength(3);
  });

  for (const selected of [1, 3]) {
    it(`keeps three choices when the second ends in (esc), with choice ${String(selected)} selected`, () => {
      const rows = ['1. Run it (y)', '2. Skip it (esc)', '3. Stop (n)']
        .map((label, index) => `${index + 1 === selected ? '⟩ ' : '  '}${label}`);
      const prompt = detectPrompt(['── Voice input (Alt+V to start) ──',
        'Would you like to run the following command?', '  $ npm test', ...rows].join('\n'), 'muse');
      expect(prompt?.options).toEqual(['1. Run it (y)', '2. Skip it (esc)', '3. Stop (n)']);
      expect(prompt?.selectedOption).toBe(selected - 1);
    });
  }

  it('does not offer the menu once the program has resumed work below it', () => {
    expect(detectPrompt(`${declineMenu}\n◇ Calling tools (1s · esc to interrupt)`, 'muse')).toBeNull();
  });

  it('does not treat a plain approval at the top of the screen with no border as live', () => {
    expect(detectPrompt(declineMenu.split('\n').slice(3).join('\n'), 'muse')).toBeNull();
  });

  it('does not treat a quoted plain approval as live once its answer marker has scrolled away', () => {
    const quoted = ['Show a menu example', 'Here is the menu:',
      ...declineMenu.split('\n').slice(3, 10)].join('\n');
    expect(detectPrompt(quoted, 'muse')).toBeNull();
  });
});

describe('Muse menu false positives', () => {
  it('does not treat a quoted menu at the end of an answer as live', () => {
    expect(detectPrompt(`❯ Show a menu example\n◆ Example:\n${menu}`)).toBeNull();
  });

  it('does not offer a menu once the program has resumed work below it', () => {
    expect(detectPrompt(`${menu}\n◇ Calling tools (1s · esc to interrupt)`)).toBeNull();
  });
});
