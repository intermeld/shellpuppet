/**
 * Reading an agent CLI's screen without its reasoning (`reasoning.ts`).
 *
 * Every built-in signature is pinned here by fixtures captured from the real
 * program's screen. The captures were taken through a read-only viewer
 * credential and masked as they were written: each word of the program's
 * output that is not part of its own interface or of the prompt became x's,
 * with glyphs, spacing and every attribute kept, and then the digits and
 * operators of reasoning lines and of worked arithmetic, plan names and other
 * account details were masked too. The fixtures hold the shapes of the screen
 * and, of what the model wrote, only the single words the prompts asked it to
 * end with.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import type { StyledLine } from '../../src/core/renderer.js';
import {
  BUILT_IN_SIGNATURES,
  agentNames,
  compileSignatures,
  hiddenMarker,
  SET_ASIDE_MS,
  setAside,
  agentNameFor,
  hideReasoning,
  latestResult,
  programName,
  signatureFor,
  useAgentSignatures,
} from '../../src/core/reasoning.js';
import type { CompiledSignature } from '../../src/core/reasoning.js';
import { setDefaultRegexBudgetForTests } from '../../src/core/regexBudget.js';
import { REGEX_BUDGET_MS } from '../../src/core/types.js';
import { TEST_REGEX_BUDGET_MS } from '../regex-budget-setup.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'reasoning');

/**
 * Run `body` with the product's budget for a pattern rather than the suite's
 * (`test/regex-budget-setup.ts`). The tests that use it evaluate only a
 * runaway pattern, which no loaded machine makes finish in time, so nothing
 * they rely on can be set aside by a slow machine.
 */
function withProductBudget(body: () => void): void {
  setDefaultRegexBudgetForTests(REGEX_BUDGET_MS);
  try {
    body();
  } finally {
    setDefaultRegexBudgetForTests(TEST_REGEX_BUDGET_MS);
  }
}

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

afterEach(() => {
  useAgentSignatures([]);
});

describe('choosing a signature', () => {
  it('takes the program from the start command, whatever its folder and extension', () => {
    expect(programName('claude')).toBe('claude');
    expect(programName('C:\\Tools\\Claude.EXE')).toBe('claude');
    expect(programName('/usr/local/bin/codex')).toBe('codex');
    expect(programName('qodercli.cmd')).toBe('qodercli');
  });

  it('prefers the agent the session was started as over its start command', () => {
    expect(signatureFor(undefined, 'claude')?.name).toBe('claude');
    expect(signatureFor('claude', 'pwsh')?.name).toBe('claude');
    expect(signatureFor(undefined, 'pwsh')).toBeNull();
    expect(signatureFor('nobody', 'claude')).toBeNull();
  });

  it('lets config add a signature and replace a built-in one by name', () => {
    const problems = useAgentSignatures([
      { name: 'demo', programs: ['demo-cli'], composer: { text: '^> ' }, answer: { start: { text: '^A: ' } } },
      { name: 'claude', programs: ['claude-next'], composer: { text: '^❯' }, answer: { start: { text: '^● ' } } },
    ]);
    expect(problems).toEqual([]);
    expect(agentNames()).toContain('demo');
    expect(signatureFor(undefined, 'demo-cli')?.name).toBe('demo');
    expect(signatureFor(undefined, 'claude')).toBeNull();
    expect(signatureFor(undefined, 'claude-next')?.name).toBe('claude');
  });

  it('sets aside a config entry it cannot use, and says why', () => {
    const problems = useAgentSignatures([
      { name: 'Bad Name', composer: { text: 'x' }, answer: { start: { text: 'x' } } },
      { name: 'nocomposer', answer: { start: { text: 'x' } } },
      { name: 'badregex', composer: { text: '(' }, answer: { start: { text: 'x' } } },
      { name: 'badcolour', composer: { text: 'x', lead: { fg: ['red'] } }, answer: { start: { text: 'x' } } },
      { name: 'extra', composer: { text: 'x' }, answer: { start: { text: 'x' } }, colour: 'blue' },
    ]);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toContain('short lower-case name');
    expect(problems[1]).toContain('composer must be an object');
    expect(problems[2]).toMatch(/badregex.*composer\.text does not compile/);
    expect(problems[3]).toContain('"default", "p<n>" or "#rrggbb"');
    expect(problems[4]).toContain('unknown key colour');
    expect(agentNames()).not.toContain('extra');
  });
});

describe('the generic engine', () => {
  const plain = (text: string, style: Partial<StyledLine['spans'][number]> = {}): StyledLine => ({
    text,
    spans:
      text === ''
        ? []
        : [{ from: 0, to: text.length, bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null, ...style }],
  });
  const demo = compileSignatures([
    {
      name: 'demo',
      programs: ['demo'],
      composer: { text: '^> ' },
      busy: [{ text: 'esc to interrupt' }],
      turn: { text: '^You: ' },
      reasoning: [{ start: { text: '^Thinking', body: { italic: true } }, continues: { text: '^ {2}', body: { italic: true } } }],
      answer: { start: { text: '^• ' }, continues: { text: '^ {2}' } },
      trailer: { text: '^Worked for' },
    },
  ]).signatures[0]!;

  it('replaces each reasoning block with one marker line and keeps everything else', () => {
    const lines = [
      plain('You: question'),
      plain('Thinking about it', { italic: true }),
      plain('  more thought', { italic: true }),
      plain(''),
      plain('  still the same block', { italic: true }),
      plain('• the answer'),
      plain('> '),
    ];
    const filtered = hideReasoning(lines, demo);
    expect(filtered?.lines).toEqual(['You: question', hiddenMarker(4), '• the answer', '> ']);
    expect(filtered?.rows).toEqual([0, 1, 5, 6]);
    expect(filtered?.markers).toEqual([false, true, false, false]);
    expect(filtered?.hiddenLines).toBe(4);
    expect(filtered?.hiddenBlocks).toBe(1);
  });

  it('needs the style as well as the text: an upright "Thinking" line is kept', () => {
    const lines = [plain('Thinking is fine here'), plain('> ')];
    expect(hideReasoning(lines, demo)?.lines).toEqual(['Thinking is fine here', '> ']);
  });

  it('never hides the composer, and takes a line with reasoning under it for no composer', () => {
    // Reasoning is never drawn under the composer: a prompt-shaped line with
    // reasoning under it is an echo, so the whole screen is read.
    const lines = [plain('> '), plain('Thinking', { italic: true })];
    const filtered = hideReasoning(lines, demo)!;
    expect(filtered.hiddenBlocks).toBe(1);
    expect(filtered.lines[0]).toBe('> ');
    expect(latestResult(lines, demo)).toMatchObject({ found: false, reason: 'no-composer' });
    expect(hideReasoning([plain('Thinking', { italic: true }), plain('> ')], demo)?.lines).toEqual(['[reasoning hidden: 1 line]', '> ']);
  });

  it('returns the answer of the latest turn, its trailer and the status lines', () => {
    const lines = [
      plain('You: first'),
      plain('• old answer'),
      plain('You: second'),
      plain('Thinking', { italic: true }),
      plain('• new answer'),
      plain('  second line'),
      plain(''),
      plain('Worked for 3s'),
      plain('> '),
      plain('model x · 50% left'),
    ];
    expect(latestResult(lines, demo)).toEqual({
      found: true,
      answer: ['• new answer', '  second line'],
      trailer: ['Worked for 3s'],
      status: ['model x · 50% left'],
      prompt: 'You: second',
    });
  });

  it('refuses while the turn is running, and never offers an earlier answer', () => {
    const busy = [plain('You: q'), plain('• partial'), plain('Working (esc to interrupt)'), plain('> ')];
    expect(latestResult(busy, demo)).toMatchObject({ found: false, reason: 'busy' });
    const unanswered = [plain('You: first'), plain('• old answer'), plain('You: second'), plain('> ')];
    expect(latestResult(unanswered, demo)).toMatchObject({ found: false, reason: 'no-answer' });
    expect(latestResult([plain('no composer here')], demo)).toMatchObject({ found: false, reason: 'no-composer' });
  });

  it('never takes a line inside a reasoning block for the answer', () => {
    const lines = [plain('You: q'), plain('Thinking', { italic: true }), plain('  • looks like one', { italic: true }), plain('> ')];
    // The indented bullet is not at the start of the line, so it cannot start
    // an answer; and the block around it is reasoning either way.
    expect(latestResult(lines, demo)).toMatchObject({ found: false, reason: 'no-answer' });
  });

  it('never hides the rows a question on screen claims, whatever the signature says', () => {
    const hungry = compileSignatures([
      {
        name: 'hungry',
        composer: { text: '^> ' },
        // Reasoning that would run over anything below its first line: only
        // the claimed rows of a question stop it.
        reasoning: [{ start: { text: '^Thinking' }, continues: { text: '^\\S' } }],
        answer: { start: { text: '^• ' } },
      },
    ]).signatures[0]!;
    const lines = [
      plain('You: run the tests'),
      plain('Thinking'),
      plain('Allow this command to run?'),
      plain('  1 (○) Allow once'),
      plain('  2 (•) No'),
      plain('> '),
    ];
    const filtered = hideReasoning(lines, hungry);
    expect(filtered?.lines).toContain('Allow this command to run?');
    expect(filtered?.lines).toContain('  1 (○) Allow once');
    // The selected option as drawn, radio and all.
    expect(filtered?.lines).toContain('  2 (•) No');
    expect(filtered?.lines.join('\n')).not.toMatch(/^Thinking$/m);
  });

  it('sets a signature aside when its pattern runs past the time budget', () => {
    withProductBudget(() => {
      const slow = compileSignatures([
        { name: 'slow', composer: { text: '^(a+)+$' }, answer: { start: { text: 'x' } } },
      ]).signatures[0]!;
      const lines = [plain(`${'a'.repeat(40)}!`)];
      const startedAt = Date.now();
      expect(hideReasoning(lines, slow)).toBeNull();
      // Set aside within the product's budget: the suite's could not be this quick.
      expect(Date.now() - startedAt).toBeLessThan(TEST_REGEX_BUDGET_MS);
      expect(slow.overBudgetAt).not.toBeNull();
      expect(latestResult(lines, slow)).toMatchObject({ found: false, reason: 'over-budget' });
    });
  });
});

describe('Claude Code (built in)', () => {
  const claude = builtIn('claude');

  it('draws no reasoning text, so nothing is hidden, in either view', async () => {
    for (const name of ['claude-thinking', 'claude-tool-call-running', 'claude-answered', 'claude-transcript-view']) {
      const lines = await screen(name);
      const filtered = hideReasoning(lines, claude);
      expect(filtered?.hiddenBlocks, name).toBe(0);
      expect(filtered?.lines, name).toEqual(lines.map((line) => line.text));
    }
  });

  it('finds the answer of the latest turn, its summary and the status lines', async () => {
    const result = latestResult(await screen('claude-answered'), claude);
    expect(result).toMatchObject({ found: true, answer: ['● PINEAPPLE'] });
    if (!result.found) return;
    expect(result.trailer).toHaveLength(1);
    expect(result.trailer[0]).toMatch(/^✻ Worked for/);
    expect(result.status.join('\n')).toContain('auto mode on');
    expect(result.status.join('\n')).not.toMatch(/^─/m);
  });

  it('refuses while the model is thinking or a tool call is running', async () => {
    for (const name of ['claude-thinking', 'claude-tool-call-running']) {
      expect(latestResult(await screen(name), claude), name).toMatchObject({ found: false, reason: 'busy' });
    }
  });

  it('does not take a tool call for the answer', async () => {
    // A tool call's bullet is grey or green, the answer's is the text colour.
    const lines = (await screen('claude-tool-call-running')).filter((line) => !/…/.test(line.text));
    expect(latestResult(lines, claude)).toMatchObject({ found: false, reason: 'no-answer' });
  });

  it('refuses a prompt typed but not yet sent, and the transcript view, which has no composer', async () => {
    expect(latestResult(await screen('claude-prompt-typed'), claude)).toMatchObject({ found: false });
    // The transcript view draws the person's prompt where the composer would
    // be; whichever line is taken for it, nothing is offered as the answer.
    expect(latestResult(await screen('claude-transcript-view'), claude)).toMatchObject({ found: false });
  });
});

describe('Qoder (built in)', () => {
  const qoder = builtIn('qoder');

  it('hides every Thinking block, heading and bar, and keeps messages, tool calls and the composer', async () => {
    const lines = await screen('qoder-answered-after-reasoning');
    const filtered = hideReasoning(lines, qoder);
    expect(filtered).not.toBeNull();
    if (filtered === null) return;
    expect(filtered.hiddenBlocks).toBe(4);
    // No reasoning line survives: neither the heading nor the italic bar.
    const kept = filtered.lines.join('\n');
    expect(kept).not.toMatch(/^ Thinking\s*$/m);
    expect(kept).not.toMatch(/^ │ /m);
    expect(kept).toMatch(/^ ▪ MANGO$/m);
    expect(kept).toMatch(/^ ▪ PINEAPPLE$/m);
    expect(kept).toMatch(/^ ▪ Bash\(/m);
    expect(kept).toContain('Type your message');
    // Every line kept is the line it was, at the row it was.
    filtered.lines.forEach((text, k) => {
      if (!filtered.markers[k]) expect(text).toBe(lines[filtered.rows[k]!]!.text);
    });
  });

  it('hides a Thinking block while the model is still writing it', async () => {
    const filtered = hideReasoning(await screen('qoder-thinking-second-turn'), qoder);
    expect(filtered?.lines.join('\n')).not.toMatch(/^ │ /m);
  });

  it('still hides a reasoning bar whose heading has scrolled above what is returned', async () => {
    const lines = await screen('qoder-answered-after-reasoning');
    const bar = lines.findIndex((line) => /^ │ /.test(line.text));
    // Return from the second line of the first block: its heading is context only.
    const filtered = hideReasoning(lines, qoder, bar + 1);
    expect(filtered?.lines[0]).toMatch(/^\[reasoning hidden: \d+ lines?\]$/);
    expect(filtered?.lines.join('\n')).not.toMatch(/^ │ /m);
  });

  it('returns the answer of the latest turn, never the earlier one or a reasoning line', async () => {
    expect(latestResult(await screen('qoder-answered-after-reasoning'), qoder)).toMatchObject({
      found: true,
      answer: [' ▪ MANGO'],
    });
    expect(latestResult(await screen('qoder-answered-first-turn'), qoder)).toMatchObject({
      found: true,
      answer: [' ▪ PINEAPPLE'],
    });
  });

  it('refuses while the spinner says esc to cancel', async () => {
    for (const name of ['qoder-working', 'qoder-thinking-second-turn']) {
      expect(latestResult(await screen(name), qoder), name).toMatchObject({ found: false, reason: 'busy' });
    }
  });

  it('gives the model line under the composer as status', async () => {
    const result = latestResult(await screen('qoder-answered-after-reasoning'), qoder);
    expect(result.status.join('\n')).toMatch(/GLM-5\.3/);
  });
});

describe('Codex (built in)', () => {
  const codex = builtIn('codex');

  it('returns the answer, not a tool group or command, with its Worked for line', async () => {
    const result = latestResult(await screen('codex-answered'), codex);
    expect(result).toMatchObject({ found: true, answer: ['• PINEAPPLE'] });
    if (!result.found) return;
    expect(result.trailer[0]).toMatch(/^ {2}Worked for /);
    expect(result.status.join('\n')).toContain('Context');
  });

  it('returns the latest turn answer on a second turn', async () => {
    expect(latestResult(await screen('codex-answered-second-turn'), codex)).toMatchObject({
      found: true,
      answer: ['• MANGO'],
    });
  });

  it('refuses while Working says esc to interrupt, and before the prompt is sent', async () => {
    for (const name of ['codex-command-running', 'codex-working']) {
      expect(latestResult(await screen(name), codex), name).toMatchObject({ found: false, reason: 'busy' });
    }
    expect(latestResult(await screen('codex-prompt-typed'), codex)).toMatchObject({ found: false });
  });

  it('does not take a tool group for the answer', async () => {
    // The command is still running, so drop the Working line and look again:
    // the "Ran" and "Explored" bullets above it are not answers.
    const lines = (await screen('codex-command-running')).filter((line) => !/esc to interrupt/.test(line.text));
    expect(latestResult(lines, codex)).toMatchObject({ found: false, reason: 'no-answer' });
  });
});

describe('Codex commentary before tool calls (built in)', () => {
  const codex = builtIn('codex');

  it('returns the final answer, not the commentary message that opened the turn', async () => {
    const result = latestResult(await screen('codex-answered-after-commentary-and-tools'), codex);
    expect(result).toMatchObject({ found: true, answer: ['• PAPAYA'] });
  });

  it('refuses while the turn runs, though a commentary message is already on screen', async () => {
    expect(latestResult(await screen('codex-working-after-commentary'), codex)).toMatchObject({
      found: false,
      reason: 'busy',
    });
  });
});

describe('OpenCode (built in)', () => {
  const opencode = builtIn('opencode');

  it('draws no reasoning text, so nothing is hidden', async () => {
    for (const name of ['opencode-thinking', 'opencode-answered', 'opencode-answer-streaming', 'opencode-answered-two-paragraphs']) {
      const lines = await screen(name);
      expect(hideReasoning(lines, opencode)?.hiddenBlocks, name).toBe(0);
    }
  });

  it('returns every paragraph of the answer above its footer, and the footer as the trailer', async () => {
    const result = latestResult(await screen('opencode-answered-two-paragraphs'), opencode);
    expect(result.found).toBe(true);
    if (!result.found) return;
    const paragraphs = result.answer.join('\n').split(/\n\s*\n/);
    expect(paragraphs).toHaveLength(2);
    expect(result.answer[result.answer.length - 1]).toMatch(/KIWI/);
    // Not the collapsed thought, not the tool line, not the prompt.
    expect(result.answer.join('\n')).not.toMatch(/Thought|→|┃/);
    expect(result.trailer).toHaveLength(1);
    expect(result.trailer[0]).toMatch(/^ {5}Build · GLM-5\.3 · /);
  });

  it('returns a one-paragraph answer whole', async () => {
    const result = latestResult(await screen('opencode-answered'), opencode);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.answer[result.answer.length - 1]).toMatch(/^ {5}MANGO$/);
  });

  it('refuses while thinking, while a tool runs and while the answer streams', async () => {
    for (const name of ['opencode-thinking', 'opencode-thinking-after-tool', 'opencode-answer-streaming']) {
      expect(latestResult(await screen(name), opencode), name).toMatchObject({ found: false, reason: 'busy' });
    }
  });
});

describe('Grok (built in)', () => {
  const grok = builtIn('grok');

  it('hides the live Thinking block behind its bar, and keeps the rest', async () => {
    for (const name of ['grok-thinking', 'grok-thinking-second-turn', 'grok-thinking-after-tool']) {
      const filtered = hideReasoning(await screen(name), grok);
      expect(filtered?.hiddenBlocks, name).toBeGreaterThanOrEqual(1);
      const kept = filtered?.lines.join('\n') ?? '';
      // Every bar line went; the composer's own "│ >" row stays.
      expect(kept, name).not.toMatch(/^ {2}│(?! >)/m);
      expect(kept, name).toMatch(/^ {2}│ >/m);
    }
  });

  it('keeps the collapsed "Thought for" line, which holds no reasoning', async () => {
    const filtered = hideReasoning(await screen('grok-answered'), grok);
    expect(filtered?.hiddenBlocks).toBe(0);
    expect(filtered?.lines.join('\n')).toMatch(/♦ Thought for /);
  });

  it('returns the answer above Worked for, not the message before the tool work', async () => {
    const first = latestResult(await screen('grok-answered'), grok);
    expect(first).toMatchObject({ found: true, answer: ['     MANGO'] });
    const second = latestResult(await screen('grok-answered-after-tool'), grok);
    expect(second.found).toBe(true);
    if (!second.found) return;
    expect(second.answer).toHaveLength(1);
    expect(second.answer[0]).not.toMatch(/♦|primes\.py/);
    expect(second.trailer[0]).toMatch(/^ {5}Worked for /);
  });

  it('refuses while the spinner runs or a Thinking block is open', async () => {
    for (const name of ['grok-thinking', 'grok-thinking-second-turn', 'grok-thinking-after-tool']) {
      expect(latestResult(await screen(name), grok), name).toMatchObject({ found: false, reason: 'busy' });
    }
  });
});

describe('Grok permission box (built in)', () => {
  const grok = builtIn('grok');
  // A permission box drawn behind the same bar as the reasoning, as Grok
  // draws it: the question it asks, and the same box with the command's rows
  // inside it. Content invented; shapes and spacing as captured.
  const QUESTION_ALLOW = '  │  >  Allow Run the unit tests?';
  const QUESTION_RESTORE = '  │  >  Restore the saved file and compare digests';
  const COMMAND_ROWS = [
    "  │  │ Copy-Item -LiteralPath 'C:\\work\\demo\\saved\\a.ts' -Destination·",
    "  │  : 'C:\\work\\demo\\src\\a.ts' -Force",
    "  │  │ Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\\work\\demo\\src\\a.ts'",
  ] as const;
  // The selected option is the second: its radio is the filled one.
  const OPTIONS = [
    "  │  1 (○) Yes, and don't ask again for anything (always-approve mode)",
    '  │  2 (•) Yes, proceed',
    '  │  3 (○) No, reject (type to add feedback)',
  ] as const;

  it('hides the reasoning behind the bar and not the box: the question, its command and every option stay', async () => {
    for (const [name, question, commandRows] of [
      ['grok-permission-box', QUESTION_ALLOW, []],
      ['grok-permission-box-command', QUESTION_RESTORE, COMMAND_ROWS],
    ] as const) {
      const lines = await screen(name);
      const filtered = hideReasoning(lines, grok);
      expect(filtered, name).not.toBeNull();
      if (filtered === null) continue;
      const kept = filtered.lines;
      expect(kept, name).toContain(question);
      for (const row of commandRows) expect(kept, name).toContain(row);
      // All three options, the selected one drawn with its filled radio.
      for (const option of OPTIONS) expect(kept, name).toContain(option);
      expect(kept.join('\n'), name).toMatch(/^ {2}1\/3:select/m);
      // The real reasoning still goes, and something went.
      expect(kept.join('\n'), name).not.toMatch(/♦ Thinking/);
      expect(kept.join('\n'), name).not.toContain('X xxxx xxxxxxxx');
      expect(filtered.markers, name).toContain(true);
      // A dialog stands in the composer's place, so no result is read.
      expect(latestResult(lines, grok).found, name).toBe(false);
    }
  });

  it('stops the bar at a box row even when no option rows are on screen to claim it', () => {
    const plain = (text: string): StyledLine => ({
      text,
      spans: text === '' ? [] : [{ from: 0, to: text.length, bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null }],
    });
    // A box whose options sit below the viewport: nothing here for the
    // prompt detection to claim, so the signature's own rules must stop.
    const lines = [
      plain('     > run the tests'),
      plain('  │  ♦ Thinking…'),
      plain('  │'),
      plain('  │  X xxxx xxxxxxxx 99 by 99 and xxxxx which of the xxxxx.'),
      plain('  │  >  Allow Run the unit tests?'),
      plain('  1/3:select  │  Tab:next option  │  Ctrl+o:always-approve'),
    ];
    const kept = hideReasoning(lines, grok)!.lines;
    expect(kept).toContain('  │  >  Allow Run the unit tests?');
    expect(kept.join('\n')).not.toMatch(/♦ Thinking/);
    expect(kept.join('\n')).not.toContain('X xxxx');
  });
});

describe('MiMo Code (built in)', () => {
  const mimo = builtIn('mimo');

  it('draws no reasoning text, so nothing is hidden', async () => {
    for (const name of ['mimo-working', 'mimo-answered', 'mimo-answered-two-paragraphs']) {
      expect(hideReasoning(await screen(name), mimo)?.hiddenBlocks, name).toBe(0);
    }
  });

  it('returns every paragraph of the latest answer, with its footer and without the side panel', async () => {
    const result = latestResult(await screen('mimo-answered-two-paragraphs'), mimo);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.answer.join('\n').split(/\n\s*\n/)).toHaveLength(2);
    expect(result.answer[result.answer.length - 1]).toMatch(/KIWI$/);
    expect(result.answer.join('\n')).not.toMatch(/PINEAPPLE|Thought|┃|█/);
    expect(result.trailer[0]).toMatch(/^ {5}▣ {2}Build · MiMo-V2\.6-Pro · \d/);
    expect(result.trailer[0]).not.toMatch(/[⎘█]/);
  });

  it('returns a one-line answer, and never the composer suggestion', async () => {
    const result = latestResult(await screen('mimo-answered'), mimo);
    expect(result).toMatchObject({ found: true, answer: ['     PINEAPPLE'] });
  });

  it('refuses while the footer carries no time yet', async () => {
    for (const name of ['mimo-working', 'mimo-working-second-turn']) {
      expect(latestResult(await screen(name), mimo), name).toMatchObject({ found: false, reason: 'busy' });
    }
  });
});

describe('Antigravity (built in)', () => {
  const agy = builtIn('agy');

  it('hides the "Thought for" summary line and the spinner label, and keeps tool calls', async () => {
    const filtered = hideReasoning(await screen('agy-working-after-summary'), agy);
    const kept = filtered?.lines.join('\n') ?? '';
    expect(kept).not.toMatch(/^○ Thought for /m);
    expect(kept).not.toMatch(/^[⠀-⣿] {2}\S/mu);
    expect(kept).toMatch(/^● /m);
    expect(filtered?.hiddenBlocks).toBe(2);
  });

  it('hides the summary on the resting screen too, and returns only the answer', async () => {
    const lines = await screen('agy-answered');
    const filtered = hideReasoning(lines, agy);
    expect(filtered?.lines.join('\n')).not.toMatch(/^○ Thought for /m);
    expect(filtered?.lines.join('\n')).toMatch(/^▸ Thought for /m);
    const result = latestResult(lines, agy);
    expect(result).toMatchObject({ found: true, answer: ['  PAPAYA'] });
    expect(result.status.join('\n')).toContain('? for shortcuts');
  });

  it('refuses while the spinner turns', async () => {
    for (const name of ['agy-thinking', 'agy-working-after-summary']) {
      expect(latestResult(await screen(name), agy), name).toMatchObject({ found: false, reason: 'busy' });
    }
  });
});

describe('review round: what a result must never offer', () => {
  const plain = (text: string, style: Partial<StyledLine['spans'][number]> = {}): StyledLine => ({
    text,
    spans:
      text === ''
        ? []
        : [{ from: 0, to: text.length, bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null, ...style }],
  });
  const loose = compileSignatures([
    {
      name: 'loose',
      composer: { text: '^> ' },
      turn: { text: '^You: ' },
      // A reasoning block that takes any line, and an answer that would run on
      // into anything: only the engine's own guards keep them apart.
      reasoning: [{ start: { text: '^Thinking' }, continues: { text: '^\\S' } }],
      answer: { start: { text: '^• ' }, continues: { text: '^\\S' } },
    },
  ]).signatures[0]!;

  it('never takes a line inside a reasoning block for the answer, even one shaped like it', () => {
    const lines = [plain('You: q'), plain('Thinking'), plain('• looks like an answer'), plain('> ')];
    expect(latestResult(lines, loose)).toMatchObject({ found: false, reason: 'no-answer' });
  });

  it('stops an answer where a reasoning block begins', () => {
    const lines = [plain('You: q'), plain('• the answer'), plain('Thinking'), plain('more'), plain('> ')];
    expect(latestResult(lines, loose)).toMatchObject({ found: true, answer: ['• the answer'] });
  });

  it('refuses a prompt typed and not sent, rather than offer the turn before it', async () => {
    for (const [agent, name] of [
      ['qoder', 'qoder-prompt-typed'],
      ['claude', 'claude-prompt-typed'],
      ['codex', 'codex-prompt-typed'],
    ] as const) {
      expect(latestResult(await screen(name), builtIn(agent)), name).toMatchObject({ found: false, reason: 'prompt-typed' });
    }
  });

  it('refuses a Codex turn that ended without its closing line, rather than offer its commentary', async () => {
    // The commentary screen with the Working line gone: an interrupted turn.
    const lines = (await screen('codex-working-after-commentary')).filter((line) => !/esc to interrupt/.test(line.text));
    expect(latestResult(lines, builtIn('codex'))).toMatchObject({ found: false, reason: 'unfinished' });
  });

  it('names the prompt an answer follows', async () => {
    const result = latestResult(await screen('qoder-answered-after-reasoning'), builtIn('qoder'));
    expect(result.found && result.prompt).toMatch(/^ > .*MANGO/);
  });

  it('hides a Qoder bar line drawn upright, as a code span inside the reasoning is', async () => {
    const lines = await screen('qoder-answered-after-reasoning');
    const upright = lines.map((line) =>
      /^ │ /.test(line.text) ? { ...line, spans: line.spans.map((span) => ({ ...span, italic: false })) } : line,
    );
    const kept = hideReasoning(upright, builtIn('qoder'))?.lines.join('\n') ?? '';
    expect(kept).not.toMatch(/^ │ /m);
  });

  it('sets a signature that ran past its budget aside for a while, not for good', () => {
    withProductBudget(() => {
      const slow = compileSignatures([{ name: 'slowish', composer: { text: '^(a+)+$' }, answer: { start: { text: 'x' } } }]).signatures[0]!;
      const startedAt = Date.now();
      hideReasoning([plain(`${'a'.repeat(40)}!`)], slow);
      expect(Date.now() - startedAt).toBeLessThan(TEST_REGEX_BUDGET_MS);
      expect(slow.overBudgetAt).not.toBeNull();
      expect(setAside(slow)).toBe(true);
      expect(setAside(slow, (slow.overBudgetAt ?? 0) + SET_ASIDE_MS + 1)).toBe(false);
    });
  });

  it('refuses requireTrailer without a trailer to require', () => {
    const { problems } = compileSignatures([
      { name: 'bad', composer: { text: '^> ' }, answer: { start: { text: 'x' } }, requireTrailer: true },
    ]);
    expect(problems[0]).toContain('requireTrailer needs a trailer');
  });
});

describe('the agent a session runs as, as a client sees it', () => {
  const MINE = { name: 'mycli', programs: ['MyCli'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };

  it('takes the agent named at start over the command', () => {
    expect(agentNameFor('qoder', 'pwsh')).toBe('qoder');
  });

  it('recognises a built-in agent by its command, with a path and an extension', () => {
    expect(agentNameFor(undefined, 'qodercli')).toBe('qoder');
    expect(agentNameFor(undefined, 'C:\\tools\\codex.cmd')).toBe('codex');
    expect(agentNameFor(undefined, '/usr/local/bin/opencode')).toBe('opencode');
  });

  it('recognises an agent the config adds, by its command', () => {
    expect(agentNameFor(undefined, 'mycli.exe', [MINE])).toBe('mycli');
  });

  it('reads a config signature with no programs without failing, and names no agent for an unclaimed command', () => {
    const noPrograms = { name: 'quiet', composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };
    expect(agentNameFor(undefined, 'pwsh', [noPrograms])).toBeNull();
    expect(agentNameFor(undefined, 'qodercli', [noPrograms])).toBe('qoder');
  });

  it('orders the signatures as the daemon does: a replaced built-in loses its place, the config\'s come after', () => {
    // A config entry replacing claude that claims codex's command: the daemon
    // keeps the built-in codex first, so codex it is.
    const claudeAsCodex = { name: 'claude', programs: ['codex'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };
    expect(agentNameFor(undefined, 'codex', [claudeAsCodex])).toBe('codex');
    // Two config entries for one command, the first a new name: the first wins.
    const glm = { name: 'claude-glm', programs: ['claude'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };
    const claude = { name: 'claude', programs: ['claude'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };
    expect(agentNameFor(undefined, 'claude', [glm, claude])).toBe('claude-glm');
    // Two config entries with one name: the daemon keeps both, in order.
    const alpha = { name: 'mycli', programs: ['alpha'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };
    const beta = { name: 'mycli', programs: ['beta'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };
    expect(agentNameFor(undefined, 'alpha', [alpha, beta])).toBe('mycli');
    expect(agentNameFor(undefined, 'beta', [alpha, beta])).toBe('mycli');
  });

  it('names no agent for a command no signature claims', () => {
    expect(agentNameFor(undefined, 'pwsh')).toBeNull();
    expect(agentNameFor(undefined, 'node', [MINE])).toBeNull();
  });
});

describe('a screen whose composer is not drawn: a permission dialog in its place', () => {
  const plain = (text: string): StyledLine => ({
    text,
    spans: text === '' ? [] : [{ from: 0, to: text.length, bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null }],
  });
  // Neutral words in the shapes of Qoder's and Antigravity's permission questions.
  const QODER_DIALOG = ['', ' ? Bash(ls)', '', ' Permission Required', '─'.repeat(76), ' Tool: Bash', '', ' Command: ls', '', ' Allow this command to run?', '', '  ❯ 1. Allow once', '    2. Always allow', '    3. No'];
  const AGY_DIALOG = ['', 'Run this command?', '', '❯ 1. Yes', '  2. No'];

  /** The screen with the composer, the chrome over it and everything under it replaced by a dialog. */
  function withDialog(lines: StyledLine[], sig: CompiledSignature, dialog: string[]): StyledLine[] {
    let top = lines.length - 1;
    while (top >= 0 && sig.composer.text?.test(lines[top]!.text) !== true) top--;
    expect(top).toBeGreaterThan(0);
    while (top > 0) {
      const above = lines[top - 1]!;
      if (above.text.trim() !== '' && !sig.chrome.some((test) => test.text?.test(above.text) === true)) break;
      top--;
    }
    return [...lines.slice(0, top), ...dialog.map(plain)];
  }

  it('hides the latest turn\'s Qoder reasoning, not only what is above the person\'s prompt', async () => {
    for (const name of ['qoder-answered-first-turn', 'qoder-answered-after-reasoning']) {
      const lines = withDialog(await screen(name), builtIn('qoder'), QODER_DIALOG);
      expect(lines.some((line) => /^ │ /.test(line.text)), name).toBe(true);
      const kept = hideReasoning(lines, builtIn('qoder'))!.lines;
      expect(kept.filter((line) => /^ │ /.test(line)), name).toEqual([]);
      expect(kept, name).toContain(' Allow this command to run?');
      expect(latestResult(lines, builtIn('qoder')).found, name).toBe(false);
    }
  });

  it('hides the latest turn\'s Antigravity summary line the same way', async () => {
    for (const name of ['agy-answered', 'agy-working-after-summary']) {
      const lines = withDialog(await screen(name), builtIn('agy'), AGY_DIALOG);
      expect(lines.some((line) => /^○ Thought for /.test(line.text)), name).toBe(true);
      const kept = hideReasoning(lines, builtIn('agy'))!.lines;
      expect(kept.filter((line) => /^○ Thought for /.test(line)), name).toEqual([]);
      expect(kept, name).toContain('Run this command?');
    }
  });
});

describe('an overrun reported to the daemon', () => {
  const line = (text: string): StyledLine => ({
    text,
    spans: [{ from: 0, to: text.length, bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null }],
  });

  it('says whether the signature is built in, which nobody can change, or from config', () => {
    const reported: [string, boolean][] = [];
    useAgentSignatures(
      [{ name: 'slow', programs: ['slow-cli'], composer: { text: '^(a+)+$' }, answer: { start: { text: 'x' } } }],
      (name, builtIn) => void reported.push([name, builtIn]),
    );
    const slow = signatureFor('slow', 'slow-cli');
    const claude = signatureFor('claude', 'claude');
    if (slow === null || claude === null) throw new Error('both signatures are in use');

    withProductBudget(() => {
      expect(hideReasoning([line(`${'a'.repeat(40)}!`)], slow)).toBeNull();
    });
    // An ordinary pattern overruns a budget too short for the screen it reads,
    // as it can when a loaded machine deschedules the daemon mid-search.
    setDefaultRegexBudgetForTests(1);
    try {
      expect(hideReasoning(Array<StyledLine>(200_000).fill(line('filler')), claude)).toBeNull();
    } finally {
      setDefaultRegexBudgetForTests(TEST_REGEX_BUDGET_MS);
    }
    expect(reported).toEqual([
      ['slow', false],
      ['claude', true],
    ]);
  });
});
