import { describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { BUILT_IN_SIGNATURES, compileSignatures, hideReasoning } from '../../src/core/reasoning.js';
import { readingRules as grokReadingRules } from '../../src/agents/grok/readingRules.js';

const grok = compileSignatures(BUILT_IN_SIGNATURES, 'built-in').signatures.find((entry) => entry.name === 'grok')!;
const header = '   ♦ Run filtered tests… 1m56s 36m13s ↓172k [↓][stop]';
const choices = [
  '  │  1 (○) Yes, and don\'t ask again for anything (always-approve mode)',
  '  │  2 (•) Yes, proceed',
  '  │  3 (○) No, reject (type to add feedback)',
  '  │',
  '  1/3:select  │  Tab:next option  │  Ctrl+f:expand',
];

async function rendered(rows: string[], cols: number, height: number) {
  const renderer = new ScreenRenderer({ cols, rows: height });
  await renderer.write(rows.join('\r\n'));
  const lines = renderer.styledLines({ last: 2000 }).lines;
  await renderer.dispose();
  return lines;
}

describe('Grok permission box rows after the question scrolls away', () => {
  const commands = [
    [
      "  │  │ $env:TEMP='D:\\Neutral\\a-long-branch-name-for-the-rung",
      "  │  : -links\\scratch\\tmp';·",
      "  │  : $env:TMP='D:\\Neutral\\a-long-branch-name-for-the-rung-",
      "  │  : links\\scratch\\tmp';·",
      '  │  │ dotnet test Example.Tests.csproj --filter FullyQualifiedName~SomeTests -c Debug',
      '  │  │ dotnet test Example.Tests.csproj --filter FullyQualifiedName~SomeTests -c Release',
    ],
    [
      '  │  │ $env:TEMP="D:\\Neutral\\scratch";·',
      '  │  : $env:TMP="D:\\Neutral\\scratch";·',
      '  │  │ Write-Output dotnet test Example.Tests.csproj `',
      '  │  │     --configuration Debug --no-build `',
      '  │  │     --filter FullyQualifiedName~SomeTests',
    ],
    [
      "  │  │ $env:TEMP='D:\\Neutral\\scratch';·",
      "  │  : $env:TMP='D:\\Neutral\\scratch';·",
      "  │  $env:THIRD='D:\\Neutral\\scratch';·",
      '  │  dotnet test Example.Tests.csproj --filter FullyQualifiedName~SomeTests -c Debug',
      '  │  dotnet test Example.Tests.csproj --filter FullyQualifiedName~SomeTests -c Release',
    ],
  ];

  for (const [shape, command] of commands.entries()) {
    for (const [cols, height] of [[80, 24], [120, 40], [170, 60]]) {
      for (const hint of ['  │  ... Ctrl-F to expand', '  │  … more rows than fit']) {
        it(`keeps every box row for command ${shape + 1} at ${cols}x${height} with ${hint.trim()}`, async () => {
          const lines = await rendered([header, ...command, hint, ...choices], cols!, height!);
          const filtered = hideReasoning(lines, grok)!;
          const action = lines.findIndex((line) => line.text.includes('♦ Run filtered tests'));
          const keybar = lines.findIndex((line) => line.text.includes('1/3:select'));
          expect(action).toBeGreaterThanOrEqual(0);
          expect(keybar).toBeGreaterThan(action);
          for (let row = action + 1; row <= keybar; row++) {
            expect(filtered.rows[filtered.rows.indexOf(row)], `row ${row}: ${lines[row]!.text}`).toBe(row);
            expect(filtered.markers[filtered.rows.indexOf(row)]).toBe(false);
          }
          expect(filtered.hiddenLines).toBe(0);
        });
      }
    }
  }

  it('still hides bare-bar reasoning without a live box', async () => {
    const lines = await rendered(['  │  ♦ Thinking…', '  │  plan the next step', '  │  more detail', '  │', '     The answer is ready'], 80, 24);
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('plan the next step');
    expect(kept).not.toContain('more detail');
    expect(kept).toContain('The answer is ready');
  });

  it('keeps the command when the action header has also scrolled away', async () => {
    const lines = await rendered([...commands[0]!, '  │  … more rows than fit', ...choices], 80, 24);
    const filtered = hideReasoning(lines, grok)!;
    expect(filtered.hiddenLines).toBe(0);
    for (let row = 0; row < lines.length; row++) {
      expect(filtered.rows[row]).toBe(row);
      expect(filtered.markers[row]).toBe(false);
    }
  });

  it('hides bare bar text without the live permission footer', async () => {
    const lines = await rendered(['  │  plan the next step', '  │  more detail', '  │', '     The answer is ready'], 80, 24);
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('plan the next step');
    expect(kept).not.toContain('more detail');
    expect(kept).toContain('The answer is ready');
  });
});

describe('the live Grok box does not claim transcript reasoning', () => {
  it('hides a thinking block between the action header and the visible question', async () => {
    const lines = await rendered([
      header,
      '  │  ♦ Thinking…',
      '  │  private plan before asking',
      '  │',
      '  │  >  Run the sample tests',
      "  │  │ $env:TEMP='D:\\Neutral\\scratch';·",
      ...choices,
    ], 120, 40);
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('Thinking');
    expect(kept).not.toContain('private plan before asking');
    expect(kept).toContain('Run the sample tests');
    expect(kept).toContain('$env:TEMP');
  });

  it('hides a bare-bar reasoning block between the action header and question', async () => {
    const lines = await rendered([
      header,
      '  │  private plan before asking',
      '  │  another private detail',
      '  │',
      '  │  >  Run the sample tests',
      "  │  │ $env:TEMP='D:\\Neutral\\scratch';·",
      ...choices,
    ], 120, 40);
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('private plan before asking');
    expect(kept).not.toContain('another private detail');
    expect(kept).toContain('Run the sample tests');
  });

  for (const [cols, height] of [[80, 24], [120, 40], [170, 60]]) {
    it(`hides reasoning that reads "> " before the separated live question at ${cols}x${height}`, async () => {
      const lines = await rendered([
        header,
        '  │  ♦ Thinking…',
        '  │  > a quoted line inside the reasoning',
        '  │  private continuation after the quote',
        '  │',
        '  │  >  Run the sample tests',
        "  │  │ $env:TEMP='D:\\Neutral\\scratch';·",
        ...choices,
      ], cols!, height!);
      // The question-shaped row itself is never reasoning in Grok's signature;
      // what follows it must stay hidden.
      const kept = hideReasoning(lines, grok)!.lines.join('\n');
      expect(kept).not.toContain('Thinking');
      expect(kept).not.toContain('private continuation after the quote');
      expect(kept).toContain('Run the sample tests');
      expect(kept).toContain('$env:TEMP');
    });

    it(`claims nothing while several question-shaped rows lack a separator at ${cols}x${height}`, async () => {
      const lines = await rendered([
        '  │  > a quoted line inside the reasoning',
        '  │  private continuation after the quote',
        '  │  >  Run the sample tests',
        '  │  plain command row',
        ...choices,
      ], cols!, height!);
      const kept = hideReasoning(lines, grok)!.lines.join('\n');
      expect(kept).not.toContain('private continuation after the quote');
      expect(kept).toContain('Yes, proceed');
    });
  }

  // A redraw can paint the question before its separating bar.
  const redrawReasoning = {
    'a thinking block': ['  │  ♦ Thinking…', '  │  private plan before asking', '  │  another private detail'],
    'a summarised thinking block': ['  │  ♦ Thought for 5s', '  │  private plan before asking', '  │  another private detail'],
    'bare-bar reasoning': ['  │  private plan before asking', '  │  another private detail'],
  };
  for (const [kind, reasoning] of Object.entries(redrawReasoning)) {
    for (const withHeader of [true, false]) {
      for (const [cols, height] of [[80, 24], [120, 40], [170, 60]]) {
        it(`hides ${kind} above a question painted before its separator at ${cols}x${height}${withHeader ? ' under an action' : ''}`, async () => {
          const lines = await rendered([
            ...(withHeader ? [header] : []),
            ...reasoning,
            '  │  >  Run the sample tests',
            "  │  │ $env:TEMP='D:\\Neutral\\scratch';·",
            '  │  dotnet test Example.Tests.csproj -c Debug',
            ...choices,
          ], cols!, height!);
          const kept = hideReasoning(lines, grok)!.lines.join('\n');
          expect(kept).not.toContain('private plan before asking');
          expect(kept).not.toContain('another private detail');
          expect(kept).toContain('Run the sample tests');
          expect(kept).toContain('$env:TEMP');
          expect(kept).toContain('dotnet test Example.Tests.csproj -c Debug');
        });
      }
    }
  }

  it('hides command rows above literal "> " command text once the question has scrolled away', async () => {
    // A `> ` row is the question's shape. With the real question gone, plain
    // bar rows above it may be reasoning, so they are hidden: the safe
    // failure, and the approver sees the hidden marker. Rows that carry the
    // box's own command marker are never reasoning and stay.
    const lines = await rendered([
      header,
      '  │  │ Write-Output dotnet test Example.Tests.csproj `',
      '  │  plain continuation --configuration Debug --no-build',
      '  │  > literal PowerShell redirection text',
      ...choices,
    ], 120, 40);
    const filtered = hideReasoning(lines, grok)!;
    const kept = filtered.lines.join('\n');
    expect(kept).toContain('Write-Output dotnet test Example.Tests.csproj');
    expect(kept).not.toContain('plain continuation --configuration Debug --no-build');
    expect(filtered.hiddenLines).toBeGreaterThan(0);
    expect(kept).toContain('literal PowerShell redirection text');
    expect(kept).toContain('Yes, proceed');
  });

  it('hides command text shaped as a thinking start when no question follows it', async () => {
    // Indistinguishable from reasoning once the question has scrolled away:
    // hiding it is the safe failure, and the approver sees the hidden marker.
    const lines = await rendered([
      header,
      '  │  │ Write-Output sample',
      '  │  ♦ Thinking is literal command output',
      '  │  more command text',
      ...choices,
    ], 120, 40);
    const filtered = hideReasoning(lines, grok)!;
    const kept = filtered.lines.join('\n');
    expect(kept).not.toContain('Thinking is literal command output');
    expect(kept).not.toContain('more command text');
    expect(filtered.hiddenLines).toBeGreaterThan(0);
    expect(kept).toContain('Yes, proceed');
  });

  it('does not widen a box claim from a footer left above the composer', async () => {
    const lines = await rendered([
      header,
      '  │  private transcript reasoning',
      ...choices,
      '  │  later transcript text',
      '  │ >',
    ], 120, 40);
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('private transcript reasoning');
  });

  it('claims only the latest box when an answered box remains above it', async () => {
    const lines = await rendered([
      '   ♦ Earlier action…',
      '  │  old command must hide',
      ...choices,
      '     Earlier answer',
      header,
      '  │  │ Write-Output sample',
      '  │  new command must stay',
      ...choices,
    ], 120, 40);
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('old command must hide');
    expect(kept).toContain('new command must stay');
  });

  it('claims nothing for a box whose command carries no marker', async () => {
    const lines = await rendered([header, '  │  private plan before asking', ...choices], 120, 40);
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('private plan before asking');
  });
});

describe('a visible question-shaped row leaves the Grok box claim to the ordinary rules', () => {
  const frames: Record<string, string[]> = {
    'a question painted before its separator': [
      header, '  │  ♦ Thinking…', '  │  private plan', '  │  >  Run the sample tests',
      "  │  │ $env:TEMP='D:\\Neutral\\scratch';·", '  │  dotnet test Example.Tests.csproj -c Debug', ...choices,
    ],
    'bare-bar reasoning above an unseparated question': [
      header, '  │  private plan', '  │  another private detail', '  │  >  Run the sample tests',
      "  │  │ $env:TEMP='D:\\Neutral\\scratch';·", ...choices,
    ],
    'reasoning that reads "> " before the separated question': [
      header, '  │  ♦ Thinking…', '  │  > a quoted line', '  │  private continuation', '  │',
      '  │  >  Run the sample tests', "  │  │ $env:TEMP='D:\\Neutral\\scratch';·", ...choices,
    ],
    'a mixed redraw with a separated quote and an unseparated question': [
      '  │  ♦ Thinking…', '  │', '  │  > quoted reasoning', '  │  private detail', '  │  >  Run the sample tests',
      "  │  │ $env:TEMP='D:\\Neutral\\scratch';·", ...choices,
    ],
    'literal "> " command text after a blank command line': [
      header, '  │', '  │  >  Run the sample tests', '  │  │ Write-Output sample', '  │  plain command row', '  │',
      '  │  > literal redirection text', ...choices,
    ],
    'literal "> " command text once the question has scrolled away': [
      header, '  │  │ Write-Output sample', '  │  plain continuation', '  │  > literal redirection text', ...choices,
    ],
    'reasoning that begins with a colon above plain text': [
      '  │  : a reasoning line', '  │  private continuation', '  │  plain command text', ...choices,
    ],
    'reasoning that begins with a colon under an action header': [
      header, '  │  : a reasoning line', '  │  private continuation', '  │  │ Write-Output sample', ...choices,
    ],
    'plain rows above the first command marker': [
      header, '  │  private plan', '  │  │ Write-Output sample', '  │  plain command row', ...choices,
    ],
  };
  for (const [name, frame] of Object.entries(frames)) {
    for (const [cols, height] of [[80, 24], [120, 40], [170, 60]]) {
      it(`filters ${name} exactly as without the claim at ${cols}x${height}`, async () => {
        const lines = await rendered(frame, cols!, height!);
        const withClaim = hideReasoning(lines, grok)!;
        const saved = grokReadingRules.claimPromptRows;
        delete grokReadingRules.claimPromptRows;
        try {
          const without = hideReasoning(lines, grok)!;
          expect(withClaim.lines).toEqual(without.lines);
          expect(withClaim.hiddenLines).toBe(without.hiddenLines);
        } finally {
          grokReadingRules.claimPromptRows = saved;
        }
      });
    }
  }
});
