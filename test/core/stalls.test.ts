import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as reading from '../../src/core/reasoning.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import type { StyledLine } from '../../src/core/renderer.js';
import { moduleFor } from '../../src/agents/index.js';
import { detectPrompt } from '../../src/core/promptDetector.js';

const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/stalls/mimo-refusal.ansi'), 'utf8');
async function rows(): Promise<StyledLine[]> {
  const renderer = new ScreenRenderer({ cols: 120, rows: 30 });
  await renderer.write(fixture);
  const lines = renderer.styledLines().lines;
  await renderer.dispose();
  return lines;
}
function detect(lines: StyledLine[], prompt = false) {
  return reading.detectStall(lines, reading.signatureFor('mimo', 'mimo')!, prompt);
}
function at(lines: StyledLine[], text: string): number {
  const index = lines.findIndex(line => line.text.includes(text));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}
function plain(text: string): StyledLine {
  return { text, spans: [{ from: 0, to: text.length, bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null }] };
}

describe('stall comparison cache', () => {
  it('reuses only the independently framed footer when its control changes', async () => {
    const source = moduleFor('mimo')!.stalls![0]!;
    let walks = 0;
    const shapes = [{ ...source, contentRegion: (lines: readonly StyledLine[]) => {
      walks++;
      return source.contentRegion?.(lines) ?? lines;
    } }];
    const lines = (await rows()).map(line => line.text);
    const footer = lines.findIndex(line => line.includes('▣  Build'));
    const cache = new reading.StallScreenCache();
    const original = cache.content(lines, shapes);
    const initialWalks = walks;
    const copied = [...lines];
    copied[footer] = copied[footer]!.replace('⎘ copy', '⎘ copied 123');
    expect(cache.content(copied, shapes)).toBe(original);
    expect(walks).toBe(initialWalks);
    copied[lines.findIndex(line => line.includes('Reading the sample.'))] = '     Changed real output. ⎘ copy';
    expect(cache.content(copied, shapes)).not.toBe(original);
    expect(walks).toBeGreaterThan(initialWalks);
  });

  it('re-establishes footer ownership when another part of the frame changes', async () => {
    const shapes = moduleFor('mimo')!.stalls!;
    const lines = (await rows()).map(line => line.text);
    const footer = lines.findIndex(line => line.includes('▣  Build'));
    const edge = lines.findIndex(line => line.includes('╹'));
    for (const change of ['edge', 'output', 'extra row']) {
      const cache = new reading.StallScreenCache();
      const original = cache.content(lines, shapes);
      const changed = [...lines];
      changed[footer] = changed[footer]!.replace('⎘ copy', '⎘ copied 456');
      if (change === 'edge') changed[edge] = '';
      else if (change === 'output') changed[footer - 1] = '     Ordinary output █ second';
      else changed.push('     Ordinary output ⎘ copy');
      expect(cache.content(changed, shapes)).toBe(reading.stallScreenContent(changed, shapes));
      expect(cache.content(changed, shapes)).not.toBe(original);
    }
  });
});

describe('evidenced provider stall', () => {
  it('recognises the styled live bottom block with an idle composer', async () => {
    expect(detect(await rows())).toMatchObject({ reason: 'provider-refused', description: 'The model provider refused the turn.' });
  });
  it('rejects the same phrases in a cat or grep listing', async () => {
    const lines = await rows();
    const start = at(lines, '✗ Error');
    for (let i = start - 1; i <= start + 3; i++) {
      lines[i] = { ...lines[i]!, spans: lines[i]!.spans.map(span => ({ ...span, fg: span.fg === '#fb7185' ? '#0a0a0a' : span.fg })) };
    }
    lines.splice(start - 1, 0, plain('  ┃  $ cat sample.txt'));
    expect(detect(lines)).toBeNull();
  });
  it('rejects the same phrases quoted in the agent prose answer', async () => {
    const lines = await rows();
    lines[at(lines, '✗ Error')] = plain('     The log said ✗ Error; this is a quotation.');
    lines[at(lines, 'The response was withheld')] = plain("     The response was withheld by the model provider's content safety filter.");
    expect(detect(lines)).toBeNull();
  });
  it('rejects an unstyled error block', async () => {
    expect(detect((await rows()).map(line => plain(line.text)))).toBeNull();
  });
  it('rejects the block while the agent is busy', async () => {
    const lines = await rows();
    lines[at(lines, 'ctrl+p')] = plain('   esc to interrupt');
    expect(detect(lines)).toBeNull();
  });
  it('rejects the block with a permission prompt showing', async () => {
    const lines = await rows();
    lines.splice(at(lines, 'ctrl+p') + 1, 0,
      plain('  ┃'), plain('  ┃  △ Permission required'), plain('  ┃'),
      plain('  ┃   Allow once   Always allow   Reject'), plain('  ┃'));
    const prompt = detectPrompt(lines.map(line => line.text).join('\n'), 'mimo');
    expect(prompt).not.toBeNull();
    expect(detect(lines, prompt !== null)).toBeNull();
  });
  it('rejects newer output below the error block', async () => {
    const lines = await rows();
    lines.splice(at(lines, '▣  Build'), 0, plain('     A newer answer follows.'));
    expect(detect(lines)).toBeNull();
  });
  it('rejects a stale block after a new user turn starts working', async () => {
    const lines = await rows();
    lines.splice(at(lines, '▣  Build') + 1, 0, plain('  ┃  Continue the task.'), plain('     ⠇ Thinking'));
    expect(detect(lines)).toBeNull();
  });
  it('requires the composer, including its closing edge', async () => {
    expect(detect((await rows()).filter(line => !line.text.includes('╹')))).toBeNull();
  });
  it('accepts the idle composer with its side panel and grey suggestion', async () => {
    const lines = await rows();
    const index = at(lines, '  ┃  Build');
    lines[at(lines, '╹')] = plain('  ╹' + '▀'.repeat(77));
    lines[index] = plain(lines[index]!.text.padEnd(83) + '█ Example panel');
    lines[index - 1] = plain('  ┃' + ' '.repeat(80) + '█ Example folder');
    const suggestion = plain('  ┃  Review the sample. (Tab to accept)');
    suggestion.spans[0]!.fg = '#808080';
    lines.splice(index - 1, 0, suggestion, plain(' '.repeat(83) + '█ Example context'));
    expect(detect(lines)).toMatchObject({ reason: 'provider-refused' });
  });
  it('rejects newer output after the footer', async () => {
    const lines = await rows();
    lines.splice(at(lines, '▣  Build') + 1, 0, plain('     A newer answer follows.'));
    expect(detect(lines)).toBeNull();
  });
  it('does not turn repeated wide output glyphs into a panel without a composer divider', async () => {
    const lines = await rows();
    lines.splice(at(lines, '▣  Build') + 1, 0,
      plain(' '.repeat(83) + '█ first'), plain(' '.repeat(83) + '█ second'));
    expect(detect(lines)).toBeNull();
  });
  it('rejects a printed settings phrase after the actual bottom status row', async () => {
    const lines = await rows();
    lines.push(plain('   ctrl+p settings'));
    expect(detect(lines)).toBeNull();
  });
  it('does not treat aligned wide glyphs in draft rows as a panel frame', async () => {
    const lines = await rows();
    const index = at(lines, '  ┃  Build');
    lines[index - 1] = plain('  ┃' + ' '.repeat(80) + '█ first');
    lines.splice(index - 1, 0, plain('  ┃' + ' '.repeat(80) + '█ second'));
    expect(detect(lines)).toBeNull();
  });
  it('retains draft text before an independently framed side panel', async () => {
    const lines = await rows();
    const index = at(lines, '  ┃  Build');
    lines[index] = plain(lines[index]!.text.padEnd(83) + '█ Example panel');
    lines[index - 1] = plain(('  ┃' + ' '.repeat(26) + 'Draft text').padEnd(83) + '█ Example folder');
    lines.splice(index - 1, 0, plain(' '.repeat(83) + '█ Example context'));
    expect(detect(lines)).toBeNull();
  });
  it('rejects an unsent prompt in the composer', async () => {
    const lines = await rows();
    const index = at(lines, '  ┃  Build');
    lines[index - 1] = plain('  ┃  Please continue');
    expect(detect(lines)).toBeNull();
  });
  it('seeds only MiMo, whose footer and error ink have evidence', () => {
    expect(moduleFor('mimo')?.stalls).toHaveLength(1);
    expect(moduleFor('opencode')?.stalls).toBeUndefined();
  });
});
