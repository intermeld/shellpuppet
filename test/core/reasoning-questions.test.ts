/**
 * The reasoning filter keeps a question the program is waiting on, and
 * leaves reasoning hidden when the only reason to show it was a weak
 * detection. Counts under MAIN were measured on main (d8ea021).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as promptDetector from '../../src/core/promptDetector.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import type { StyledLine } from '../../src/core/renderer.js';
import { BUILT_IN_SIGNATURES, compileSignatures, hideReasoning } from '../../src/core/reasoning.js';
import type { CompiledSignature } from '../../src/core/reasoning.js';

const { detectPrompt } = promptDetector;

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'reasoning');

/** Lines `hideReasoning` hid for each fixture on main (d8ea021). */
const MAIN_HIDDEN: Readonly<Record<string, number>> = {
  'agy-answered': 1,
  'agy-thinking': 1,
  'agy-working-after-summary': 2,
  'claude-answered': 0,
  'claude-prompt-typed': 0,
  'claude-thinking': 0,
  'claude-tool-call-running': 0,
  'claude-transcript-view': 0,
  'codex-answered': 0,
  'codex-answered-after-commentary-and-tools': 0,
  'codex-answered-second-turn': 0,
  'codex-command-running': 0,
  'codex-prompt-typed': 0,
  'codex-working': 0,
  'codex-working-after-commentary': 0,
  'grok-answered': 0,
  'grok-answered-after-tool': 0,
  'grok-permission-box': 10,
  'grok-permission-box-command': 13,
  'grok-thinking': 4,
  'grok-thinking-after-tool': 2,
  'grok-thinking-second-turn': 4,
  'mimo-answered': 0,
  'mimo-answered-two-paragraphs': 0,
  'mimo-working': 0,
  'mimo-working-second-turn': 0,
  'opencode-answer-streaming': 0,
  'opencode-answered': 0,
  'opencode-answered-two-paragraphs': 0,
  'opencode-thinking': 0,
  'opencode-thinking-after-tool': 0,
  'qoder-answered-after-reasoning': 16,
  'qoder-answered-first-turn': 11,
  'qoder-prompt-typed': 11,
  'qoder-thinking-second-turn': 11,
  'qoder-working': 0,
};

const BOX_HIDDEN: Readonly<Record<string, number>> = {
  // Both boxes keep the question, the command and the options, and the bare
  // bar directly above the question. The reasoning text above that stays hidden.
  'grok-permission-box': 3,
  'grok-permission-box-command': 3,
};

async function screen(name: string): Promise<StyledLine[]> {
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as {
    cols: number;
    rows: number;
  };
  const renderer = new ScreenRenderer({ cols: meta.cols, rows: meta.rows });
  await renderer.write(fs.readFileSync(path.join(FIXTURES, `${name}.ansi`), 'utf8'));
  const { lines } = renderer.styledLines({ last: 2000 });
  renderer.dispose();
  return lines;
}

function builtIn(name: string): CompiledSignature {
  const found = compileSignatures(BUILT_IN_SIGNATURES, 'built-in').signatures.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no built-in signature ${name}`);
  return found;
}

function plain(text: string, italic = false): StyledLine {
  return {
    text,
    spans:
      text === ''
        ? []
        : [{ from: 0, to: text.length, bold: false, dim: false, italic, inverse: false, fg: null, bg: null }],
  };
}

describe('every reasoning fixture hides what it hid on main', () => {
  it('hides the same number of lines, except for the two box fixtures', async () => {
    for (const [name, mainCount] of Object.entries(MAIN_HIDDEN)) {
      const filtered = hideReasoning(await screen(name), builtIn(name.split('-')[0]!));
      expect(filtered, name).not.toBeNull();
      if (filtered === null || name in BOX_HIDDEN) continue;
      expect(filtered.hiddenLines, name).toBe(mainCount);
    }
  });

  it('hides only the reasoning above each box', async () => {
    for (const [name, count] of Object.entries(BOX_HIDDEN)) {
      const lines = await screen(name);
      const filtered = hideReasoning(lines, builtIn('grok'));
      expect(filtered, name).not.toBeNull();
      if (filtered === null) continue;
      expect(filtered.hiddenLines, name).toBe(count);
      expect(filtered.lines.join('\n'), name).not.toContain('X xxxx');
      const question = lines.findIndex((line) => /^ {2}│ {2}> /.test(line.text));
      expect(question, name).toBeGreaterThan(0);
      expect(lines[question - 1]!.text, name).toBe('  │');
      // The bare bar directly above the question is border, not reasoning.
      expect(filtered.rows, name).toContain(question - 1);
    }
  });
});

describe('every question shape the detector knows survives hideReasoning', () => {
  // A signature that would hide every non-blank line below its first: only
  // the claimed rows stop it.
  const hungry = compileSignatures([
    {
      name: 'hungry',
      composer: { text: '^> ' },
      reasoning: [{ start: { text: '^Thinking' }, continues: { text: '^\\S' } }],
      answer: { start: { text: '^• ' } },
    },
  ]).signatures[0]!;

  const shapes: { name: string; lines: string[]; mustKeep: string[] }[] = [
    {
      name: 'MiMo Code question menu',
      lines: ['Thinking', '  ┃  Which notes should be used?', '  ┃', '  ┃  1. Existing notes', '  ┃  2. Type your own answer', '  ┃', '  ┃  ↑↓ select  enter submit  esc dismiss'],
      mustKeep: ['  ┃  Which notes should be used?', '  ┃  1. Existing notes', '  ┃  2. Type your own answer'],
    },
    {
      name: 'numbered',
      lines: ['Thinking', 'Allow this command to run?', '  1 (○) Allow once', '  2 (•) No'],
      mustKeep: ['Allow this command to run?', '  1 (○) Allow once', '  2 (•) No'],
    },
    {
      name: 'letter',
      lines: ['Thinking', 'Apply the change?', '[a] Apply', '[b] Skip'],
      mustKeep: ['Apply the change?', '[a] Apply', '[b] Skip'],
    },
    {
      name: 'pointer',
      lines: ['Thinking', 'Which template?', '❯ Vue', '  React'],
      mustKeep: ['Which template?', '❯ Vue', '  React'],
    },
    {
      name: 'key-hint',
      lines: ['Thinking', 'Do you trust this folder?', 'Yes, proceed   y', 'No, exit       n'],
      mustKeep: ['Do you trust this folder?', 'Yes, proceed   y', 'No, exit       n'],
    },
    {
      name: 'clack',
      lines: ['Thinking', '◆  Choose a template', '│  ● Vue', '│  ○ React', '└'],
      mustKeep: ['◆  Choose a template', '│  ● Vue', '│  ○ React'],
    },
    {
      name: 'dialog',
      lines: [
        'Thinking',
        '  Removing the generated output folder.',
        '',
        '  ┃  △ Permission required',
        '  ┃',
        '  ┃  ✗ Confirm irreversible deletion',
        '  ┃  $ rm -rf dist/',
        '  ┃',
        '  ┃   Allow once   Reject',
      ],
      mustKeep: ['  ┃  △ Permission required', '  ┃   Allow once   Reject'],
    },
    {
      name: 'yes/no tail',
      lines: ['Thinking', 'Continue? (y/n)'],
      mustKeep: ['Continue? (y/n)'],
    },
    {
      name: 'press-enter',
      lines: ['Thinking', 'Press enter to continue'],
      mustKeep: ['Press enter to continue'],
    },
  ];

  for (const shape of shapes) {
    it(`keeps a ${shape.name} question and its options`, () => {
      const lines = shape.lines.map((text) => plain(text));
      expect(detectPrompt(shape.lines.join('\n')), shape.name).not.toBeNull();
      const kept = hideReasoning(lines, hungry)!.lines;
      for (const line of shape.mustKeep) expect(kept, shape.name).toContain(line);
      expect(kept.join('\n'), shape.name).not.toMatch(/^Thinking$/m);
    });
  }
});

describe('Grok box question row', () => {
  const grok = builtIn('grok');

  it('reads the two-space question row as the question, and not a question mark above it', () => {
    const lines = [
      '  │  Which file should be restored?',
      '  │',
      '  │  >  Restore the saved file and compare digests',
      '  │  │ Copy-Item a.ts',
      '  │  1 (○) Yes',
      '  │  2 (•) No',
    ];
    const prompt = detectPrompt(lines.join('\n'));
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toMatch(/Restore the saved file/);
    expect(prompt!.question).not.toMatch(/Which file/);
    expect(prompt!.rows[0]).toBe(2);
  });

  it('never reads the one-space composer row as that question', () => {
    const lines = ['  │ >', '  │  1 (○) Yes', '  │  2 (•) No'];
    const prompt = detectPrompt(lines.join('\n'));
    expect(prompt).not.toBeNull();
    expect(prompt!.question).not.toMatch(/│ >/);
    expect(prompt!.rows[0]).toBe(1);
  });

  it('hides a question mark in the reasoning above a command box', () => {
    const lines = [
      '     > run the tests',
      '  │  ♦ Thinking…',
      '  │  Which file should be restored?',
      '  │',
      '  │  >  Restore the saved file and compare digests',
      '  │  │ Copy-Item a.ts',
      '  │',
      '  │  1 (○) Yes',
      '  │  2 (•) No',
    ].map((text) => plain(text));
    const kept = hideReasoning(lines, grok)!.lines;
    expect(kept.join('\n')).not.toContain('Which file should be restored?');
    expect(kept.join('\n')).not.toContain('Thinking');
    expect(kept).toContain('  │  >  Restore the saved file and compare digests');
    expect(kept).toContain('  │  │ Copy-Item a.ts');
    expect(kept).toContain('  │  2 (•) No');
  });

  it('keeps the command fixture question, and reads it from the question row', async () => {
    const lines = await screen('grok-permission-box-command');
    const prompt = detectPrompt(lines.map((line) => line.text).join('\n'));
    expect(prompt?.question).toMatch(/Restore the saved file/);
    expect(hideReasoning(lines, grok)!.lines).toContain('  │  >  Restore the saved file and compare digests');
  });
});

describe('the option row and the border are what keep a box the detector missed', () => {
  const grok = builtIn('grok');

  it('keeps a single option row when the detector claims nothing', () => {
    // One radio is not a numbered block, so detection claims nothing. Only
    // the option clause of the box row keeps it.
    const lines = [
      '     > run the tests',
      '  │  ♦ Thinking…',
      '  │  X xxxx reasoning',
      '  │  >  Allow Run the unit tests?',
      '  │  1 (•) Yes, proceed',
    ].map((text) => plain(text));
    expect(detectPrompt(lines.map((line) => line.text).join('\n'))).toBeNull();
    const kept = hideReasoning(lines, grok)!.lines;
    expect(kept).toContain('  │  >  Allow Run the unit tests?');
    expect(kept).toContain('  │  1 (•) Yes, proceed');
    expect(kept.join('\n')).not.toContain('X xxxx');
  });

  it('keeps the box rows when a busy line makes the detector decline them', () => {
    const lines = [
      '     > run the tests',
      '  │  ♦ Thinking…',
      '  │  X xxxx reasoning',
      '  │  >  Allow Run the unit tests?',
      '  │  1 (○) Yes',
      '  │  2 (•) No',
      '   | Thinking… 3.1s',
    ].map((text) => plain(text));
    expect(detectPrompt(lines.map((line) => line.text).join('\n'))).toBeNull();
    const kept = hideReasoning(lines, grok)!.lines;
    expect(kept).toContain('  │  1 (○) Yes');
    expect(kept).toContain('  │  2 (•) No');
    expect(kept.join('\n')).not.toContain('X xxxx');
  });
});

describe('a question-shaped line or a numbered list inside reasoning', () => {
  const cases: { name: string; agent: string; lines: StyledLine[]; reasoning: string[] }[] = [
    {
      name: 'grok: question and numbered list behind the bar, composer below',
      agent: 'grok',
      lines: [
        '     > run the tests',
        '  │  ♦ Thinking…',
        '  │  Would you like to run these?',
        '  │  1. First step',
        '  │  2. Second step',
        '  │  still reasoning',
        '  │ >',
      ].map((text) => plain(text)),
      reasoning: ['  │  Would you like to run these?', '  │  1. First step', '  │  2. Second step'],
    },
    {
      name: 'qoder: question and numbered list behind the bar, composer below',
      agent: 'qoder',
      lines: [
        plain(' > run the tests'),
        plain(' Thinking', true),
        plain(' │ Would you like to run these?'),
        plain(' │ 1. First step'),
        plain(' │ 2. Second step'),
        plain(' │ still reasoning'),
        plain(' > '),
      ],
      reasoning: [' │ Would you like to run these?', ' │ 1. First step', ' │ 2. Second step'],
    },
    {
      name: 'agy: summary line above a question and its options',
      agent: 'agy',
      lines: ['> run the tests', '○ Thought for 4.2s (planning)', 'Run this command?', '❯ 1. Yes', '  2. No'].map((text) =>
        plain(text),
      ),
      reasoning: ['○ Thought for 4.2s (planning)'],
    },
  ];

  for (const c of cases) {
    it(`keeps the reasoning hidden: ${c.name}`, () => {
      const kept = hideReasoning(c.lines, builtIn(c.agent))!.lines;
      for (const line of c.reasoning) expect(kept, c.name).not.toContain(line);
    });
  }

  it('hides a numbered list in the Grok bar when nothing below it makes it live', () => {
    const lines = [
      '     > run the tests',
      '  │  ♦ Thinking…',
      '  │  Would you like to run these?',
      '  │  1. First step',
      '  │  2. Second step',
    ].map((text) => plain(text));
    const kept = hideReasoning(lines, builtIn('grok'))!.lines.join('\n');
    expect(kept).not.toContain('Would you like to run these?');
    expect(kept).not.toContain('1. First step');
    expect(kept).not.toContain('2. Second step');
  });

  it('hides a numbered list in the Qoder bar when the reasoning block began above it', () => {
    const lines = [
      plain(' > run the tests'),
      plain(' Thinking', true),
      plain(' │ Would you like to run these?'),
      plain(' │ 1. First step'),
      plain(' │ 2. Second step'),
    ];
    const kept = hideReasoning(lines, builtIn('qoder'))!.lines.join('\n');
    expect(kept).not.toContain('Would you like to run these?');
    expect(kept).not.toContain('1. First step');
    expect(kept).not.toContain('2. Second step');
  });

  it('hides a reasoning summary drawn between a question and its options', () => {
    const lines = ['> run the tests', 'Run this command?', '○ Thought for 4.2s (planning)', '❯ 1. Yes', '  2. No'].map(
      (text) => plain(text),
    );
    const kept = hideReasoning(lines, builtIn('agy'))!.lines;
    expect(kept).not.toContain('○ Thought for 4.2s (planning)');
    expect(kept).toContain('Run this command?');
    expect(kept).toContain('❯ 1. Yes');
    expect(kept).toContain('  2. No');
  });
});

describe('stated limits: a live-looking row inside reasoning stays', () => {
  it('keeps a filled radio drawn as a Grok option row', () => {
    // The same row is a real option. The signature keeps it when detection
    // claims nothing, so it also keeps one the reasoning happened to draw.
    const lines = [
      '     > run the tests',
      '  │  ♦ Thinking…',
      '  │  Which option?',
      '  │  1 (○) First',
      '  │  2 (•) Second',
      '  │ >',
    ].map((text) => plain(text));
    const kept = hideReasoning(lines, builtIn('grok'))!.lines;
    expect(kept).toContain('  │  Which option?');
    expect(kept).toContain('  │  2 (•) Second');
    expect(kept.join('\n')).not.toContain('Thinking');
  });

  it('keeps a filled radio inside Qoder reasoning', () => {
    // The filled radio is what shows a selector is live. Dropping that claim
    // would hide a real selector whose rows a signature would otherwise take.
    const lines = [
      plain(' > run the tests'),
      plain(' Thinking', true),
      plain(' │ Which option?'),
      plain(' │ 1 (○) First'),
      plain(' │ 2 (•) Second'),
      plain(' > '),
    ];
    const kept = hideReasoning(lines, builtIn('qoder'))!.lines;
    expect(kept).toContain(' │ Which option?');
    expect(kept).toContain(' │ 2 (•) Second');
  });

  it('keeps a blockquoted numbered list drawn as a Grok question row', () => {
    // `│  > 1.` is the box's question row and a sign-in marker. A numbered
    // list the reasoning draws that way stays on screen.
    const lines = [
      '     > run the tests',
      '  │  ♦ Thinking…',
      '  │  > 1. First step',
      '  │  > 2. Second step',
      '  │ >',
    ];
    const prompt = detectPrompt(lines.join('\n'));
    expect(prompt?.question).toMatch(/1\. First step/);
    expect(prompt?.rows).toEqual([2, 3]);
    expect(prompt?.basis).toBe('marker');
    const filtered = hideReasoning(lines.map((text) => plain(text)), builtIn('grok'))!;
    expect(filtered.hiddenLines).toBe(1);
    expect(filtered.lines).toContain('  │  > 1. First step');
    expect(filtered.lines).toContain('  │  > 2. Second step');
    expect(filtered.lines.join('\n')).not.toContain('Thinking');
  });

  it('keeps a letter menu at the end of a Grok reasoning block', () => {
    // Letter keys are what show a selector is live. Dropping the claim
    // would hide a real menu, so one drawn at the end of the reasoning stays.
    const lines = [
      '     > run the tests',
      '  │  ♦ Thinking…',
      '  │  Apply the change?',
      '  │  [a] Apply',
      '  │  [b] Skip',
    ];
    const prompt = detectPrompt(lines.join('\n'));
    expect(prompt?.question).toMatch(/Apply the change\?/);
    expect(prompt?.options).toEqual(['[a] Apply', '[b] Skip']);
    expect(prompt?.basis).toBe('frame');
    const filtered = hideReasoning(lines.map((text) => plain(text)), builtIn('grok'))!;
    expect(filtered.hiddenLines).toBe(1);
    expect(filtered.lines).toContain('  │  Apply the change?');
    expect(filtered.lines).toContain('  │  [a] Apply');
    expect(filtered.lines).toContain('  │  [b] Skip');
    expect(filtered.lines.join('\n')).not.toContain('Thinking');
  });
});

describe('the older Grok command, plain bar text above the radios', () => {
  const grok = builtIn('grok');
  const closed = [
    '  │  reasoning that stays hidden',
    '  │',
    '  │  Locate worktree and prod-related docs',
    '  │  $wt = "D:/work/feature"; git rev-parse --abbrev-ref HEAD',
    '  │',
    '  │  1 (○) Yes, and don\'t ask again',
    '  │  2 (•) Yes, proceed',
    '  │  3 (○) No, and stop',
  ];

  it('keeps the command when a bare bar closes it off from the reasoning', () => {
    const kept = hideReasoning(closed.map((text) => plain(text)), grok)!.lines;
    expect(kept).toContain('  │  Locate worktree and prod-related docs');
    expect(kept).toContain('  │  $wt = "D:/work/feature"; git rev-parse --abbrev-ref HEAD');
    expect(kept).toContain('  │  2 (•) Yes, proceed');
    expect(kept.join('\n')).not.toContain('reasoning that stays hidden');
  });

  it('hides a question mark above the bare bar that closes the command', () => {
    const lines = [
      '  │  Which file should be restored?',
      '  │',
      '  │  Locate worktree and prod-related docs',
      '  │  $wt = "D:/work/feature"; git rev-parse --abbrev-ref HEAD',
      '  │',
      '  │  1 (○) Yes, and don\'t ask again',
      '  │  2 (•) Yes, proceed',
      '  │  3 (○) No, and stop',
    ].map((text) => plain(text));
    const kept = hideReasoning(lines, grok)!.lines;
    expect(kept.join('\n')).not.toContain('Which file should be restored?');
    expect(kept).toContain('  │  Locate worktree and prod-related docs');
    expect(kept).toContain('  │  2 (•) Yes, proceed');
  });

  it('leaves the command with the reasoning when no bare bar closes it off', () => {
    // Without that bar the command and the reasoning are the same shape.
    // Taking the command would take the reasoning with it.
    const lines = [
      '  │  reasoning that stays hidden',
      '  │  Locate worktree and prod-related docs',
      '  │  1 (○) Yes',
      '  │  2 (•) No',
      '  │  3 (○) Stop',
    ].map((text) => plain(text));
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('Locate worktree');
    expect(kept).not.toContain('reasoning that stays hidden');
    expect(kept).toContain('  │  2 (•) No');
  });

  it('hides the reasoning when a bar above the thinking closes a run with no command evidence', () => {
    // A mid-repaint: a bare bar above the thinking, plain bar text, then the
    // radios. Nothing in the run is a question row, a `$` or a `:` continuation.
    const lines = [
      '  │',
      '  │  ♦ Thinking…',
      '  │  reasoning that should hide',
      '  │  Locate worktree',
      '  │',
      '  │  1 (○) Yes',
      '  │  2 (•) No',
      '  │ >',
    ];
    const prompt = detectPrompt(lines.join('\n'));
    expect(prompt?.rows).toEqual([5, 6]);
    const filtered = hideReasoning(lines.map((text) => plain(text)), grok)!;
    expect(filtered.hiddenLines).toBe(3);
    const kept = filtered.lines.join('\n');
    expect(kept).not.toContain('Thinking');
    expect(kept).not.toContain('reasoning that should hide');
    expect(kept).not.toContain('Locate worktree');
    expect(kept).toContain('  │  1 (○) Yes');
    expect(kept).toContain('  │  2 (•) No');
  });

  it('hides a run of bar text between two bare bars when it carries no command evidence', () => {
    const lines = [
      '  │',
      '  │  reasoning one',
      '  │  reasoning two',
      '  │',
      '  │  1 (○) Yes',
      '  │  2 (•) No',
      '  │ >',
    ];
    const prompt = detectPrompt(lines.join('\n'));
    expect(prompt?.rows).toEqual([4, 5]);
    const filtered = hideReasoning(lines.map((text) => plain(text)), grok)!;
    expect(filtered.hiddenLines).toBe(2);
    const kept = filtered.lines.join('\n');
    expect(kept).not.toContain('reasoning one');
    expect(kept).not.toContain('reasoning two');
    expect(kept).toContain('  │  1 (○) Yes');
    expect(kept).toContain('  │  2 (•) No');
  });
});

describe('a clack step claims its own rows', () => {
  it('from the headline down to the bar end', () => {
    const drawn = ['◆  Choose a template', '│  ● Vue', '│  ○ React', '└'];
    expect(detectPrompt(drawn.join('\n'))!.rows).toEqual([0, 3]);
  });
});

describe('signatures with no reasoning rules', () => {
  it('does not run prompt detection, because it can hide nothing', () => {
    const spy = vi.spyOn(promptDetector, 'detectPrompt');
    const filtered = hideReasoning(
      ['Would you like to run these?', '  1. First step', '  2. Second step'].map((text) => plain(text)),
      builtIn('claude'),
    );
    expect(filtered?.hiddenLines).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
