import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { moduleFor } from '../../src/agents/index.js';
import { nudgeVerdict } from '../../src/core/nudge.js';
import { detectPrompt } from '../../src/core/promptDetector.js';
import { hideReasoning, latestResult, signatureFor } from '../../src/core/reasoning.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import type { StyledLine } from '../../src/core/renderer.js';

const renderers: ScreenRenderer[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0)) await renderer.dispose();
});

async function frame(name: string) {
  const base = new URL('../fixtures/hermes/', import.meta.url);
  const geometry = JSON.parse(readFileSync(new URL(name + '.json', base), 'utf8')) as { cols: number; rows: number };
  const renderer = new ScreenRenderer(geometry);
  renderers.push(renderer);
  await renderer.write(readFileSync(new URL(name + '.ansi', base), 'utf8'));
  const styled = renderer.styledLines().lines;
  return { styled, rows: styled.map(line => line.text), cursor: renderer.cursor, viewportRows: geometry.rows,
    unchangedMs: 2000, composerUnchangedMs: 2000, untrimmedRow: (y: number) => renderer.untrimmedRow(y) };
}

function signature() {
  const sig = signatureFor('hermes');
  expect(sig, 'registered Hermes reader').toBeTruthy();
  return sig!;
}

function kept(styled: StyledLine[]) {
  const filtered = hideReasoning(styled, signature())!;
  return filtered.rows.filter((_row, index) => !filtered.markers[index]);
}

const hermes = moduleFor('hermes');

it('opens on the welcome banner with an empty suggestion and the cursor at the prefix', async () => {
  const view = await frame('welcome');
  expect(hermes?.readiness?.readyScreen?.(view.rows.join('\n'))).toBe(true);
  expect(nudgeVerdict(hermes, view)).toEqual({ ready: true });
  expect(nudgeVerdict(hermes, { ...view, cursor: { x: 0, y: 34 } }).ready).toBe(false);
  expect(nudgeVerdict(hermes, { ...view, queueDraft: true }).ready).toBe(false);
  const styled = view.styled.map((row, i) => i === 30 ? { ...row, text: 'Other banner' } : row);
  expect(nudgeVerdict(hermes, { ...view, styled, rows: styled.map(row => row.text) }))
    .toEqual({ ready: false, reason: 'unknown' });
  const bare = view.styled.map((row, i) => i === 34 ? { ...row, text: '❯' } : row);
  expect(nudgeVerdict(hermes, { ...view, styled: bare, rows: bare.map(row => row.text) }))
    .toEqual({ ready: false, reason: 'unknown' });
  expect(hermes?.input?.submit?.matches?.('  \r')).toBe(true);
  expect(hermes?.input?.submit?.matches?.('\r')).toBe(false);
});

it('recognises the planning suggestion after a queued reply', async () => {
  const view = await frame('queued-answer');
  expect(hermes?.readiness?.readyScreen?.(view.rows.join('\n'))).toBe(true);
  expect(nudgeVerdict(hermes, view)).toEqual({ ready: true });
  const styled = view.styled.map(row => ({ ...row, text: row.text.replace('Plan a feature', 'Read a feature') }));
  expect(nudgeVerdict(hermes, { ...view, styled, rows: styled.map(row => row.text) }))
    .toEqual({ ready: false, reason: 'unknown' });
});

it('reads the selected denial above the compact busy footer', async () => {
  const view = await frame('compact-approval');
  expect(detectPrompt(view.rows.join('\n'), 'hermes', 37, view.styled)).toMatchObject({
    options: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'], selectedOption: 3,
  });
  expect(nudgeVerdict(hermes, view)).toEqual({ ready: false, reason: 'prompt' });
  const styled = view.styled.map(row => ({ ...row, text: row.text.replace(' · …', ' · ?') }));
  expect(detectPrompt(styled.map(row => row.text).join('\n'), 'hermes', 37, styled)).toBeNull();
});

it('proves the full idle draft across the physical break before the right margin', async () => {
  const view = await frame('draft');
  expect(view.styled[34]!.wrapped).toBeFalsy();
  expect(view.rows[33]).toHaveLength(104);
  const expectedDraft = view.rows[33]!.slice(2) + view.rows[34]!;
  expect(nudgeVerdict(hermes, view)).toEqual({ ready: false, reason: 'draft' });
  expect(nudgeVerdict(hermes, { ...view, expectedDraft })).toEqual({ ready: true });
  for (const wrong of [expectedDraft + ' ', expectedDraft.slice(1), view.rows[34], expectedDraft + '\n']) {
    expect(nudgeVerdict(hermes, { ...view, expectedDraft: wrong }).ready).toBe(false);
  }
  expect(nudgeVerdict(hermes, { ...view, expectedDraft, cursor: { x: 13, y: 34 } }).ready).toBe(false);
  const styled = view.styled.map((row, i) => i === 33 ? { ...row, text: row.text.slice(0, -1) } : row);
  expect(nudgeVerdict(hermes, { ...view, expectedDraft, styled, rows: styled.map(row => row.text) }).ready).toBe(false);
});

it('hides both dim reasoning blocks and the spinner while retaining framed replies and labelled searches', async () => {
  const { styled } = await frame('thinking');
  const shown = kept(styled);
  for (const i of [0, 1, 2, 3, 18, 19, 27, 32, 33]) expect(shown).not.toContain(i);
  for (const i of [7, 8, 9, 10, 13, 14, 15, 34, 35, 36]) expect(shown).toContain(i);
  expect(latestResult(styled, signature())).toMatchObject({ found: false, reason: 'busy' });
  const unlabelled = styled.map((row, i) => i === 13 ? { ...row, spans: [] } : row);
  expect(kept(unlabelled)).not.toContain(13);
});

it('returns the completed answer after a command and hides the reasoning around it', async () => {
  const { styled, rows } = await frame('tool');
  const shown = kept(styled);
  expect(shown).toContain(rows.findIndex(row => row.startsWith('💻 $ ')));
  for (const i of [19, 20, 21, 22, 23]) expect(shown).not.toContain(i);
  expect(latestResult(styled, signature())).toMatchObject({ found: true, answer: rows.slice(28, 30) });
  const clipped = styled.map((row, i) => i === 26 ? { ...row, spans: [] } : row);
  expect(kept(clipped)).not.toContain(28);
  expect(latestResult(clipped, signature()).found).toBe(false);
  const earlierReply = styled.slice(26, 31);
  const damagedReply = styled.slice(26).map((row, i) => i === 1 ? { ...row, text: 'Other heading' } : row);
  expect(latestResult([...earlierReply, ...damagedReply], signature()).found).toBe(false);
});

it('keeps the clarification tool and the denial message while treating the following turn as busy', async () => {
  const clarified = await frame('clarified');
  const denied = await frame('denied');
  expect(kept(clarified.styled)).toContain(clarified.rows.findIndex(row => row.startsWith('❓ Clarify ')));
  expect(kept(denied.styled)).toContain(denied.rows.findIndex(row => row.startsWith('✗ $ ')));
  expect(latestResult(denied.styled, signature())).toMatchObject({ found: false, reason: 'busy' });
  expect(nudgeVerdict(hermes, denied).ready).toBe(false);
});

it('reads every paragraph of a long turn with a clipped grey usage footer', async () => {
  const { styled, rows } = await frame('long-turn');
  expect(latestResult(styled, signature())).toMatchObject({ found: true, answer: rows.slice(12, 30) });
  expect(kept(styled)).not.toContain(1);
  const missing = styled.map((row, i) => i === 36 ? { ...row, text: row.text.slice(0, -3) } : row);
  expect(latestResult(missing, signature()).found).toBe(false);
});

it.each(['approval', 'question'])('keeps the live %s, all options and the selection, and holds input', async name => {
  const view = await frame(name);
  const approval = name === 'approval';
  const top = approval ? 19 : 24;
  const prompt = detectPrompt(view.rows.join('\n'), 'hermes', 37, view.styled);
  expect(prompt).toMatchObject({
    question: approval ? '⚠️  Dangerous Command\n' + view.rows[22]!.slice(1, -1).trim() : 'xxxxx xx xxx xxxxxxx',
    selectedOption: approval ? 3 : 0, rows: [top, 32],
    optionRows: approval ? [24, 25, 26, 27] : [27, 28, 29],
    options: approval ? ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'] :
      ['xxxxx (Recommended)', 'xxxxx', 'Other (type your answer)'],
  });
  const shown = kept(view.styled);
  for (let i = top; i <= 32; i++) expect(shown).toContain(i);
  expect(shown).not.toContain(33);
  expect(nudgeVerdict(hermes, view)).toEqual({ ready: false, reason: 'prompt' });
  expect(detectPrompt(view.rows.join('\n'), 'hermes', 37)).toBeNull();
  const wrongInk = view.styled.map((row, i) => i === 30 ? { ...row, spans: [] } : row);
  expect(detectPrompt(view.rows.join('\n'), 'hermes', 37, wrongInk)).toBeNull();
  expect(detectPrompt(view.rows.slice(0, 31).join('\n'), 'hermes', 37, view.styled.slice(0, 31))).toBeNull();
});

it('queues only a stable empty busy composer and requires the exact draft for Tab', async () => {
  const busy = await frame('busy');
  const typed = await frame('queue-draft');
  const queued = await frame('queued');
  const expectedDraft = typed.rows[34]!.slice(4);
  expect(nudgeVerdict(hermes, busy)).toEqual({ ready: true, queued: true });
  expect(nudgeVerdict(hermes, { ...busy, composerUnchangedMs: 1499 })).toEqual({ ready: false, reason: 'quiet' });
  expect(nudgeVerdict(hermes, { ...busy, cursor: { x: 3, y: 34 } }).ready).toBe(false);
  expect(nudgeVerdict(hermes, typed)).toEqual({ ready: false, reason: 'busy' });
  expect(nudgeVerdict(hermes, { ...typed, expectedDraft })).toEqual({ ready: false, reason: 'busy' });
  expect(nudgeVerdict(hermes, { ...typed, expectedDraft, queueDraft: true })).toEqual({ ready: true });
  expect(nudgeVerdict(hermes, { ...typed, expectedDraft: expectedDraft + ' ', queueDraft: true }).ready).toBe(false);
  expect(nudgeVerdict(hermes, queued)).toEqual({ ready: false, reason: 'busy' });
  expect(nudgeVerdict(hermes, { ...queued, afterSubmit: true })).toEqual({ ready: true, queued: true });
  expect(nudgeVerdict(hermes, { ...typed, afterSubmit: true }).ready).toBe(false);
  expect(kept(queued.styled)).toEqual(expect.arrayContaining([31, 32]));
});
