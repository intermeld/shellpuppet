import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { opencode } from '../../src/agents/opencode/index.js';
import { NUDGE_QUIET_MS, nudgeVerdict } from '../../src/core/nudge.js';
import type { NudgeObservation } from '../../src/core/nudge.js';
import { ScreenRenderer } from '../../src/core/renderer.js';

const fixtures = join(__dirname, '..', 'fixtures', 'nudge');
const hint = 'Ask anything… "Fix broken tests"';
const draft = 'This is a long unsent draft line that will certainly wrap past eighty columns in the OpenCode composer so we ' +
  'can see how continuation rows are drawn';

async function replay(name: string): Promise<NudgeObservation> {
  const renderer = new ScreenRenderer({ agent: 'opencode', cols: 120, rows: 34 });
  try {
    await renderer.write(readFileSync(join(fixtures, `opencode-chair-${name}.ansi`), 'utf8'));
    const styled = renderer.styledLines().lines;
    return { styled, rows: styled.map(line => line.text), viewportRows: renderer.rows, unchangedMs: NUDGE_QUIET_MS };
  } finally {
    await renderer.dispose();
  }
}

it.each(['welcome', 'idle'])('recognises the captured %s composer after a quiet period', async name => {
  const screen = await replay(name);
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: true });
  expect(nudgeVerdict(opencode, { ...screen, exactEmpty: true })).toEqual({ ready: true });
  expect(nudgeVerdict(opencode, { ...screen, unchangedMs: 0 })).toEqual({ ready: false, reason: 'quiet' });
});

it('requires the complete suggestion in placeholder ink', async () => {
  const screen = await replay('welcome');
  const styled = screen.styled!.map(line => line.text.includes(hint) ? { ...line, spans: line.spans.map(span =>
    span.fg === '#808080' ? { ...span, fg: '#eeeeee' } : span) } : line);
  expect(nudgeVerdict(opencode, { ...screen, styled })).toEqual({ ready: false, reason: 'draft' });
  expect(nudgeVerdict(opencode, { ...screen, styled: undefined })).toEqual({ ready: false, reason: 'draft' });
  const broken = screen.styled!.map(line => ({ ...line, text: line.text.replace(hint, hint.slice(0, -1) + '!') }));
  expect(nudgeVerdict(opencode, { ...screen, styled: broken, rows: broken.map(line => line.text) }))
    .toEqual({ ready: false, reason: 'draft' });
});

it('submits the complete wrapped line once and rejects a suffix or an extra copy', async () => {
  const screen = await replay('wrapped');
  const verdict = (expectedDraft: string) => nudgeVerdict(opencode, { ...screen, expectedDraft });
  expect(verdict(draft)).toEqual({ ready: true });
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: false, reason: 'draft' });
  expect(verdict('can see how continuation rows are drawn')).toEqual({ ready: false, reason: 'draft' });
  const at = screen.rows.findIndex(row => row.includes('This is a long'));
  const rows = [...screen.rows.slice(0, at), ...screen.rows.slice(at, at + 2), ...screen.rows.slice(at)];
  expect(nudgeVerdict(opencode, { ...screen, rows, styled: undefined, expectedDraft: draft }))
    .toEqual({ ready: false, reason: 'draft' });
  const splitWord = [...screen.rows];
  splitWord[at] = splitWord[at]!.slice(0, -1);
  splitWord[at + 1] = '  ┃  e ' + splitWord[at + 1]!.slice(5);
  expect(nudgeVerdict(opencode, { ...screen, rows: splitWord, styled: undefined, expectedDraft: draft }))
    .toEqual({ ready: true });
  const extraBlank = [...screen.rows.slice(0, at + 1), '  ┃', ...screen.rows.slice(at + 1)];
  expect(nudgeVerdict(opencode, { ...screen, rows: extraBlank, styled: undefined, expectedDraft: draft }))
    .toEqual({ ready: false, reason: 'draft' });
});

it('requires the aligned gutter, folder footer and clear space below the welcome screen', async () => {
  const screen = await replay('welcome');
  const foot = screen.rows.findIndex(row => row.includes('╹▀'));
  for (const [index, replacement] of [[foot - 4, ''], [foot - 2, '┃'], [foot - 1, 'Build · GLM-5.3'],
    [foot, '╹▀▀▀▀▀▀▀▀'], [foot + 1, '  ctrl+p commands'], [screen.rows.length, 'Later output']] as const) {
    const rows = [...screen.rows];
    rows[index] = replacement;
    const styled = rows.map((text, i) => ({ ...screen.styled![i], text, spans: screen.styled![i]?.spans ?? [] }));
    expect(nudgeVerdict(opencode, { ...screen, rows, styled })).toEqual({ ready: false, reason: 'unknown' });
  }
});

it('blocks a running turn and a question panel while messages wait', async () => {
  const screen = await replay('idle');
  const rows = ['     ⠇ Thinking', ...screen.rows];
  expect(nudgeVerdict(opencode, { ...screen, rows, styled: undefined, composerUnchangedMs: NUDGE_QUIET_MS }))
    .toEqual({ ready: false, reason: 'busy' });
  const running = screen.rows.map(row => row.includes('ctrl+p commands')
    ? '   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt                 0.0K (0%)  ctrl+p commands' : row);
  expect(nudgeVerdict(opencode, { ...screen, rows: running, styled: undefined, expectedDraft: draft }))
    .toEqual({ ready: false, reason: 'busy' });
  const panel = ['  ┃  Questions', '  ┃', '  ┃  Which colour?', '  ┃', '  ┃  1. Blue',
    '  ┃  2. Type your own answer', '  ┃', '  ┃  ↑↓ select  enter submit  esc dismiss'];
  expect(nudgeVerdict(opencode, { ...screen, rows: [...screen.rows, ...panel], styled: undefined }))
    .toEqual({ ready: false, reason: 'prompt' });
});

it.each(['busy-start', 'busy-entered'])('queues on the captured %s footer after the composer settles', async name => {
  const screen = { ...await replay(name), unchangedMs: 0 };
  expect(opencode.nudge!.readiness(screen)).toBe('queue');
  for (const composerUnchangedMs of [undefined, NUDGE_QUIET_MS - 1]) {
    expect(nudgeVerdict(opencode, { ...screen, composerUnchangedMs })).toEqual({ ready: false, reason: 'quiet' });
  }
  expect(nudgeVerdict(opencode, { ...screen, composerUnchangedMs: NUDGE_QUIET_MS })).toEqual({ ready: true, queued: true });
});

it('requires the whole busy footer and frame, with no panel below', async () => {
  const screen = await replay('busy-start');
  const foot = screen.rows.findIndex(row => row.includes('╹▀'));
  const footer = screen.rows[foot + 1]!;
  const idle = await replay('idle');
  const altered = (index: number, text: string) => screen.rows.map((row, i) => index === i ? text : row);
  const permission = readFileSync(join(fixtures, '..', 'dialogs', 'opencode-permission-dialog.txt'), 'utf8').split(/\r?\n/u);
  for (const rows of [
    altered(foot - 4, ''), altered(foot - 2, ' ┃'), altered(foot - 1, '  ┃  Plan · Example'),
    altered(foot, '  ╹▀'), altered(foot + 1, footer.slice(1)), altered(foot + 1, footer.replace('⬝⬝', '')),
    altered(foot + 1, footer.replace('esc interrupt', 'esc dismiss')), altered(foot + 1, footer.replace('ctrl+p commands', 'enter allow')),
    altered(foot + 1, footer + '  Allow once'), [...screen.rows, '', 'Other panel'],
    [...screen.rows, ...permission], [...screen.rows, '  ┃  Questions', '  ┃  1. Blue', '  ┃  2. Green'],
    // The tab spinner alone can signal work but cannot authorise typing.
    [screen.rows[0]!, ...idle.rows.slice(1)],
  ]) {
    const view = { rows, viewportRows: rows.length, unchangedMs: NUDGE_QUIET_MS, composerUnchangedMs: NUDGE_QUIET_MS };
    expect(nudgeVerdict(opencode, view).ready).toBe(false);
    expect(nudgeVerdict(opencode, { ...view, expectedDraft: draft }).ready).toBe(false);
  }
});

it('protects a busy draft and confirms only the complete daemon line before Enter', async () => {
  const busy = await replay('busy-entered');
  const wrapped = await replay('wrapped');
  const footer = busy.rows.find(row => row.includes('esc interrupt'))!;
  const rows = wrapped.rows.map(row => row.includes('ctrl+p commands') ? footer : row);
  const view = { rows, viewportRows: wrapped.viewportRows, composerUnchangedMs: NUDGE_QUIET_MS, unchangedMs: 0 };
  expect(nudgeVerdict(opencode, view)).toEqual({ ready: false, reason: 'busy' });
  expect(nudgeVerdict(opencode, { ...view, expectedDraft: draft })).toEqual({ ready: true });
  expect(nudgeVerdict(opencode, { ...view, expectedDraft: 'can see how continuation rows are drawn' }).ready).toBe(false);
  expect(nudgeVerdict(opencode, { ...view, expectedDraft: draft, rows: [...rows, 'Allow once'] }).ready).toBe(false);
});

it('measures quiet over the entire gutter block through the busy footer', async () => {
  const { rows } = await replay('busy-start');
  const key = opencode.nudge!.composerBlock!;
  const foot = rows.findIndex(row => row.includes('╹▀'));
  const changed = (index: number, text: string) => rows.map((row, i) => i === index ? text : row);
  expect(key(changed(0, 'New tab spinner'))).toBe(key(rows));
  expect(key(changed(foot + 1, rows[foot + 1]!.replace('⬝⬝⬝⬝', '■■■■')))).toBe(key(rows));
  for (const index of [foot - 4, foot - 3, foot - 2, foot - 1, foot, foot + 1]) {
    expect(key(changed(index, rows[index] + 'x'))).not.toBe(key(rows));
  }
  expect(key([...rows, 'Approve access'])).not.toBe(key(rows));
});
