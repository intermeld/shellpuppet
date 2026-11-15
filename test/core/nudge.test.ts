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
import { grok } from '../../src/agents/grok/index.js';
import { mimo } from '../../src/agents/mimo/index.js';
import { muse } from '../../src/agents/muse/index.js';
import { opencode } from '../../src/agents/opencode/index.js';
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
  return { rows: screen.split('\n'), unchangedMs: NUDGE_QUIET_MS };
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

    it('treats the recorded suggestion phrase as empty, including the shortcuts status under it', () => {
      const screen = plain(CLAUDE_CODE_SUGGESTION);
      expect(readinessOf(claude, screen)).toBe('ready');
      expect(nudgeVerdict(claude, screen)).toEqual({ ready: true });
    });

    it('treats dim ink on the captured idle composer as empty when the words are not the recorded suggestion', async () => {
      const screen = await load('claude-answered');
      const styled = screen.styled?.map((line) => {
        if (line.text !== '❯') return line;
        const text = '❯ Other dim words';
        return {
          ...line,
          text,
          spans: [{ from: 0, to: text.length, bold: false, dim: true, italic: false, inverse: false, fg: null, bg: null }],
        };
      });
      expect(readinessOf(claude, { ...screen, styled })).toBe('ready');
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

    it('treats dim ink on the captured composer as empty when the words change', async () => {
      const screen = await load('codex-answered');
      const styled = rewriteBody(screen.styled ?? [], /^› /u, 'Ask Codex to do anything', 'Other dim words');
      expect(readinessOf(codex, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('ready');
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

    it('treats grey ink on the captured composer as empty when the words change', async () => {
      const screen = await load('qoder-answered-first-turn');
      const styled = rewriteBody(screen.styled ?? [], /^ > /u, 'Type your message or @path/to/file', 'Other grey words');
      expect(readinessOf(qoder, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('ready');
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

    it('treats grey hint ink on the captured composer as empty when the words change', async () => {
      const screen = await load('live96-3-done-composer-hint');
      const styled = rewriteBody(
        screen.styled ?? [],
        /^❯/u,
        'Start a message with ! to run a shell command yourself',
        'Other grey words',
      );
      expect(readinessOf(muse, { ...screen, rows: styled.map((line) => line.text), styled })).toBe('ready');
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
      for (const module of [generic, agy, grok, opencode, mimo]) {
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
  });
});
