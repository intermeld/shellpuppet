import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { opencode } from '../../src/agents/opencode/index.js';
import { NUDGE_QUIET_MS, nudgeVerdict } from '../../src/core/nudge.js';
import { ScreenRenderer } from '../../src/core/renderer.js';

const fixtures = join(__dirname, '..', 'fixtures', 'nudge');
const hint = 'Ask anything… "Fix broken tests"';
const draft = 'This is a long unsent draft line that will certainly wrap past eighty columns in the OpenCode composer so we ' +
  'can see how continuation rows are drawn';

async function replay(name: string, paint = '', keepCells = false) {
  const renderer = new ScreenRenderer({ agent: 'opencode', cols: 120, rows: 34 });
  try {
    await renderer.write(readFileSync(join(fixtures, `opencode-chair-${name}.ansi`), 'utf8'));
    await renderer.write(paint);
    const styled = renderer.styledLines().lines;
    const physical = keepCells ? styled.map((_, i) => renderer.untrimmedRow(i)) : undefined;
    return { styled, untrimmedRow: physical && ((i: number) => physical[i]), rows: styled.map(line => line.text), cursor: renderer.snapshot().cursor,
      viewportRows: renderer.rows, unchangedMs: NUDGE_QUIET_MS, composerUnchangedMs: NUDGE_QUIET_MS };
  } finally {
    await renderer.dispose();
  }
}

it.each(['idle', 'busy-start'])('protects a space-only %s input even though the renderer trims the text', async name => {
  // The input starts at (5, 28). Three typed spaces leave the same visible gutter.
  const screen = await replay(name, '\x1b[29;6H\x1b[38;2;238;238;238m   ');
  expect(screen.cursor).toEqual({ x: 8, y: 28 });
  expect(nudgeVerdict(opencode, screen).ready).toBe(false);
});

it.each(['idle', 'busy-start'])('requires blank cells and the exact input origin in %s', async name => {
  const start = '\x1b[29;6H';
  const screen = await replay(name, start, true);
  expect(nudgeVerdict(opencode, screen).ready).toBe(true);
  for (const cursor of [undefined, { x: 6, y: 28 }, { x: 5, y: 27 }]) {
    expect(nudgeVerdict(opencode, { ...screen, cursor }).ready).toBe(false);
  }
  const spaces = await replay(name, start + '\x1b[38;2;238;238;238m   ' + start, true);
  expect(nudgeVerdict(opencode, spaces).ready).toBe(false);
});

it('rejects a one-row busy draft with the cursor at its start', async () => {
  const screen = await replay('busy-start', '\x1b[29;6Hmy draft\x1b[29;6H');
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: false, reason: 'busy' });
});

it('checks the ink through the last word and quote of the welcome hint', async () => {
  const screen = await replay('welcome', '\x1b[20;53H\x1b[38;2;238;238;238mtests"');
  expect(screen.rows.some(row => row.includes(hint))).toBe(true);
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: false, reason: 'draft' });
});

it('refuses an early newline even when it replaces exactly one expected space', async () => {
  const screen = await replay('wrapped');
  const line = '[ShellPuppet] Message m1 from chair is waiting. Read it with the session_inbox tool.';
  const rows = screen.rows.map(row => row.includes('This is a long') ? '  ┃  ' + line.slice(0, 35)
    : row.includes('can see how') ? '  ┃  ' + line.slice(36) : row);
  expect(nudgeVerdict(opencode, { ...screen, rows, styled: undefined, expectedDraft: line }))
    .toEqual({ ready: false, reason: 'draft' });
});

it('reads and measures the main composer beside the 200-column sidebar', async () => {
  const screen = await replay('idle', '\x1b[29;6H');
  const rows = [...screen.rows];
  const foot = rows.findIndex(row => row.startsWith('  ╹'));
  rows[foot] = '  ╹' + '▀'.repeat(153);
  rows[foot - 4] = '  ┃'.padEnd(164) + 'Claude, GPT, Gemini etc';
  rows[foot - 2] = '  ┃'.padEnd(164) + 'Connect provider        /connect';
  rows[foot + 1] = '  ~/project'.padEnd(130) + '0.0K (0%)  ctrl+p commands    ~/project';
  const view = { ...screen, rows, styled: undefined };
  expect(nudgeVerdict(opencode, view)).toEqual({ ready: true });
  const body = 'a nudge';
  const typed = rows.map((row, i) => i === foot - 3 ? '  ┃  ' + body : row);
  const submit = { ...view, rows: typed, expectedDraft: body };
  expect(nudgeVerdict(opencode, submit).ready).toBe(true);
  expect(nudgeVerdict(opencode, { ...submit, cursor: { x: 164, y: foot - 3 } }).ready).toBe(false);
  const key = opencode.nudge!.composerBlock!;
  expect(key(rows)).toBe(key(rows.map(row => row.replace('Connect provider', 'Another sidebar item'))));
  for (const extra of ['Allow once', '  ┃  Questions']) {
    expect(nudgeVerdict(opencode, { ...view, rows: [...rows, extra] }).ready).toBe(false);
  }
});

it('requires the next word to overflow even when the complete nudge spans several rows', async () => {
  const screen = await replay('wrapped');
  const prefix = 'a'.repeat(105);
  for (const length of [5, 6]) {
    const rest = 'b'.repeat(length) + ' nextword';
    const rows = screen.rows.map(row => row.includes('This is a long') ? '  ┃  ' + prefix
      : row.includes('can see how') ? '  ┃  ' + rest : row);
    const verdict = nudgeVerdict(opencode, { ...screen, rows, styled: undefined, expectedDraft: prefix + ' ' + rest });
    expect(verdict.ready).toBe(length === 6);
  }
});

it('ignores an interrupt shortcut quoted in a completed turn', async () => {
  const screen = await replay('idle', '\x1b[7;6HWhat does esc interrupt do?\x1b[29;6H');
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: true });
});

it('requires the interrupt shortcut in its control ink before queueing', async () => {
  const screen = await replay('busy-start', '\x1b[33;17H\x1b[38;2;238;238;238minterrupt\x1b[29;6H');
  expect(nudgeVerdict(opencode, screen).ready).toBe(false);
});

it('uses the live key and caption colours for a themed busy footer', async () => {
  const screen = await replay('busy-start', '\x1b[29;6H');
  const styled = screen.styled.map(line => line.text.includes('esc interrupt') ? { ...line,
    spans: line.spans.map(span => ({ ...span,
      fg: span.fg === '#eeeeee' ? '#c8d3f5' : span.fg === '#808080' ? '#828bb8' : span.fg })) } : line);
  expect(nudgeVerdict(opencode, { ...screen, styled })).toEqual({ ready: true, queued: true });
  const monochrome = styled.map(line => ({ ...line, spans: line.spans.map(span => ({ ...span, fg: '#eeeeee' })) }));
  expect(nudgeVerdict(opencode, { ...screen, styled: monochrome }).ready).toBe(false);
});

it('accepts the model cost OpenCode adds to the idle footer', async () => {
  const screen = await replay('idle', '\x1b[29;6H');
  const rows = [...screen.rows];
  const foot = rows.findIndex(row => row.startsWith('  ╹'));
  const footer = rows[foot + 1]!;
  const start = footer.search(/\d+(?:\.\d+)?[KMB]? \(\d+%\)/u);
  expect(start).toBeGreaterThan(0);
  const tail = '18.1K (14%) · $0.06  ctrl+p commands';
  rows[foot + 1] = footer.slice(0, start).padEnd(footer.length - tail.length) + tail;
  expect(nudgeVerdict(opencode, { ...screen, rows, styled: undefined })).toEqual({ ready: true });
  const noDollar = rows.map((row, i) => i === foot + 1 ? row.replace('$0.06', '0.06 ') : row);
  expect(nudgeVerdict(opencode, { ...screen, rows: noDollar, styled: undefined }).ready).toBe(false);
});

it('recognises the idle Plan composer', async () => {
  // A full repaint at 80 columns extended the hint ink across its right padding.
  const screen = await replay('welcome', '\x1b[20;59H\x1b[38;2;128;128;128m     \x1b[22;27HPlan · Example\x1b[K', true);
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: true });
});

it('recognises a healthy MCP count beside the welcome version', async () => {
  const screen = await replay('welcome', '\x1b[33;3H⊙ 1 MCP /mcps');
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: true });
  const unknown = await replay('welcome', '\x1b[33;3H⊙ 1 MCP /menu');
  expect(nudgeVerdict(opencode, unknown)).toEqual({ ready: false, reason: 'unknown' });
});

it('keeps the welcome input occupied when spaces hide its hint and the cursor returns Home', async () => {
  const screen = await replay('welcome', '\x1b[20;27H\x1b[K   \x1b[20;27H', true);
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: false, reason: 'draft' });
});

it('queues in Plan with the same complete interrupt footer', async () => {
  const screen = await replay('busy-start', '\x1b[31;6HPlan · Example\x1b[K\x1b[29;6H', true);
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: true, queued: true });
});

it.each(['welcome', 'idle'])('recognises the captured %s composer after a quiet period', async name => {
  // The serialised idle frame replays with its cursor in the left padding.
  const screen = await replay(name, name === 'idle' ? '\x1b[29;6H' : '');
  expect(nudgeVerdict(opencode, screen)).toEqual({ ready: true });
  expect(nudgeVerdict(opencode, { ...screen, exactEmpty: true })).toEqual({ ready: true });
  expect(nudgeVerdict(opencode, { ...screen, unchangedMs: 0 })).toEqual({ ready: false, reason: 'quiet' });
});

it('requires the complete suggestion in placeholder ink', async () => {
  const screen = await replay('welcome');
  const styled = screen.styled.map(line => line.text.includes(hint) ? { ...line, spans: line.spans.map(span =>
    span.fg === '#808080' ? { ...span, fg: '#eeeeee' } : span) } : line);
  expect(nudgeVerdict(opencode, { ...screen, styled })).toEqual({ ready: false, reason: 'draft' });
  expect(nudgeVerdict(opencode, { ...screen, styled: undefined })).toEqual({ ready: false, reason: 'draft' });
  const broken = screen.styled.map(line => ({ ...line, text: line.text.replace(hint, hint.slice(0, -1) + '!') }));
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
  splitWord[at] = '  ┃  ' + 'x'.repeat(111);
  splitWord[at + 1] = '  ┃  ' + 'x'.repeat(59);
  expect(nudgeVerdict(opencode, { ...screen, rows: splitWord, styled: undefined, expectedDraft: 'x'.repeat(170) }))
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
    const styled = rows.map((text, i) => ({ ...screen.styled[i], text, spans: screen.styled[i]?.spans ?? [] }));
    expect(nudgeVerdict(opencode, { ...screen, rows, styled })).toEqual({ ready: false, reason: 'unknown' });
  }
});

it('blocks a running turn and a question panel while messages wait', async () => {
  const screen = await replay('idle');
  const rows = [(await replay('busy-start')).rows[0]!, ...screen.rows.slice(1)];
  expect(nudgeVerdict(opencode, { ...screen, rows, styled: undefined, composerUnchangedMs: NUDGE_QUIET_MS }))
    .toEqual({ ready: false, reason: 'busy' });
  const running = screen.rows.map(row => row.includes('ctrl+p commands')
    ? '   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt                 0.0K (0%)  ctrl+p commands' : row);
  expect(nudgeVerdict(opencode, { ...screen, rows: running, styled: undefined, expectedDraft: draft }).ready).toBe(false);
  const panel = ['  ┃  Questions', '  ┃', '  ┃  Which colour?', '  ┃', '  ┃  1. Blue',
    '  ┃  2. Type your own answer', '  ┃', '  ┃  ↑↓ select  enter submit  esc dismiss'];
  expect(nudgeVerdict(opencode, { ...screen, rows: [...screen.rows, ...panel], styled: undefined }))
    .toEqual({ ready: false, reason: 'prompt' });
});

it('gives the clipped question and permission dialog precedence before typing and before Enter', async () => {
  const renderer = new ScreenRenderer({ agent: 'opencode', cols: 80, rows: 24 });
  try {
    await renderer.write(readFileSync(join(fixtures, '..', 'dialogs', 'opencode-question-live-transcript.ansi'), 'utf8'));
    const styled = renderer.styledLines().lines;
    const permission = readFileSync(join(fixtures, '..', 'dialogs', 'opencode-permission-dialog.txt'), 'utf8').split(/\r?\n/u);
    for (const screen of [{ rows: styled.map(line => line.text), styled }, { rows: permission }]) {
      for (const expectedDraft of [undefined, draft]) {
        expect(nudgeVerdict(opencode, { ...screen, expectedDraft, viewportRows: 24, unchangedMs: NUDGE_QUIET_MS }))
          .toEqual({ ready: false, reason: 'prompt' });
      }
    }
  } finally {
    await renderer.dispose();
  }
});

it.each(['busy-start', 'busy-entered'])('queues on the captured %s footer after the composer settles', async name => {
  const screen = { ...await replay(name, '\x1b[29;6H'), unchangedMs: 0 };
  expect(opencode.nudge!.readiness(screen)).toBe('queue');
  for (const composerUnchangedMs of [undefined, NUDGE_QUIET_MS - 1]) {
    expect(nudgeVerdict(opencode, { ...screen, composerUnchangedMs })).toEqual({ ready: false, reason: 'quiet' });
  }
  expect(nudgeVerdict(opencode, { ...screen, composerUnchangedMs: NUDGE_QUIET_MS })).toEqual({ ready: true, queued: true });
});

it('requires the whole busy footer and frame, with no panel below', async () => {
  const screen = await replay('busy-start', '\x1b[29;6H');
  const foot = screen.rows.findIndex(row => row.includes('╹▀'));
  const footer = screen.rows[foot + 1]!;
  const idle = await replay('idle');
  const altered = (index: number, text: string) => screen.rows.map((row, i) => index === i ? text : row);
  const permission = readFileSync(join(fixtures, '..', 'dialogs', 'opencode-permission-dialog.txt'), 'utf8').split(/\r?\n/u);
  for (const rows of [
    altered(foot - 4, ''), altered(foot - 2, ' ┃'), altered(foot - 1, '  ┃  Unknown · Example'),
    altered(foot, '  ╹▀'), altered(foot + 1, footer.slice(1)), altered(foot + 1, footer.replace('⬝⬝', '')),
    altered(foot + 1, footer.replace('esc interrupt', 'esc dismiss')), altered(foot + 1, footer.replace('ctrl+p commands', 'enter allow')),
    altered(foot + 1, footer + '  Allow once'), [...screen.rows, '', 'Other panel'],
    [...screen.rows, ...permission], [...screen.rows, '  ┃  Questions', '  ┃  1. Blue', '  ┃  2. Green'],
    // The tab spinner alone can signal work but cannot authorise typing.
    [screen.rows[0]!, ...idle.rows.slice(1)],
  ]) {
    const styled = rows.map((text, i) => ({ ...screen.styled[i], text, spans: screen.styled[i]?.spans ?? [] }));
    const view = { ...screen, rows, styled, viewportRows: rows.length };
    expect(nudgeVerdict(opencode, view).ready).toBe(false);
    expect(nudgeVerdict(opencode, { ...view, expectedDraft: draft }).ready).toBe(false);
  }
});

it('protects a busy draft and confirms only the complete daemon line before Enter', async () => {
  const busy = await replay('busy-entered');
  const wrapped = await replay('wrapped');
  const footer = busy.styled.find(row => row.text.includes('esc interrupt'))!;
  const styled = wrapped.styled.map(row => row.text.includes('ctrl+p commands') ? footer : row);
  const rows = styled.map(row => row.text);
  const view = { ...wrapped, rows, styled, unchangedMs: 0 };
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
  expect(key(rows, { x: 5, y: 28 })).not.toBe(key(rows, { x: 8, y: 28 }));
  expect(key(changed(0, 'New tab spinner'))).toBe(key(rows));
  expect(key(changed(foot + 1, rows[foot + 1]!.replace('⬝⬝⬝⬝', '■■■■')))).toBe(key(rows));
  for (const index of [foot - 4, foot - 3, foot - 2, foot - 1, foot, foot + 1]) {
    expect(key(changed(index, rows[index] + 'x'))).not.toBe(key(rows));
  }
  expect(key([...rows, 'Approve access'])).not.toBe(key(rows));
});
