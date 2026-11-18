/**
 * Whether a session is idle with an empty composer. Fixtures are the captured
 * screens already used for reading, plus prompt transcripts recorded with the
 * prompt detector. A case named synthetic is not a captured screen.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agy } from '../../src/agents/agy/index.js';
import { claude } from '../../src/agents/claude/index.js';
import { codex } from '../../src/agents/codex/index.js';
import { generic } from '../../src/agents/generic/index.js';
import { muse } from '../../src/agents/muse/index.js';
import { qoder } from '../../src/agents/qoder/index.js';
import type { AgentModule, NudgeReadiness } from '../../src/agents/types.js';
import { NUDGE_QUIET_MS, nudgeVerdict } from '../../src/core/nudge.js';
import type { NudgeObservation } from '../../src/core/nudge.js';
import { ScreenRenderer } from '../../src/core/renderer.js';
import type { StyledLine } from '../../src/core/renderer.js';
import type { StallState } from '../../src/core/types.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'reasoning');

const STALL: StallState = {
  reason: 'refused',
  description: 'The provider refused the request.',
  since: '2026-01-01T00:00:00.000Z',
};

async function load(name: string): Promise<NudgeObservation> {
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as {
    cols: number;
    rows: number;
  };
  const renderer = new ScreenRenderer({ cols: meta.cols, rows: meta.rows });
  await renderer.write(fs.readFileSync(path.join(FIXTURES, `${name}.ansi`), 'utf8'));
  const styled = renderer.styledLines({ last: 2000 }).lines;
  await renderer.dispose();
  return { rows: styled.map((line) => line.text), styled, viewportRows: meta.rows, unchangedMs: NUDGE_QUIET_MS };
}

function plain(screen: string): NudgeObservation {
  const rows = screen.split('\n');
  return { rows, viewportRows: rows.length, unchangedMs: NUDGE_QUIET_MS };
}

function fromRows(rows: readonly string[]): NudgeObservation {
  return { rows, viewportRows: rows.length, unchangedMs: NUDGE_QUIET_MS };
}

const INK = { bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null };

/** Replace the last composer row and paint the whole row in one ink. */
function replaceComposer(
  lines: readonly StyledLine[],
  pattern: RegExp,
  text: string,
  style: Partial<StyledLine['spans'][number]>,
): StyledLine[] {
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.wrapped !== true && pattern.test(line.text)) {
      index = i;
      break;
    }
  }
  if (index < 0) throw new Error(`no composer row matching ${pattern}`);
  const spans = text.length === 0 ? [] : [{ from: 0, to: text.length, ...INK, ...style }];
  return lines.map((line, i) => (i === index ? { ...line, text, spans } : line));
}

function readinessOf(module: AgentModule, observation: NudgeObservation): NudgeReadiness {
  const nudge = module.nudge;
  if (nudge === undefined) throw new Error(`${module.name} has no nudge judgement`);
  return nudge.readiness(observation);
}

/** Replace placeholder words on a captured composer row and keep its ink. */
function rewriteBody(lines: readonly StyledLine[], pattern: RegExp, from: string, to: string): StyledLine[] {
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.wrapped !== true && pattern.test(line.text) && line.text.includes(from)) {
      index = i;
      break;
    }
  }
  if (index < 0) throw new Error(`no captured row containing ${from}`);
  return lines.map((line, i) => {
    if (i !== index) return line;
    const text = line.text.replace(from, to);
    const delta = text.length - line.text.length;
    const spans = line.spans.map((span, spanIndex) =>
      spanIndex === line.spans.length - 1 ? { ...span, to: span.to + delta } : span);
    return { ...line, text, spans };
  });
}

/** Claude Code's folder-trust prompt, captured verbatim with the prompt detector. */
const CLAUDE_CODE_TRUST_PROMPT = `
──────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 D:\\work\\demo

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in
 this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

/** A two-row composer draft, recorded with the prompt detector. */
const CLAUDE_CODE_DRAFT = `
● What would you like me to work on?

✻ Cooked for 3s · done 20:45





────────────────────────────────────────────────────────────────────────────────
❯\u00a0Thanks. Please reply with one short sentence about spring weather, and keep
  the whole reply under ten words.

────────────────────────────────────────────────────────────────────────────────
  Opus 5 ░░░░░░░░░░ 4%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

/** Idle Claude Code, captured verbatim: the suggestion sits above the status line. */
const CLAUDE_CODE_SUGGESTION = `
● Do you want me to continue with the migration?

──────────────────────────────────────────────────────────────────────────
❯ Try "write a test for <filepath>"
──────────────────────────────────────────────────────────────────────────
  ? for shortcuts
`;

/** Codex exec approval, captured verbatim with the prompt detector. */
const CODEX_EXEC_PROMPT = `
• Running $specs=@(@('src/File.cs',87,220)); foreach($s in $specs){ ... }

  Would you like to run the following command?

  Environment: local

  $ $specs=@(@('src/File.cs',87,220)); foreach($s in $specs){$f=$s[0];$a=[int]$s[1];$b=[int]$s[2];Write-Output "FILE:$f";
  $n=0;Get-Content -LiteralPath $f|ForEach-Object{$n++;if($n -ge $a -and $n -le $b){'{0,4}: {1}' -f $n,$_}}}

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`$specs=@(@('src/File.cs',87,220));
     foreach($s in $specs){$f=$s[0];$a=[int]$s[1];$b=[int]$s[2];Write-Output "FILE:$f";$n=0;
     Get-Content -LiteralPath $f|ForEach-Object{...}}\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`;

/** The Qoder Bash permission prompt, captured verbatim with the prompt detector. */
const QODER_BASH_PROMPT = `
 ▪ Read(...\\StoreTests.cs)
   └ Read 160 lines

 ? Bash(cd "D:\\work" && find src -type d && echo hi)

 Permission Required
────────────────────────────────────────────────────────────────────────────
 Tool: Bash

 Run baseline test suite
 Command: cd "D:\\work" && dotnet test src/Tests.csproj --nologo

 Allow this command to run? Redirection detected.

  ❯ 1. Allow once
    2. Always allow this exact command for future sessions [local]
    3. Reject and type something
    4. No
`;

describe('nudge readiness', () => {
  describe('Claude Code', () => {
    it('is ready on a captured idle screen with an empty composer', async () => {
      const screen = await load('claude-answered');
      expect(readinessOf(claude, screen)).toBe('ready');
      expect(nudgeVerdict(claude, screen)).toEqual({ ready: true });
    });

    it('finds an idle composer between full-width rules marked as wraps, with a title in the top rule', async () => {
      // Claude Code pads its rows to the full width, so xterm marks the
      // composer row and the rule under it as wraps. The top rule can carry the
      // session title in the same grey.
      const screen = await load('claude-answered');
      const rows = screen.styled!;
      const composerAt = rows.map((row) => row.text.startsWith('❯')).lastIndexOf(true);
      const top = rows[composerAt - 1]!;
      const titled = `${'─'.repeat(top.text.length - 12)} my-chair ─`;
      const marked = rows.map((row, i) => {
        if (i === composerAt - 1) return { ...row, text: titled };
        return i === composerAt || i === composerAt + 1 ? { ...row, wrapped: true } : row;
      });
      const view = { ...screen, rows: marked.map((row) => row.text), styled: marked };
      expect(nudgeVerdict(claude, view)).toEqual({ ready: true });
      // The same rules in typed ink are not the frame.
      const typed = marked.map((row, i) => (i === composerAt - 1 || i === composerAt + 1
        ? { ...row, spans: row.spans.map((span) => ({ ...span, fg: null })) }
        : row));
      expect(nudgeVerdict(claude, { ...view, styled: typed }).ready).toBe(false);
    });

    it('treats the recorded suggestion phrase without its dim ink as a draft', () => {
      const screen = plain(CLAUDE_CODE_SUGGESTION);
      expect(readinessOf(claude, screen)).toBe('draft');
      expect(nudgeVerdict(claude, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('treats the recorded suggestion phrase as empty when the captured composer draws it dim', async () => {
      const screen = await load('claude-answered');
      const text = '❯ Try "write a test for <filepath>"';
      const styled = replaceComposer(screen.styled ?? [], /^❯/u, text, { dim: true });
      const next = { ...screen, rows: styled.map((line) => line.text), styled };
      expect(readinessOf(claude, next)).toBe('ready');
      expect(nudgeVerdict(claude, next)).toEqual({ ready: true });
    });

    it('treats the recorded suggestion phrase in typed ink as a draft', async () => {
      const screen = await load('claude-answered');
      const text = '❯ Try "write a test for <filepath>"';
      const styled = replaceComposer(screen.styled ?? [], /^❯/u, text, { dim: false });
      expect(readinessOf(claude, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('draft');
    });

    it('treats a suggested next prompt drawn dim on the captured composer as empty', async () => {
      const screen = await load('claude-answered');
      const styled = replaceComposer(screen.styled ?? [], /^❯/u, '❯ how is the review getting on?', { dim: true });
      const next = { ...screen, rows: styled.map((line) => line.text), styled };
      expect(readinessOf(claude, next)).toBe('ready');
      expect(nudgeVerdict(claude, next)).toEqual({ ready: true });
    });

    it('treats the same words in typed ink as a draft', async () => {
      const screen = await load('claude-answered');
      const styled = replaceComposer(screen.styled ?? [], /^❯/u, '❯ how is the review getting on?', { dim: false });
      expect(readinessOf(claude, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('draft');
    });

    it('treats a suggestion marked as a wrap, between wrapped rules, as empty', async () => {
      // Seen live: the padded composer row carries the suggestion and is marked as a wrap.
      const screen = await load('claude-answered');
      const replaced = replaceComposer(screen.styled ?? [], /^❯/u, '❯ how is the review getting on?', { dim: true });
      const composerAt = replaced.map((row) => row.text.startsWith('❯')).lastIndexOf(true);
      const marked = replaced.map((row, i) => (i === composerAt || i === composerAt + 1 ? { ...row, wrapped: true } : row));
      expect(nudgeVerdict(claude, { ...screen, rows: marked.map((line) => line.text), styled: marked })).toEqual({ ready: true });
    });

    it('synthetic: an empty composer row with a draft on the following rows is a draft', () => {
      const screen = fromRows([
        '❯',
        '  draft typed here',
        '────────────────────────────────────────────────────────────────────────────────',
        '  Opus 5.5',
      ]);
      expect(readinessOf(claude, screen)).toBe('draft');
      expect(nudgeVerdict(claude, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('reads a captured draft as a draft', async () => {
      const screen = await load('claude-prompt-typed');
      expect(readinessOf(claude, screen)).toBe('draft');
      expect(nudgeVerdict(claude, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('reads the recorded two-row draft as a draft', () => {
      expect(readinessOf(claude, plain(CLAUDE_CODE_DRAFT))).toBe('draft');
    });

    it('is busy while a captured turn is thinking or calling a tool', async () => {
      expect(readinessOf(claude, await load('claude-thinking'))).toBe('busy');
      expect(readinessOf(claude, await load('claude-tool-call-running'))).toBe('busy');
    });

    it('does not treat a captured transcript echo as an empty composer', async () => {
      expect(readinessOf(claude, await load('claude-transcript-view'))).toBe('draft');
    });

    it('is not ready while the recorded trust prompt is open', () => {
      expect(nudgeVerdict(claude, plain(CLAUDE_CODE_TRUST_PROMPT))).toEqual({ ready: false, reason: 'prompt' });
    });
  });

  describe('Codex', () => {
    it('is ready on a captured idle screen whose composer is the dim placeholder', async () => {
      const screen = await load('codex-answered');
      expect(screen.rows.some((row) => row.includes('? for shortcuts'))).toBe(true);
      expect(readinessOf(codex, screen)).toBe('ready');
      expect(nudgeVerdict(codex, screen)).toEqual({ ready: true });
    });

    it('treats other dim words on the captured composer as a draft', async () => {
      const screen = await load('codex-answered');
      const styled = rewriteBody(screen.styled ?? [], /^› /u, 'Ask Codex to do anything', 'Other dim words');
      expect(readinessOf(codex, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('draft');
    });

    it('treats the recorded placeholder in typed ink as a draft', async () => {
      const screen = await load('codex-answered');
      const styled = replaceComposer(screen.styled ?? [], /^› /u, '› Ask Codex to do anything', { dim: false });
      expect(readinessOf(codex, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('draft');
    });

    it('synthetic: a blank composer row with text on the following rows is unknown', () => {
      const screen = fromRows([
        '› ',
        '  the draft starts here',
        '  and continues',
        '',
        '  GPT-6-Sol high · Context 99% left · weekly 76% left · example',
        '  ? for shortcuts',
      ]);
      expect(readinessOf(codex, screen)).toBe('unknown');
      expect(nudgeVerdict(codex, screen)).toEqual({ ready: false, reason: 'unknown' });
    });

    it('synthetic: draft text shaped like the status row, above the real footer, is not the footer', () => {
      const screen = fromRows([
        '› ',
        '  GPT-6-Sol high · Context 99% left · weekly 76% left: explain these limits',
        '',
        '  GPT-6-Sol high · Context 99% left · weekly 76% left · Summary',
        '  ? for shortcuts',
      ]);
      expect(readinessOf(codex, screen)).not.toBe('ready');
      expect(nudgeVerdict(codex, screen).ready).toBe(false);
    });

    it('synthetic: the current footer with an agents hint still ends the composer', () => {
      const screen = fromRows([
        '› ',
        '',
        '  GPT-6-Sol high · Context 99% left · weekly 56% left · Daybreak on',
        '  ← for agents · ? for shortcuts',
      ]);
      expect(readinessOf(codex, screen)).toBe('ready');
    });

    it('synthetic: the shortcuts status under a blank composer is not a draft', () => {
      const screen = fromRows(['› ', '', '  ? for shortcuts']);
      expect(readinessOf(codex, screen)).toBe('ready');
      expect(nudgeVerdict(codex, screen)).toEqual({ ready: true });
    });

    it('synthetic: before Enter, accepts the daemon line wrapped across composer rows and nothing else', () => {
      const line = '[ShellPuppet] Message m1 from chair-2 is waiting. Read it with the session_inbox tool, ' +
        'or run: node "C:\\tools\\shellpuppet\\cli.js" inbox';
      const footer = ['', '  GPT-6-Sol high · Context 99% left · weekly 56% left · Daybreak on', '  ? for shortcuts'];
      const wrapped = fromRows([
        '› [ShellPuppet] Message m1 from chair-2 is waiting. Read it with the session_inbox',
        '  tool, or run: node "C:\\tools\\shellpuppet\\cli.js" inbox',
        ...footer,
      ]);
      const check = (screen: NudgeObservation, expectedDraft: string) =>
        nudgeVerdict(codex, { ...screen, unchangedMs: 0, expectedDraft });
      expect(check(wrapped, line)).toEqual({ ready: true });
      expect(readinessOf(codex, wrapped)).toBe('unknown');
      expect(check(wrapped, line + ' more')).toEqual({ ready: false, reason: 'draft' });
      expect(check(wrapped, line.replace('m1', 'm2'))).toEqual({ ready: false, reason: 'draft' });
      const extraRow = fromRows([
        '› [ShellPuppet] Message m1 from chair-2 is waiting. Read it with the session_inbox',
        '  tool, or run: node "C:\\tools\\shellpuppet\\cli.js" inbox',
        '  and a person typed this too',
        ...footer,
      ]);
      expect(check(extraRow, line)).toEqual({ ready: false, reason: 'draft' });
      const below = fromRows([
        '› [ShellPuppet] Message m1 from chair-2 is waiting. Read it with the session_inbox',
        '  tool, or run: node "C:\\tools\\shellpuppet\\cli.js" inbox',
        '  /status   show current session configuration',
        ...footer,
      ]);
      expect(check(below, line)).toEqual({ ready: false, reason: 'draft' });
      const extraIndent = fromRows([
        '› [ShellPuppet] Message m1 from chair-2 is waiting. Read it with the session_inbox',
        '   tool, or run: node "C:\\tools\\shellpuppet\\cli.js" inbox',
        ...footer,
      ]);
      expect(check(extraIndent, line)).toEqual({ ready: false, reason: 'draft' });
      const extraLead = fromRows([
        '›  [ShellPuppet] Message m1 from chair-2 is waiting. Read it with the session_inbox',
        '  tool, or run: node "C:\\tools\\shellpuppet\\cli.js" inbox',
        ...footer,
      ]);
      expect(check(extraLead, line)).toEqual({ ready: false, reason: 'draft' });
      const blankBetween = fromRows([
        '› [ShellPuppet] Message m1 from chair-2 is waiting. Read it with the session_inbox',
        '',
        '  tool, or run: node "C:\\tools\\shellpuppet\\cli.js" inbox',
        ...footer,
      ]);
      expect(check(blankBetween, line)).toEqual({ ready: false, reason: 'draft' });
    });

    it('reads a captured draft as a draft', async () => {
      const screen = await load('codex-prompt-typed');
      expect(screen.rows.some((row) => row.length > 80)).toBe(true);
      expect(readinessOf(codex, screen)).toBe('draft');
      expect(nudgeVerdict(codex, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('is busy while a captured turn is working', async () => {
      expect(readinessOf(codex, await load('codex-working'))).toBe('busy');
    });

    it('is not ready while the recorded exec prompt is open', () => {
      expect(nudgeVerdict(codex, plain(CODEX_EXEC_PROMPT))).toEqual({ ready: false, reason: 'prompt' });
    });
  });

  describe('Qoder', () => {
    it('is ready on a captured idle screen with the grey placeholder and the shortcuts status', async () => {
      const screen = await load('qoder-answered-first-turn');
      expect(screen.rows.some((row) => row.includes('? for shortcuts'))).toBe(true);
      expect(readinessOf(qoder, screen)).toBe('ready');
      expect(nudgeVerdict(qoder, screen)).toEqual({ ready: true });
    });

    it('treats other grey words on the captured composer as a draft', async () => {
      const screen = await load('qoder-answered-first-turn');
      const styled = rewriteBody(screen.styled ?? [], /^ > /u, 'Type your message or @path/to/file', 'Other grey words');
      expect(readinessOf(qoder, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('draft');
    });

    it('treats the recorded placeholder in typed ink as a draft', async () => {
      const screen = await load('qoder-answered-first-turn');
      const styled = replaceComposer(screen.styled ?? [], /^ > /u, ' > Type your message or @path/to/file', { fg: null });
      expect(readinessOf(qoder, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('draft');
    });

    it('synthetic: an empty composer row with a draft on the following rows is a draft', () => {
      const screen = fromRows([
        ' > ',
        '  draft typed here',
        '────────────────────────────────────────────────────────────────────────────────',
        '  GLM-5.3',
      ]);
      expect(readinessOf(qoder, screen)).toBe('draft');
      expect(nudgeVerdict(qoder, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('reads a captured draft as a draft', async () => {
      const screen = await load('qoder-prompt-typed');
      expect(readinessOf(qoder, screen)).toBe('draft');
      expect(nudgeVerdict(qoder, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('is busy while a captured turn is working, even with the placeholder still drawn', async () => {
      const screen = await load('qoder-working');
      expect(screen.rows.some((row) => row.includes('Type your message'))).toBe(true);
      expect(readinessOf(qoder, screen)).toBe('busy');
      expect(nudgeVerdict(qoder, screen)).toEqual({ ready: false, reason: 'busy' });
    });

    it('is not ready while the recorded bash prompt is open', () => {
      expect(nudgeVerdict(qoder, plain(QODER_BASH_PROMPT))).toEqual({ ready: false, reason: 'prompt' });
    });
  });

  describe('Muse Code', () => {
    it('accepts only the exact daemon line already held in a delayed composer', () => {
      const line = '[ShellPuppet] Message m1 is waiting.';
      const screen = fromRows(['❯ ' + line, '────────────────────────────────────────────────────────────────────────────────']);
      expect(nudgeVerdict(muse, { ...screen, unchangedMs: 0, expectedDraft: line })).toEqual({ ready: true });
      expect(nudgeVerdict(muse, { ...screen, unchangedMs: 0, expectedDraft: line + ' extra' }))
        .toEqual({ ready: false, reason: 'draft' });
      const wrapped = fromRows(['❯ [ShellPuppet] Message m1', '  is waiting.',
        '────────────────────────────────────────────────────────────────────────────────']);
      expect(nudgeVerdict(muse, { ...wrapped, unchangedMs: 0, expectedDraft: line })).toEqual({ ready: true });
    });
    it('before Enter, accepts a captured daemon line wrapped above a frame row marked as a wrap', async () => {
      const line = '[ShellPuppet] Message m1 from chair-mute is waiting. Read it with the session_inbox tool, ' +
        'or run: node "C:\\tools\\example\\shellpuppet-cli-xyzx\\dist\\cli\\index.js" inbox';
      const screen = await load('muse-nudge-wrapped');
      const frameAt = screen.styled!.findIndex((row, i) => i > 0 && /^─{10,}$/u.test(row.text.trimEnd()) &&
        screen.styled![i - 1]!.text.includes('inbox'));
      expect(screen.styled![frameAt]!.wrapped).toBe(true);
      const check = (view: NudgeObservation, expectedDraft: string) =>
        nudgeVerdict(muse, { ...view, unchangedMs: 0, expectedDraft });
      expect(check(screen, line)).toEqual({ ready: true });
      expect(check(screen, line.replace('m1', 'm2'))).toEqual({ ready: false, reason: 'draft' });
      expect(check(screen, line + ' more')).toEqual({ ready: false, reason: 'draft' });
      // The same row in typed ink is text in the draft, not the frame.
      const styled = screen.styled!.map((row, i) => (i === frameAt
        ? { ...row, spans: row.spans.map((span) => ({ ...span, dim: false, fg: '#ccd3db' })) }
        : row));
      expect(check({ ...screen, rows: styled.map((row) => row.text), styled }, line))
        .toEqual({ ready: false, reason: 'draft' });
    });
    it('finds an idle composer when every row after a reply is marked as a wrap', async () => {
      // Muse pads its rows to the full width once the transcript has text, so
      // xterm marks nearly every row as a wrap, the rule above the composer too.
      // The row under the short composer line is the only one left unmarked,
      // as in the captured screens.
      const screen = await load('muse-violet');
      const composerAt = screen.styled!.map((row) => row.text.startsWith('❯')).lastIndexOf(true);
      expect(composerAt).toBeGreaterThan(0);
      const marked = screen.styled!.map((row, i) => (i === 0 || i === composerAt + 1 ? row : { ...row, wrapped: true }));
      const view = { ...screen, rows: marked.map((row) => row.text), styled: marked };
      expect(nudgeVerdict(muse, view)).toEqual({ ready: true });
      // The rule in typed ink is draft text, never the frame.
      const ruleAt = marked.findIndex((row) => row.text.startsWith('── Voice input'));
      expect(ruleAt).toBeGreaterThan(0);
      const typed = marked.map((row, i) => (i === ruleAt
        ? { ...row, spans: row.spans.map((span) => ({ ...span, dim: false, fg: '#ccd3db' })) }
        : row));
      expect(nudgeVerdict(muse, { ...view, styled: typed }).ready).toBe(false);
    });

    it('treats a rotating grey tip as an empty composer, and the same words in typed ink as a draft', async () => {
      const screen = await load('muse-violet');
      const tip = '❯ /resume reopens a past session (--last for the latest)';
      const grey = replaceComposer(screen.styled ?? [], /^❯\s*$/u, tip, { fg: '#676c74' });
      expect(nudgeVerdict(muse, { ...screen, rows: grey.map((row) => row.text), styled: grey })).toEqual({ ready: true });
      const typed = replaceComposer(screen.styled ?? [], /^❯\s*$/u, tip, { fg: '#ccd3db' });
      expect(nudgeVerdict(muse, { ...screen, rows: typed.map((row) => row.text), styled: typed }))
        .toEqual({ ready: false, reason: 'draft' });
    });

    it('finds an idle composer when the plain rule under it is marked as a wrap too', async () => {
      const screen = await load('muse-violet');
      const composerAt = screen.styled!.map((row) => row.text.startsWith('❯')).lastIndexOf(true);
      const marked = screen.styled!.map((row, i) => (i > 0 ? { ...row, wrapped: true } : row));
      expect(marked[composerAt + 1]!.text.startsWith('─')).toBe(true);
      expect(nudgeVerdict(muse, { ...screen, rows: marked.map((row) => row.text), styled: marked })).toEqual({ ready: true });
    });

    it('is ready on a captured idle screen with a bare composer', async () => {
      const screen = await load('muse-violet');
      expect(readinessOf(muse, screen)).toBe('ready');
      expect(nudgeVerdict(muse, screen)).toEqual({ ready: true });
    });

    it('treats the captured grey hint as an empty composer', async () => {
      const screen = await load('live96-3-done-composer-hint');
      expect(readinessOf(muse, screen)).toBe('ready');
      expect(nudgeVerdict(muse, screen)).toEqual({ ready: true });
    });

    it('treats other words in the hint grey on the captured composer as an empty composer', async () => {
      // Muse Code rotates its grey tips; only typed ink makes a draft. Before
      // Enter, the nudge still checks that the composer holds exactly its line.
      const screen = await load('live96-3-done-composer-hint');
      const styled = rewriteBody(
        screen.styled ?? [],
        /^❯/u,
        'Start a message with ! to run a shell command yourself',
        'Other grey words',
      );
      expect(readinessOf(muse, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('ready');
    });

    it('treats the recorded hint in typed ink as a draft', async () => {
      const screen = await load('live96-3-done-composer-hint');
      const text = '❯ Start a message with ! to run a shell command yourself';
      const styled = replaceComposer(screen.styled ?? [], /^❯/u, text, { fg: '#ccd3db' });
      expect(readinessOf(muse, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('draft');
    });

    it('synthetic: an empty composer row with a draft on the following rows is a draft', () => {
      const screen = fromRows([
        '❯',
        '  draft typed here',
        '────────────────────────────────────────────────────────────────────────────────',
        '  muse-wonder-full-1.0',
      ]);
      expect(readinessOf(muse, screen)).toBe('draft');
      expect(nudgeVerdict(muse, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('reads a captured draft that wraps over several rows as a draft', async () => {
      const screen = await load('live96-1-composer-typed');
      expect(readinessOf(muse, screen)).toBe('draft');
      expect(nudgeVerdict(muse, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('is busy while a captured turn is thinking', async () => {
      expect(readinessOf(muse, await load('muse-busy-first'))).toBe('busy');
    });

    it('is not ready while a captured approval menu is open', async () => {
      const screen = await load('muse-approval');
      expect(readinessOf(muse, screen)).not.toBe('ready');
      expect(nudgeVerdict(muse, screen)).toEqual({ ready: false, reason: 'prompt' });
    });
  });

  describe('combiner', () => {
    it('names the quiet period', () => {
      expect(NUDGE_QUIET_MS).toBe(1_500);
    });

    it('waits out a quiet period on an otherwise ready screen', async () => {
      const screen = await load('claude-answered');
      expect(nudgeVerdict(claude, { ...screen, unchangedMs: NUDGE_QUIET_MS - 1 })).toEqual({ ready: false, reason: 'quiet' });
      expect(nudgeVerdict(claude, { ...screen, unchangedMs: NUDGE_QUIET_MS })).toEqual({ ready: true });
    });

    it('does not treat a negative or non-finite quiet period as elapsed', async () => {
      const screen = await load('claude-answered');
      for (const unchangedMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(nudgeVerdict(claude, { ...screen, unchangedMs })).toEqual({ ready: false, reason: 'quiet' });
      }
    });

    it('does not let a short quiet period hide a draft', async () => {
      const screen = await load('claude-prompt-typed');
      expect(nudgeVerdict(claude, { ...screen, unchangedMs: 0 })).toEqual({ ready: false, reason: 'draft' });
    });

    it('stays unready while a stall has settled, and a waiting prompt outranks that stall', async () => {
      const screen = await load('claude-answered');
      expect(nudgeVerdict(claude, { ...screen, stall: STALL })).toEqual({ ready: false, reason: 'stalled' });
      expect(nudgeVerdict(claude, { ...plain(CLAUDE_CODE_TRUST_PROMPT), stall: STALL })).toEqual({ ready: false, reason: 'prompt' });
    });

    it('leaves a module that cannot judge the composer unknown, even with a prompt, a stall and a long quiet period', () => {
      const screen = { ...plain(CLAUDE_CODE_TRUST_PROMPT), stall: STALL, unchangedMs: 60_000 };
      for (const module of [generic]) {
        expect(module.nudge).toBeUndefined();
        expect(nudgeVerdict(module, screen)).toEqual({ ready: false, reason: 'unknown' });
      }
      expect(nudgeVerdict(undefined, screen)).toEqual({ ready: false, reason: 'unknown' });
    });

    it('synthetic negative control: arbitrary composer text is not ready', () => {
      const screen = plain('❯ hello from a synthetic composer');
      expect(readinessOf(claude, screen)).toBe('draft');
      expect(nudgeVerdict(claude, screen)).toEqual({ ready: false, reason: 'draft' });
    });

    it('synthetic: a finished spinner above the last echoed prompt leaves the empty composer ready', async () => {
      const screen = await load('claude-answered');
      const styled = (screen.styled ?? []).map((line) => ({ ...line }));
      let echo = -1;
      for (let i = styled.length - 1; i >= 0; i--) {
        if (/^❯ \S/u.test(styled[i]?.text ?? '')) {
          echo = i;
          break;
        }
      }
      if (echo <= 0) throw new Error('no echoed turn above the composer');
      const text = '✻ Pondering… (2s · thinking)';
      styled[echo - 1] = {
        text,
        spans: [{ from: 0, to: text.length, ...INK }],
      };
      const next = { ...screen, styled, rows: styled.map((line) => line.text) };
      expect(styled[echo - 1]?.text).toMatch(/^✻ \S+…/u);
      expect(readinessOf(claude, next)).toBe('ready');
      expect(nudgeVerdict(claude, next)).toEqual({ ready: true });
    });

    it('does not judge a viewport whose plain rows and styled rows disagree', async () => {
      const screen = await load('claude-answered');
      const rows = screen.rows.map((row, index) => (index === screen.rows.length - 1 ? `${row}x` : row));
      const mismatched = { ...screen, rows };
      expect(readinessOf(claude, mismatched)).toBe('unknown');
      expect(nudgeVerdict(claude, mismatched)).toEqual({ ready: false, reason: 'unknown' });
    });
  });
});

describe('composer under a full-width rule', () => {
  // As captured from Muse Code 1.4.14: a rule across the whole width, then the
  // composer painted with no line break, so xterm marks the composer row as a
  // wrap. The composer row itself ends with a line break.
  async function painted(cols: number, composer: string): Promise<NudgeObservation> {
    const rule = (label: string) => label + '─'.repeat(cols - label.length);
    const stream = '  Muse Code 1.4.14\r\n\r\n' +
      '\u001b[2;38;2;103;108;116m' + rule('── Voice input (Alt+V to start) ') + '\u001b[0m' +
      composer + '\r\n' +
      rule('') +
      '  muse-wonder-full-1.0 · high · C:\\work\\project · Launch overrides';
    const renderer = new ScreenRenderer({ cols, rows: 12 });
    await renderer.write(stream);
    const styled = renderer.styledLines({ last: 2000 }).lines;
    await renderer.dispose();
    return { rows: styled.map((line) => line.text), styled, viewportRows: 12, unchangedMs: NUDGE_QUIET_MS };
  }

  it.each([80, 152])('finds the empty composer at %i columns', async (cols) => {
    const view = await painted(cols, '❯');
    expect(view.styled?.find((line) => line.text.startsWith('❯'))?.wrapped).toBe(true);
    expect(muse.nudge?.readiness(view)).toBe('ready');
  });

  it('still reads a typed draft under the rule as a draft', async () => {
    expect(muse.nudge?.readiness(await painted(80, '❯ draft words not sent'))).toBe('draft');
  });

  it('keeps a long draft that wraps inside the composer as one draft', async () => {
    const view = await painted(40, `❯ ${'long draft '.repeat(5)}`.slice(0, 40) + 'continues past the edge');
    expect(muse.nudge?.readiness(view)).not.toBe('ready');
  });
});

describe('a wrapped row below rule-like text', () => {
  const lastRow = (screen: NudgeObservation, test: RegExp): number => {
    const texts = screen.styled!.map((line) => line.text);
    for (let i = texts.length - 1; i >= 0; i--) if (test.test(texts[i]!)) return i;
    return -1;
  };
  const row = (text: string, wrapped: boolean): StyledLine =>
    ({ text, spans: [{ from: 0, to: text.length, ...INK }], ...(wrapped ? { wrapped: true } : {}) });
  function splice(screen: NudgeObservation, at: number, remove: number, rows: StyledLine[]): NudgeObservation {
    const styled = [...(screen.styled ?? [])];
    styled.splice(at, remove, ...rows);
    return { ...screen, styled, rows: styled.map((line) => line.text) };
  }

  it('does not read a typed draft ending in chrome-like text as an empty composer', async () => {
    const screen = await load('claude-answered');
    const at = lastRow(screen, /^❯/u);
    const draft = `❯ draft words ${'x'.repeat(30)} /effort`;
    const view = splice(screen, at, 1, [row(draft, false), row('❯', true)]);
    expect(claude.nudge?.readiness(view)).not.toBe('ready');
  });

  it('does not read a busy turn as idle when the busy row is a wrap', async () => {
    const screen = await load('codex-answered');
    const at = lastRow(screen, /^\s*›/u);
    const composer = { ...screen.styled![at]!, wrapped: true };
    const view = splice(screen, at, 1, [row('output '.repeat(14), false),
      row('• Working (3s • esc to interrupt)', true), composer]);
    expect(codex.nudge?.readiness(view)).not.toBe('ready');
  });

  it('does not end a Muse draft at a rule-shaped wrap of the draft itself', async () => {
    const cols = 80;
    const stream = '  Muse Code 1.4.14\r\n\r\n' +
      '\u001b[2;38;2;103;108;116m' + `── Voice input (Alt+V to start) ${'─'.repeat(cols - 32)}` + '\u001b[0m' +
      `❯ ${'a'.repeat(cols - 2)}` + '─'.repeat(cols) + '❯\r\n' +
      '─'.repeat(cols) +
      '  muse-wonder-full-1.0 · high · C:\\work\\project · Launch overrides';
    const renderer = new ScreenRenderer({ cols, rows: 12 });
    await renderer.write(stream);
    const styled = renderer.styledLines({ last: 2000 }).lines;
    await renderer.dispose();
    const view = { rows: styled.map((line) => line.text), styled, viewportRows: 12, unchangedMs: NUDGE_QUIET_MS };
    expect(muse.nudge?.readiness(view)).not.toBe('ready');
  });
});

describe('typed text shaped like a rule row', () => {
  async function render(cols: number, stream: string): Promise<NudgeObservation> {
    const renderer = new ScreenRenderer({ cols, rows: 14 });
    await renderer.write(stream);
    const styled = renderer.styledLines({ last: 2000 }).lines;
    await renderer.dispose();
    return { rows: styled.map((line) => line.text), styled, viewportRows: 14, unchangedMs: NUDGE_QUIET_MS };
  }

  it('does not treat a typed rule in an Antigravity draft as its frame', async () => {
    const cols = 80;
    const view = await render(cols, '  ok\r\n' + '─'.repeat(cols) + '\r\n' +
      '> draft text\r\n' + '  ' + '─'.repeat(cols - 2) + '>\r\n' +
      '─'.repeat(cols) + '\r\n' + '? for shortcuts');
    expect(agy.nudge?.readiness(view)).not.toBe('ready');
  });

  it('does not treat a typed copy of the Muse voice rule as the real one', async () => {
    const cols = 80;
    const voice = `── Voice input (Alt+V to start) ${'─'.repeat(cols - 32)}`;
    const view = await render(cols, '  Muse Code 1.4.14\r\n\r\n' + voice + '❯ draft text\r\n' +
      voice + '❯\r\n' + '─'.repeat(cols) +
      '  muse-wonder-full-1.0 · high · C:\\work\\project · Launch overrides');
    expect(muse.nudge?.readiness(view)).not.toBe('ready');
  });
});

describe('a typed Muse voice rule after the real one has scrolled away', () => {
  it('does not unwrap below a rule drawn in typed ink', async () => {
    const cols = 80;
    const typed = '\u001b[38;2;204;211;219m';
    const voice = `── Voice input (Alt+V to start) ${'─'.repeat(cols - 32)}`;
    const draftRows = Array.from({ length: 14 }, (_, i) => `draft line ${String(i)}\r\n`).join('');
    const stream = '\u001b[2;38;2;103;108;116m' + voice + '\u001b[0m' + typed + '❯ ' + draftRows +
      voice + '❯' + '\u001b[0m\r\n' + '─'.repeat(cols) +
      '  muse-wonder-full-1.0 · high · C:\\work\\project · Launch overrides';
    const renderer = new ScreenRenderer({ cols, rows: 12 });
    await renderer.write(stream);
    const styled = renderer.styledLines({ last: 12 }).lines;
    await renderer.dispose();
    expect(styled.some((line) => line.text.startsWith('── Voice input'))).toBe(true);
    const view = { rows: styled.map((line) => line.text), styled, viewportRows: 12, unchangedMs: NUDGE_QUIET_MS };
    expect(muse.nudge?.readiness(view)).not.toBe('ready');
  });
});

describe('a busy Muse turn painted after a full-width row', () => {
  it('stays busy when xterm marks the busy row as a wrap', async () => {
    const cols = 80;
    const voice = `── Voice input (Alt+V to start) ${'─'.repeat(cols - 32)}`;
    const stream = 'output '.repeat(11) + 'x'.repeat(cols - 77) +
      '◈ Thinking (5s · esc to interrupt)\r\n' +
      '\u001b[2;38;2;103;108;116m' + voice + '\u001b[0m' + '❯\r\n' + '─'.repeat(cols) +
      '  muse-wonder-full-1.0 · high · C:\\work\\project · Launch overrides';
    const renderer = new ScreenRenderer({ cols, rows: 12 });
    await renderer.write(stream);
    const styled = renderer.styledLines({ last: 12 }).lines;
    await renderer.dispose();
    expect(styled.find((line) => line.text.startsWith('◈ Thinking'))?.wrapped).toBe(true);
    const view = { rows: styled.map((line) => line.text), styled, viewportRows: 12, unchangedMs: NUDGE_QUIET_MS };
    expect(muse.nudge?.readiness(view)).toBe('busy');
  });
});
