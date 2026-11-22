import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { agentResumeIds, moduleFor, resolveAgent } from '../../src/agents/index.js';
import { nudgeVerdict } from '../../src/core/nudge.js';
import { detectPrompt } from '../../src/core/promptDetector.js';
import { hideReasoning, latestResult, possibleStall, signatureFor } from '../../src/core/reasoning.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import type { StyledLine } from '../../src/core/renderer.js';

async function paint(name = 'answered') {
  const geometry = JSON.parse(readFileSync(new URL(`../fixtures/hermes/${name}.json`, import.meta.url), 'utf8')) as {
    cols: number; rows: number;
  };
  const renderer = new ScreenRenderer(geometry);
  try {
    await renderer.write(readFileSync(new URL(`../fixtures/hermes/${name}.ansi`, import.meta.url), 'utf8'));
    return { lines: renderer.styledLines().lines, cursor: renderer.cursor };
  } finally {
    await renderer.dispose();
  }
}

function signature() {
  const entry = signatureFor('hermes');
  expect(entry, 'registered Hermes reader').toBeTruthy();
  return entry!;
}

function visible(lines: StyledLine[]) {
  return hideReasoning(lines, signature())!.lines.join('\n');
}

it('resolves the executable and explicit wrapper label', () => {
  expect(resolveAgent(undefined, 'C:\\bin\\Hermes.EXE')).toEqual({ agent: 'hermes', agentSource: 'program' });
  expect(signatureFor('hermes', 'pwsh')?.name).toBe('hermes');
  expect(resolveAgent(undefined, 'hermes-helper.exe').agent).toBe('generic');
  expect(agentResumeIds(moduleFor('hermes'), { HERMES_SESSION_ID: 'unverified' })).toEqual([]);
});

it('keeps both framed answers, the echoed prompt and the memory output', async () => {
  const { lines } = await paint();
  const filtered = visible(lines);
  for (const i of [2, 5, 9, 10, 17, 18, 21, 24, 28, 29, 34]) expect(filtered).toContain(lines[i]!.text);
  const result = latestResult(lines, signature());
  expect(result).toMatchObject({ found: true, answer: lines.slice(28, 30).map(line => line.text) });
});

it('hides ambiguous text, including a clipped answer body and a copy of the heading', async () => {
  const { lines } = await paint();
  const secret = { ...lines[28]!, text: 'Unframed words' };
  expect(visible([secret])).not.toContain(secret.text);
  expect(visible([lines[27]!, secret, lines[30]!])).not.toContain(secret.text);
  const changed = [...lines.slice(0, 28), secret, { text: 'Unclassified text', spans: [] }, ...lines.slice(30)];
  expect(visible(changed)).not.toContain('Unclassified text');
});

it('recognises the idle suggestion only inside the painted composer', async () => {
  const { lines } = await paint();
  // The serialised viewport parks the cursor at the start of the row.
  // The live idle composer reports column two after the prompt glyph.
  const cursor = { x: 2, y: 34 };
  const verdict = (styled: StyledLine[]) => nudgeVerdict(moduleFor('hermes'), {
    styled, rows: styled.map(l => l.text), cursor, viewportRows: 37, unchangedMs: 2000,
  });
  expect(verdict(lines)).toEqual({ ready: true });
  const readyScreen = moduleFor('hermes')?.readiness?.readyScreen;
  expect(readyScreen?.(lines.map(l => l.text).join('\n'))).toBe(true);
  expect(readyScreen?.('❯ Set a reminder or schedule a recurring task')).toBe(false);
  expect(verdict(lines.slice(0, -1))).toEqual({ ready: false, reason: 'unknown' });
  expect(verdict(lines.map(line => ({ ...line, spans: [] })))).toEqual({ ready: false, reason: 'unknown' });
  const changedHint = lines.map((line, i) => i === 34 ? { ...line, text: '❯ Other suggestion' } : line);
  expect(verdict(changedHint)).toEqual({ ready: false, reason: 'unknown' });
  const unfinished = lines.map((line, i) => i === 32 ? { ...line, text: 'Waiting for output' } : line);
  expect(verdict(unfinished)).toEqual({ ready: false, reason: 'unknown' });
  expect(latestResult(unfinished, signature()).found).toBe(false);
  expect(possibleStall(['Connection lost…', 'Request failed'], signature())).toBe(false);
});

it('reports the two first-use choices, preserves their text and holds nudges', async () => {
  const { lines, cursor } = await paint('confirmation');
  const rows = lines.map(l => l.text);
  expect(detectPrompt(rows.join('\n'), 'hermes', 34, lines)).toMatchObject({
    question: 'Help improve Hermes?', options: ['Share with Nous', 'No thanks'], selectedOption: 1,
  });
  expect(visible(lines)).toContain('2. No thanks');
  expect(nudgeVerdict(moduleFor('hermes'), { rows, styled: lines, cursor, viewportRows: 34, unchangedMs: 2000 }))
    .toEqual({ ready: false, reason: 'prompt' });
  expect(detectPrompt([...rows, 'Later output'].join('\n'), 'hermes', 34, lines)).toBeNull();
});

it.each([12, 135])('requires the exact %i-character draft before Enter', async length => {
  const capture = readFileSync(new URL('../fixtures/hermes/answered.ansi', import.meta.url), 'utf8');
  const body = 'a'.repeat(length);
  const suffix = capture.slice(capture.lastIndexOf('─ 0.0s'));
  const paint = '\x1b[2m' + suffix.replace('\x1b[38;2;184;134;11;3mSet a reminder or schedule a recurring task', '\x1b[0m' + body);
  const renderer = new ScreenRenderer({ cols: 105, rows: 10 });
  try {
    await renderer.write(paint);
    const styled = renderer.styledLines().lines;
    const last = length > 103 ? 3 : 2;
    const view = { styled, rows: styled.map(l => l.text), viewportRows: 10, unchangedMs: 2000,
      cursor: { x: styled[last]!.text.length, y: last }, untrimmedRow: (y: number) => renderer.untrimmedRow(y) };
    const module = moduleFor('hermes');
    expect(nudgeVerdict(module, view)).toEqual({ ready: false, reason: 'draft' });
    expect(nudgeVerdict(module, { ...view, expectedDraft: body })).toEqual({ ready: true });
    for (const wrong of [body.slice(1), body + ' ', body + 'b']) {
      expect(nudgeVerdict(module, { ...view, expectedDraft: wrong }).ready).toBe(false);
    }
    expect(nudgeVerdict(module, { ...view, cursor: { ...view.cursor, x: 0 }, expectedDraft: body }).ready).toBe(false);
  } finally {
    await renderer.dispose();
  }
});
