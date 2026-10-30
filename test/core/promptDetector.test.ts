/**
 * Prompt detection over rendered screens. Fixtures are captures from real
 * agent CLIs and wizards, neutral where noted, plus synthetic shapes,
 * including some that must NOT alert.
 */

import { describe, expect, it } from 'vitest';
import { detectPrompt } from '../../src/core/promptDetector.js';

/** The Qoder Bash permission prompt, as captured live. The file name is neutral. */
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

/** The Qoder trust-folder prompt, as captured live at startup. */
const QODER_TRUST_PROMPT = `
 Do you trust the files in this folder?
────────────────────────────────────────────────────────────────────────────
 Please confirm this is your own project or from a trusted source.

 D:\\GitHub\\example-project-workspace\\feature-sample-other

  ❯ 1. Trust folder
    2. Don't trust and exit

 ↑↓ navigate · Enter select · Esc back
`;

/** A working screen: reads + a live spinner, captured mid-run. The file names are neutral. */
const BUSY_SCREEN = `
 ▪ Read(D:\\GitHub\\...\\Clock.cs)
   └ Read 504 lines
 ▪ Read(D:\\GitHub\\...\\Context.cs)
   └ Read 22 lines

 ⠹ Generating... (esc to cancel, 12m 19s)
────────────────────────────────────────────────────────────────────────────
 Shift+Tab to Accept Edits                              23 MCP servers
`;

describe('detectPrompt', () => {
  it('detects the Qoder permission prompt and reads its options', () => {
    const prompt = detectPrompt(QODER_BASH_PROMPT);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toMatch(/allow this command to run/i);
    expect(prompt!.options).toHaveLength(4);
    expect(prompt!.options[0]).toBe('1. Allow once');
    expect(prompt!.options[3]).toBe('4. No');
  });

  it('detects the trust-folder prompt', () => {
    const prompt = detectPrompt(QODER_TRUST_PROMPT);
    expect(prompt).not.toBeNull();
    expect(prompt!.options).toEqual(["1. Trust folder", "2. Don't trust and exit"]);
  });

  it('keeps the same signature when only unrelated screen content changes', () => {
    const first = detectPrompt(QODER_BASH_PROMPT)!;
    const redrawn = detectPrompt(QODER_BASH_PROMPT.replace('Read 160 lines', 'Read 161 lines'))!;
    expect(redrawn.signature).toBe(first.signature);
  });

  it('detects a classic y/n tail', () => {
    const prompt = detectPrompt('Applying migration 42.\nContinue? (y/n)');
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Continue? (y/n)');
    expect(prompt!.options).toEqual([]);
  });

  it('returns null for a busy screen with a live spinner', () => {
    expect(detectPrompt(BUSY_SCREEN)).toBeNull();
  });

  it('returns null when an option block is followed by busy output (scrollback)', () => {
    const scrolled = `${QODER_BASH_PROMPT}\n ⠇ Generating... (esc to cancel, 9m 27s)`;
    expect(detectPrompt(scrolled)).toBeNull();
  });

  it('returns null for a numbered list in ordinary output (no marker, no question)', () => {
    const listOutput = `
 Findings:
 1. The first thing
 2. The second thing
 3. The third thing
`;
    expect(detectPrompt(listOutput)).toBeNull();
  });

  it('returns null for an empty or blank screen', () => {
    expect(detectPrompt('')).toBeNull();
    expect(detectPrompt('\n \n  \n')).toBeNull();
  });

  it('treats a marker-bearing block as a prompt even without a readable question', () => {
    const bare = `
 something scrolled here
  ❯ 1. Yes
    2. No
`;
    const prompt = detectPrompt(bare);
    expect(prompt).not.toBeNull();
    expect(prompt!.options).toEqual(['1. Yes', '2. No']);
  });

  it('ignores option blocks that sit above the tail window', () => {
    const filler = Array.from({ length: 30 }, (_, i) => `output line ${String(i)}`).join('\n');
    const old = `${QODER_TRUST_PROMPT}\n${filler}`;
    expect(detectPrompt(old)).toBeNull();
  });
});

/**
 * Codex CLI shapes, captured verbatim: the `›`/`>` markers, wrapped option
 * text between numbered rows and the press-enter footer, whose `esc to
 * cancel` must not read as activity.
 */
describe('detectPrompt: Codex shapes', () => {
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

  const CODEX_SIGNIN_PROMPT = `
  Welcome to Codex, OpenAI's command-line coding agent

  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing

> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans

  2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Provide your own API key
     Pay for what you use

  Press enter to continue
`;

  const CODEX_WELCOME = `
  Welcome to Codex, OpenAI's command-line coding agent

✓ Signed in with your ChatGPT account

  Codex can make mistakes
  Review the code it writes and commands it runs

  Press enter to continue
`;

  it('detects the exec-approval prompt despite wrapped option text', () => {
    const prompt = detectPrompt(CODEX_EXEC_PROMPT);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toMatch(/would you like to run/i);
    expect(prompt!.options).toHaveLength(3);
    expect(prompt!.options[0]).toMatch(/^1\. Yes, proceed/);
    expect(prompt!.options[2]).toMatch(/^3\. No, and tell Codex/);
  });

  it('claims the rows from its question down to its last option, the command between them included', () => {
    const prompt = detectPrompt(CODEX_EXEC_PROMPT)!;
    const lines = CODEX_EXEC_PROMPT.split('\n');
    expect(lines[prompt.rows[0]]).toMatch(/Would you like to run/);
    expect(lines[prompt.rows[1]]).toMatch(/^ {2}3\. No, and tell Codex/);
    // Everything the box draws between the two belongs to the question.
    expect(lines.slice(prompt.rows[0], prompt.rows[1] + 1).join('\n')).toMatch(/\$specs=@/);
  });

  it('is not vetoed by the press-enter-or-esc footer below the options', () => {
    // A bare "esc to cancel" must not read as activity when it is part of
    // the prompt's own footer.
    expect(detectPrompt(CODEX_EXEC_PROMPT)).not.toBeNull();
  });

  it('detects the sign-in chooser with its plain > marker', () => {
    const prompt = detectPrompt(CODEX_SIGNIN_PROMPT);
    expect(prompt).not.toBeNull();
    expect(prompt!.options.some((o) => /Sign in with ChatGPT/.test(o))).toBe(true);
  });

  it('treats a bare press-enter-to-continue screen as a wait state', () => {
    const prompt = detectPrompt(CODEX_WELCOME);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toMatch(/press enter to continue/i);
  });

  it('still returns null while Codex is actually working', () => {
    const working = `
• I'll read the kickoff and repository guidance first.

• Working (5s • esc to interrupt)

› Use /skills to list available skills
`;
    expect(detectPrompt(working)).toBeNull();
  });
});

/**
 * Grok CLI shapes, captured verbatim: radio rows `1 (○)` / `2 (•)` inside a
 * `│` box border, no dot after the number and a `1/3:select` footer.
 */
describe('detectPrompt: Grok shapes', () => {
  const GROK_PERMISSION_PROMPT = `
    ♦ Fetch run 42 metadata and save full diff… 14m1s                                                14m31s ↓223k [↓][stop]

  │
  │  Locate worktree and prod-related docs
  │  $wt = "D:/GitHub/example-project-workspace/feature-sample-second"; if (Test-Path $wt) { cd $wt; git rev-parse --abbrev-ref
  │  HEAD; git log -3 --oneline; Test-Path deploy/scripts/Update-SampleServices.ps1 } else { Write-Output "worktree missing" }
  │
  │  1 (○) Yes, and don't ask again for anything (always-approve mode)
  │  2 (•) Yes, proceed
  │  3 (○) No, reject (type to add feedback)
  │

  1/3:select  │  Ctrl+o:always-approve  │  Ctrl+c:cancel
`;

  const GROK_RESPONDING_AFTER_ANSWER = `
  │  1 (○) Yes, and don't ask again for anything (always-approve mode)
  │  2 (•) Yes, proceed
  │  3 (○) No, reject (type to add feedback)
  │

    - Waiting for response… 2.1s                                                                          6.1s ↓180k [stop]

  ╭──────────────────────────────────────────────────────────────────╮
  │ >                                                                │
  ╰──────────────────────────────────────────────── Grok 4.5 (high) ─╯
`;

  it('detects the radio-marker permission prompt inside the box border', () => {
    const prompt = detectPrompt(GROK_PERMISSION_PROMPT);
    expect(prompt).not.toBeNull();
    expect(prompt!.options).toHaveLength(3);
    expect(prompt!.options[1]).toMatch(/^2 \(•\) Yes, proceed/);
    expect(prompt!.options[2]).toMatch(/^3 \(○\) No, reject/);
  });

  it('detects it with the selection on the first option, as Grok Build opens it', () => {
    const prompt = detectPrompt(
      GROK_PERMISSION_PROMPT.replace('1 (○) Yes, and', '1 (•) Yes, and').replace(
        '2 (•) Yes, proceed',
        '2 (○) Yes, proceed',
      ),
    );
    expect(prompt?.options[0]).toMatch(/^1 \(•\) Yes, and don't ask again/);
  });

  it('keeps the same signature when the radio selection moves', () => {
    const first = detectPrompt(GROK_PERMISSION_PROMPT)!;
    const moved = detectPrompt(
      GROK_PERMISSION_PROMPT.replace('2 (•) Yes, proceed', '2 (○) Yes, proceed').replace(
        '3 (○) No, reject',
        '3 (•) No, reject',
      ),
    )!;
    expect(moved.signature).toBe(first.signature);
  });

  it('is vetoed by the response spinner once the prompt is answered', () => {
    // The stale option block stays in the tail while Grok streams its
    // response; "Waiting for response…" below the block means it is history.
    expect(detectPrompt(GROK_RESPONDING_AFTER_ANSWER)).toBeNull();
  });

  it('does not read the 1/3:select footer as an option row', () => {
    const prompt = detectPrompt(GROK_PERMISSION_PROMPT)!;
    expect(prompt.options.every((o) => !/select/.test(o))).toBe(true);
  });

  it('claims the option rows as its own, with neither the command nor the footer among them', () => {
    const prompt = detectPrompt(GROK_PERMISSION_PROMPT)!;
    const lines = GROK_PERMISSION_PROMPT.split('\n');
    const claimed = lines.slice(prompt.rows[0], prompt.rows[1] + 1);
    expect(claimed).toHaveLength(3);
    expect(claimed[0]).toMatch(/^ {2}│ {2}1 \(○\) Yes, and don't ask again/);
    expect(claimed[1]).toMatch(/^ {2}│ {2}2 \(•\) Yes, proceed/);
    expect(claimed[2]).toMatch(/^ {2}│ {2}3 \(○\) No, reject/);
  });
});

/**
 * Grok Build 1.0.41's folder-trust question, captured verbatim on first start
 * in a folder holding project instructions: each option's key follows it.
 * The folder paths are neutral, at the captured length.
 */
describe('detectPrompt: Grok folder-trust question', () => {
  const GROK_TRUST = `
  C:\\U\\e\\p\\d\\samples\\grok-trust-demo





                            Do you trust the contents of this directory?
                  C:\\Users\\example\\projects\\demo-workspace\\samples\\grok-trust-demo

                      Grok Build may run or modify contents in this directory,
                                       posing security risks.

                                   Yes, proceed                 y
                                   No, quit                     n













                                                                       Grok Build  1.0.41 [stable]
`;

  /** Grok's start screen in a folder with nothing to trust: its menu keys are not single letters. */
  const GROK_HOME = `
  C:\\U\\e\\p\\d\\samples\\grok-demo


   ╭────────────────────────────────────────────────────────────────────────────────────────────╮
   │                                                                                            │
   │  Grok Build  1.0.41                                                                        │
   │                                                                                            │
   │  Grok 4.7 is here!                                                                         │
   │  Select 'Grok 4.7' under /model.                                                           │
   │                                                                                            │
   │  New worktree                                                                      ctrl+w  │
   │  Resume session                                                                    ctrl+r  │
   │  Changelog                                                                                 │
   │  Quit                                                                              ctrl+q  │
   │                                                                                            │
   ╰────────────────────────────────────────────────────────────────────────────────────────────╯





   Tip: Press Ctrl+O to toggle auto-approve mode.

  ╭──────────────────────────────────────────────────────────────────────────────────────────────╮
  │ >                                                                                            │
  ╰──────────────────────────────────────────────────────────────────────────── Grok 4.6 (high) ─╯

                                                                                          [stable]
`;

  it('detects the folder-trust question, whose keys follow the options', () => {
    const prompt = detectPrompt(GROK_TRUST);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Do you trust the contents of this directory?');
    expect(prompt!.options).toEqual(['Yes, proceed y', 'No, quit n']);
  });

  it('reads the rows of one chooser only where they are adjacent and line up', () => {
    const outOfLine = GROK_TRUST.replace('No, quit                     n', 'No, quit                   n');
    expect(detectPrompt(outOfLine)).toBeNull();
    const apart = GROK_TRUST.replace('y\n                                   No, quit', 'y\n\n                                   No, quit');
    expect(detectPrompt(apart)).toBeNull();
  });

  it("does not read Grok's start screen as a prompt", () => {
    expect(detectPrompt(GROK_HOME)).toBeNull();
  });

  it('does not read ordinary lines that end in a single letter as key hints', () => {
    // npx's install question, answered, as captured.
    expect(detectPrompt('Need to install the following packages:\nsv@0.17.1\nOk to proceed? (y) y')).toBeNull();
    // A table of y/n flags: no key is the first letter of its row.
    expect(detectPrompt('Which checks are enabled?\n  lint        y\n  typecheck   n')).toBeNull();
    // Keyboard shortcuts under a line with a question mark: no y and n to choose between.
    expect(
      detectPrompt('Keyboard shortcuts (press ? to close)\n  Quit        q\n  Refresh     r\n  Help        h'),
    ).toBeNull();
    // A legend offering y and n, with no question above it.
    expect(detectPrompt('Keys:\n  yank        y\n  next        n')).toBeNull();
  });

  it('needs two or more spaces between an option and its key', () => {
    // Aligned rows whose last word is a lone letter, one space from the text.
    expect(detectPrompt('Do you trust this folder?\n  Yes, run y\n  No, stop n')).toBeNull();
  });
});

/**
 * Marker-only choosers: a pointer against UNNUMBERED rows, as in Claude
 * Code's own folder-trust prompt, captured verbatim below.
 */
describe('detectPrompt: marker-only choosers', () => {
  const CLAUDE_CODE_TRUST_PROMPT = `
──────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 C:\\Users\\example\\projects\\demo

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in
 this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

  const INQUIRER_LIST = `
? Which package manager do you want to use? (Use arrow keys)
❯ npm
  yarn
  pnpm
`;

  /** inquirer on a Windows console without Unicode glyphs. */
  const INQUIRER_LIST_ASCII = `
? Select a template: (Use arrow keys)
> minimal
  full
`;

  it('detects the Claude Code folder-trust prompt (pointer, unnumbered rows, enter-to-confirm footer)', () => {
    const prompt = detectPrompt(CLAUDE_CODE_TRUST_PROMPT);
    expect(prompt).not.toBeNull();
    expect(prompt!.options).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(prompt!.question).toMatch(/is this a project you created or one you trust/i);
  });

  it('keeps the same signature when the pointer moves to the other row', () => {
    const first = detectPrompt(CLAUDE_CODE_TRUST_PROMPT)!;
    const moved = detectPrompt(
      CLAUDE_CODE_TRUST_PROMPT.replace(' ❯ No, exit\n   Yes, I trust', '   No, exit\n ❯ Yes, I trust'),
    )!;
    expect(moved.signature).toBe(first.signature);
  });

  it('detects an inquirer list chooser', () => {
    const prompt = detectPrompt(INQUIRER_LIST);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toMatch(/which package manager/i);
    expect(prompt!.options).toEqual(['npm', 'yarn', 'pnpm']);
  });

  it('detects the ASCII-pointer form when a question heads it', () => {
    const prompt = detectPrompt(INQUIRER_LIST_ASCII);
    expect(prompt).not.toBeNull();
    expect(prompt!.options).toEqual(['minimal', 'full']);
  });

  /** A current inquirer select (@inquirer/demo 2.0.22), captured verbatim: a key-help line under the choices. */
  const INQUIRER_SELECT = `
? Which prompt demo do you want to run?
❯ Input
  Password
  Confirm
  Select
  Checkbox
  Search
  Expand

↑↓ navigate • ⏎ select
`;

  /**
   * The demo's own select, under the answered question before it: a
   * separator, two disabled choices and the focused choice's description
   * under the choices.
   */
  const INQUIRER_SELECT_WITH_DETAILS = `
▶ Which prompt demo do you want to run? Select
? Select a package manager
❯ npm
  yarn
 ──────────────
- jspm (disabled)
- pnpm (pnpm is not available)

npm is the most popular package manager
↑↓ navigate • ⏎ select
`;

  it('detects a current inquirer select, with its key-help line under the choices', () => {
    const prompt = detectPrompt(INQUIRER_SELECT);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('? Which prompt demo do you want to run?');
    expect(prompt!.options).toEqual(['Input', 'Password', 'Confirm', 'Select', 'Checkbox', 'Search', 'Expand']);
  });

  it('detects an inquirer select whatever it draws under the choices', () => {
    // A separator, disabled choices and a description follow the choices, so
    // what is drawn below cannot decide; the question drawn above them does.
    const prompt = detectPrompt(INQUIRER_SELECT_WITH_DETAILS);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('? Select a package manager');
    expect(prompt!.options).toEqual(['npm', 'yarn']);
  });

  it('does NOT read a pointer composer line with status lines under it as a chooser', () => {
    // Claude Code idle, captured verbatim: the composer's ❯ sits
    // above a rule and two indented status lines. Rows separated by a rule
    // are not one block, and no question or footer frames them.
    const idle = `
 ▐▛███▛█   Claude Code v2.1.274
▝▜██████▀  Fable 5.1 · Claude API
  ▝▝ ▝▝    ~\\projects\\demo

──────────────────────────────────────────────────────────────────────────
❯ Try "write a test for <filepath>"
──────────────────────────────────────────────────────────────────────────
  Fable 5.1 ░░░░░░░░░░ 0%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;
    expect(detectPrompt(idle)).toBeNull();
  });

  it('does NOT read the Qoder composer line as a chooser', () => {
    // Qoder idle, captured verbatim.
    const idle = `
──────────────────────────────────────────────────────────────────────────
 Shift+Tab to Accept Edits                              23 MCP servers · 16 skills
──────────────────────────────────────────────────────────────────────────
 >   Type your message or @path/to/file
──────────────────────────────────────────────────────────────────────────
 GLM-5.3 (Z.ai - International / Coding plan) Model · ctx ░░░░░░░░░░ 0% · ~\\projects\\demo
`;
    expect(detectPrompt(idle)).toBeNull();
  });

  it('does NOT read a pointer line with a prose question above and no sibling rows as a chooser', () => {
    const idle = `
● Do you want me to continue with the migration?

──────────────────────────────────────────────────────────────────────────
❯ Try "write a test for <filepath>"
──────────────────────────────────────────────────────────────────────────
  ? for shortcuts
`;
    expect(detectPrompt(idle)).toBeNull();
  });
});

/**
 * Claude Code's transcript and composer, captured verbatim below its banner
 * (the banner and one status notice are left out). `❯` opens each message it
 * echoes into its transcript and the draft in its composer, and the
 * message's own lines continue under it in the same column: under a
 * question from an earlier turn, the shape of a pointer chooser.
 */
describe("detectPrompt: Claude Code's transcript and composer", () => {
  /** A message Claude Code is working on, its spinner under the echo. */
  const CLAUDE_CODE_ECHO_WORKING = `
● What would you like me to work on?

✻ Cooked for 3s · done 20:45

❯ Thanks. Please reply with one short sentence about spring weather, and keep
  the whole reply under ten words.





✢ Spinning…
  ⎿ \u00a0Tip: You can control how big a workflow is just by prompting. Ask for a
     small workflow, cap it with "use at most 5 agents", or set a default with
     Dynamic workflow size in /config.

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  Opus 5 ░░░░░░░░░░ 4%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

  /** The same message once Claude Code has replied to it. */
  const CLAUDE_CODE_ECHO_IDLE = `
● What would you like me to work on?

✻ Cooked for 3s · done 20:45

❯ Thanks. Please reply with one short sentence about spring weather, and keep
  the whole reply under ten words.

● Spring weather shifts quickly from warm sun to sudden rain.

✻ Brewed for 2s · done 20:46






────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  Opus 5 ░░░░░░░░░░ 4%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

  /** The same message as a draft in the composer, before it is sent. */
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

  /**
   * A long message echoed under a question from the turn before, on a
   * wide screen with the spinner below it. Trimmed to the lines that
   * matter, with neutral words in the capture's shape.
   */
  const CLAUDE_CODE_LONG_ECHO = `
  Shall I sort the photos by year as well? It would take a few more minutes, because some of the older files have no date in them and I would have to read the date from the folder names instead.
  The folder names look reliable, but I have not checked all of them yet. Otherwise I can leave them sorted by name.

✻ Cooked for 19m 12s · done 20:31

❯ Thanks, that all sounds good. Yes, please sort them by year, and put anything without a date into a folder of its own so that I can look through it later. Keep the original file names, and
  do not delete anything, even the duplicates: move those into a separate folder instead, with a short list of where each one came from. When the sorting is done, make a small summary with the
  number of photos for each year and the size of each folder, and put it in the top folder as a plain text file. If anything looks odd along the way, for example a file that will not open or
  a date far in the future, note it in the summary rather than trying to fix it. There is no hurry, so take the time you need, and check the result once before you tell me it is finished.
  After that, please stop and wait for me before starting on the videos, because I would like to choose the order for those myself. Thank you for doing this, it will make the albums much
  easier to put together later in the year. The family will be glad to see them. If you find any photos of the garden from the spring, put a copy of those in one more folder, because I would
  like to print a few of them for the kitchen wall. That is everything for now.

✻ Calculating… (14s · thinking)
  ⎿ \u00a0Tip: Connect Claude to your IDE · /ide

──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5.5 ████████░░ 83%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

  /** A numbered message, echoed while Claude Code works on it. */
  const CLAUDE_CODE_NUMBERED_WORKING = `
✻ Brewed for 2s · done 20:46

❯ 1. Say hello in one word.
  2. Then stop.

✻ Orbiting…
  ⎿ \u00a0Tip: Double-tap esc to rewind the code and/or conversation to a previous
     point in time

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  Opus 5 ░░░░░░░░░░ 4%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

  it('does not read a message echoed into the transcript as a chooser while Claude Code works', () => {
    expect(detectPrompt(CLAUDE_CODE_ECHO_WORKING)).toBeNull();
  });

  it('does not read the echoed message as a chooser once Claude Code has replied', () => {
    expect(detectPrompt(CLAUDE_CODE_ECHO_IDLE)).toBeNull();
  });

  it('does not read a draft in the composer as a chooser', () => {
    expect(detectPrompt(CLAUDE_CODE_DRAFT)).toBeNull();
  });

  it('does not read a long echoed message as a chooser under a question from the turn before', () => {
    expect(detectPrompt(CLAUDE_CODE_LONG_ECHO)).toBeNull();
  });

  it("reads Claude Code's spinner as busy: a numbered message echoed above it is not a prompt", () => {
    expect(detectPrompt(CLAUDE_CODE_NUMBERED_WORKING)).toBeNull();
  });

  it('counts the spinner as busy only with its ellipsis, not the line a finished turn leaves', () => {
    const chooser = '? Which package manager do you want to use? (Use arrow keys)\n❯ npm\n  yarn\n  pnpm';
    expect(detectPrompt(`${chooser}\n✻ Calculating… (14s · thinking)`)).toBeNull();
    expect(detectPrompt(`${chooser}\n✻ Cooked for 19m 12s · done 20:31`)).not.toBeNull();
  });

  it('counts only a spinner glyph as the start of a spinner line, not a list bullet or a dash', () => {
    const chooser = '? Which package manager do you want to use? (Use arrow keys)\n❯ npm\n  yarn\n  pnpm';
    expect(detectPrompt(`${chooser}\n• Compressing assets…`)).not.toBeNull();
    expect(detectPrompt(`${chooser}\n- Packing files…`)).not.toBeNull();
  });

  it('counts a spinner line only when its ellipsis ends it, or a parenthesis follows', () => {
    const chooser = '? Which package manager do you want to use? (Use arrow keys)\n❯ npm\n  yarn\n  pnpm';
    // Text after the ellipsis is prose, not a spinner.
    expect(detectPrompt(`${chooser}\n✻ Verifying… and starting the linter`)).not.toBeNull();
    expect(detectPrompt(`${chooser}\n✻ Verifying… (3s)`)).toBeNull();
  });
});

/**
 * Letter-keyed menus and (Y)es/(N)o confirmations.
 */
describe('detectPrompt: letter keys and yes/no variants', () => {
  it('detects a bracketed letter-keyed menu under a question', () => {
    const menu = `
 Do you want to proceed?
   [Y] Yes
   [N] No
   [A] Always allow this command
`;
    const prompt = detectPrompt(menu);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Do you want to proceed?');
    expect(prompt!.options).toEqual(['[Y] Yes', '[N] No', '[A] Always allow this command']);
  });

  it('detects a parenthesised letter-keyed menu with a pointer', () => {
    const menu = `
 What would you like to do?
 ❯ (a) Apply the change
   (s) Skip this file
   (q) Quit
`;
    const prompt = detectPrompt(menu);
    expect(prompt).not.toBeNull();
    expect(prompt!.options).toHaveLength(3);
    expect(prompt!.options[0]).toBe('(a) Apply the change');
  });

  it('does NOT read a markdown checkbox list as a letter-keyed menu', () => {
    // `[x]` is a single letter in brackets; a todo list repeats it.
    const todo = `
 Plan for the refactor?
   [x] Extract the parser
   [x] Add the fixtures
   [ ] Wire the CLI flag
`;
    expect(detectPrompt(todo)).toBeNull();
  });

  it('detects (Y)es/(N)o and [Y]es/[N]o tails', () => {
    expect(detectPrompt('About to delete 3 branches.\nProceed? (Y)es/(N)o')).not.toBeNull();
    expect(detectPrompt('Overwrite the file? [Y]es / [N]o:')).not.toBeNull();
  });

  it('detects a bracketed letter list containing y and n, as git add -p draws', () => {
    const prompt = detectPrompt('@@ -1,4 +1,5 @@\n+added line\n(1/3) Stage this hunk [y,n,q,a,d,e,?]?');
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toMatch(/stage this hunk/i);
    expect(detectPrompt('Apply the patch? (y/N/a)')).not.toBeNull();
  });

  it('does NOT read an ordinary parenthesised ratio or option pair as yes/no', () => {
    expect(detectPrompt('throughput (a/b)')).toBeNull();
    expect(detectPrompt('choose (x/y)')).toBeNull();
  });
});

/**
 * A false positive to keep out: an agent that has finished its turn and
 * printed a numbered findings list under a question-shaped line is not
 * holding a prompt. The list has no pointer and no footer; what
 * makes it a list rather than a chooser is that the program has moved on:
 * its composer is drawn below it.
 */
describe('detectPrompt: numbered lists in ordinary output', () => {
  const FINDINGS_ABOVE_COMPOSER = `
● I reviewed the diff. What needs attention?

  1. The retry loop never backs off (src/retry.ts:41)
  2. The cache key ignores the tenant id (src/cache.ts:88)
  3. The migration drops the index before creating the new one (db/003.sql)

──────────────────────────────────────────────────────────────────────────
❯ Try "write a test for <filepath>"
──────────────────────────────────────────────────────────────────────────
  Fable 5.1 ░░░░░░░░░░ 0%
`;

  const FINDINGS_ABOVE_BOXED_COMPOSER = `
 ● What did I find?

   1. The retry loop never backs off (src/retry.ts:41)
   2. The cache key ignores the tenant id (src/cache.ts:88)

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
  ? for shortcuts                                    23 MCP servers
`;

  it('a numbered findings list under a question, with the composer below, is not a prompt', () => {
    expect(detectPrompt(FINDINGS_ABOVE_COMPOSER)).toBeNull();
    expect(detectPrompt(FINDINGS_ABOVE_BOXED_COMPOSER)).toBeNull();
  });

  it('still accepts a marker-less numbered chooser that ends the screen under its question', () => {
    // A plain program asking for a number and waiting: nothing is drawn
    // below the options, because the program is blocked on the answer.
    const plain = `
Which environment should the deploy target?
  1. staging
  2. production
`;
    expect(detectPrompt(plain)).not.toBeNull();
  });
});

/**
 * The tight sign-in marker: Codex draws \`>1.\` with no space on some sign-in
 * screens.
 */
describe('detectPrompt: Codex tight marker', () => {
  it('detects a chooser whose > marker touches the digit', () => {
    const tight = `
  Sign in to Codex

>1. Sign in with ChatGPT
  2. Provide your own API key
  3. Exit
`;
    const prompt = detectPrompt(tight);
    expect(prompt).not.toBeNull();
    expect(prompt!.options[0]).toMatch(/^1\. Sign in with ChatGPT/);
  });
});

/**
 * Steps drawn by @clack/prompts, the library behind the wizards of
 * create-vite (9.2.1) and `sv create` (0.17.1), captured verbatim. A step
 * waiting on its answer has a `◆` headline (`▲` while it shows a validation
 * error), choice rows in the `│` gutter and a `└` closing it; clack redraws
 * an answered step `◇` and a cancelled one `■`.
 */
describe('detectPrompt: clack steps', () => {
  /** create-vite asking what to do with a folder that is not empty. */
  const VITE_NOT_EMPTY = `
> npx
> create-vite


To create in one go, run: create-vite <DIRECTORY> --no-interactive --template <TEMPLATE>

│
◇  Project name:
│  shop
│
◆  Target directory "shop" is not empty. Please choose how to proceed:
│  ● Cancel operation
│  ○ Remove existing files and continue
│  ○ Ignore files and continue
│  ↑/↓ to navigate • Enter: confirm
└
`;

  /** The next step, under the two answered ones. */
  const VITE_FRAMEWORK = `
│
◇  Project name:
│  shop
│
◇  Target directory "shop" is not empty. Please choose how to proceed:
│  Ignore files and continue
│
◆  Select a framework:
│  ● Vanilla
│  ○ Vue
│  ○ React
│  ○ Preact
│  ○ Lit
│  ○ Svelte
│  ○ Solid
│  ○ Ember
│  ○ Qwik
│  ○ Angular
│  ○ Marko
│  ○ Others
│  ↑/↓ to navigate • Enter: confirm
└
`;

  /** The same step in a terminal 16 rows high, scrolled down to Angular. */
  const VITE_FRAMEWORK_SCROLLED = `
│
◆  Select a framework:
│  ...
│  ○ Preact
│  ○ Lit
│  ○ Svelte
│  ○ Solid
│  ○ Ember
│  ○ Qwik
│  ● Angular
│  ○ Marko
│  ○ Others
│  ↑/↓ to navigate • Enter: confirm
└
`;

  /** A confirm: both choices on one row, and no footer. */
  const VITE_CONFIRM = `
│
◇  Select a framework:
│  React
│
◇  Select a variant:
│  TypeScript
│
◇  Which linter to use?
│  Oxlint
│
◆  Install with npm and start now?
│  ● Yes / ○ No
└
`;

  /** The not-empty question 34 columns wide. */
  const VITE_NOT_EMPTY_NARROW = `
> npx
> create-vite shop


To create in one go, run: create-v
ite <DIRECTORY> --no-interactive -
-template <TEMPLATE>

│
◆  Target directory
│  "shop" is not empty.
│  Please choose how to
│  proceed:
│  ● Cancel operation
│  ○ Remove existing
│  files and continue
│  ○ Ignore files and
│  continue
│  ↑/↓ to navigate • Enter:
confirm
└
`;

  /** create-vite's last screen, every step answered. The folder path is neutral. */
  const VITE_DONE = `
│
◇  Select a framework:
│  React
│
◇  Select a variant:
│  TypeScript
│
◇  Which linter to use?
│  Oxlint
│
◇  Install with npm and start now?
│  No
│
◇  Scaffolding project in C:\\projects\\demo\\shop...
│
└  Done. Now run:

  cd shop
  npm install
  npm run dev
`;

  /**
   * create-vite run from a shell and killed at the not-empty question: its
   * step stays on screen, with npm's error and the shell prompt under it.
   * Paths are neutral, and npm's line naming its log file is left out.
   */
  const VITE_KILLED = `
C:\\projects\\demo>npm create vite@latest shop

> npx
> create-vite shop


To create in one go, run: create-vite <DIRECTORY> --no-interactive --template <TEMPLATE>

│
◆  Target directory "shop" is not empty. Please choose how to proceed:
│  ● Cancel operation
│  ○ Remove existing files and continue
│  ○ Ignore files and continue
│  ↑/↓ to navigate • Enter: confirm
└
npm error code 1
npm error path C:\\projects\\demo
npm error command failed
npm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c create-vite shop

C:\\projects\\demo>
`;

  /** sv create's template select: no footer, and a hint beside the selected row. */
  const SV_TEMPLATE = `
┌  Welcome to the Svelte CLI! (v0.17.1)
│
◇  Where would you like your project to be created?
│  shop
│
◆  Which template would you like?
│  ● SvelteKit minimal (barebones scaffolding for your new app)
│  ○ SvelteKit demo
│  ○ Svelte library
└
`;

  /** sv create's add-on multi-select, nothing checked yet. */
  const SV_ADD_ONS = `
◇  Add type checking with TypeScript?
│  Yes, using TypeScript syntax
│
◆  What would you like to add to your project? (use arrow keys / space bar)
│  ◻ prettier (formatter - https://prettier.io)
│  ◻ eslint
│  ◻ vitest
│  ◻ playwright
│  ◻ tailwindcss
│  ◻ sveltekit-adapter
│  ◻ drizzle
│  ◻ better-auth
│  ◻ mdsvex
│  ◻ paraglide
│  ◻ storybook
│  ◻ ai-tools
│  ◻ experimental
└
`;

  /** A multi-select submitted with nothing checked, showing its validation error. */
  const SV_VITEST_ERROR = `
◇  What would you like to add to your project? (use arrow keys / space bar)
│  prettier, vitest
│
▲  vitest: What do you want to use vitest for?
│  ◻ unit testing
│  ◻ component testing
└  Please select at least one option.
   Press  space  to select,  enter  to submit
`;

  /** A select under clack's success line, which reuses the `◆` glyph. */
  const SV_PACKAGE_MANAGERS = `
◇  vitest: What do you want to use vitest for?
│  component testing
│
◆  Project created
│
◆  Detected package managers. Which one should we use to install dependencies?
│  ○ None
│  ● npm
│  ○ yarn
│  ○ pnpm
│  ○ pnpm-rush
│  ○ bun
│  ○ deno
│  ○ nub
│  ○ aube
└
`;

  /** The success line on its own, while sv works towards the next step. */
  const SV_PROJECT_CREATED = `
◇  vitest: What do you want to use vitest for?
│  component testing
│
◆  Project created
`;

  /** The package-manager select, cancelled with ctrl+c. */
  const SV_CANCELLED = `
◆  Project created
│
■  Detected package managers. Which one should we use to install dependencies?
│  npm
│
└  Operation cancelled.
`;

  /**
   * Claude Code on Windows, below its banner: `●` opens each message and
   * tool call at the start of the line, and `⎿` continues one. The banner and
   * one status notice are left out.
   */
  const CLAUDE_CODE_IDLE = `
❯ say hi in three words

● Hello there, friend!

✻ Churned for 2s · done 15:20

❯ read notes.txt and tell me its first word

  Read 1 file

● The first word of notes.txt is "The".

✻ Churned for 3s · done 15:21





────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5.5 ░░░░░░░░░░ 4%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

  /** The same session mid-turn, a tool call on screen. */
  const CLAUDE_CODE_WORKING = `
❯ say hi in three words

● Hello there, friend!

✻ Churned for 2s · done 15:20

❯ read notes.txt and tell me its first word

● Reading notes.txt
  ⎿  notes.txt





✽ Zigzagging… (3s · ↓ 200 tokens · thought for 2s)
  ⎿ \u00a0Tip: Use /focus to see just your prompt, a one-line summary of the work, and the response

────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5.5 ░░░░░░░░░░ 4%
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

  it('reads a clack select, its headline the question with or without a question mark', () => {
    const prompt = detectPrompt(VITE_NOT_EMPTY);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Target directory "shop" is not empty. Please choose how to proceed:');
    expect(prompt!.options).toEqual([
      'Cancel operation',
      'Remove existing files and continue',
      'Ignore files and continue',
    ]);
  });

  it('keeps the same signature when the selection moves', () => {
    const first = detectPrompt(VITE_NOT_EMPTY)!;
    const moved = detectPrompt(
      VITE_NOT_EMPTY.replace('│  ● Cancel operation\n│  ○ Remove', '│  ○ Cancel operation\n│  ● Remove'),
    )!;
    expect(moved.options).toEqual(first.options);
    expect(moved.signature).toBe(first.signature);
  });

  it('reads the step that is waiting, not the answered steps above it', () => {
    const prompt = detectPrompt(VITE_FRAMEWORK);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Select a framework:');
    expect(prompt!.options).toHaveLength(12);
    expect(prompt!.options[0]).toBe('Vanilla');
    expect(prompt!.options[11]).toBe('Others');
  });

  it('leaves out the ... that stands for rows scrolled out of view', () => {
    const prompt = detectPrompt(VITE_FRAMEWORK_SCROLLED);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Select a framework:');
    expect(prompt!.options).toEqual([
      'Preact',
      'Lit',
      'Svelte',
      'Solid',
      'Ember',
      'Qwik',
      'Angular',
      'Marko',
      'Others',
    ]);
  });

  it('reads a clack confirm as two options on one row, with the same signature either way', () => {
    const prompt = detectPrompt(VITE_CONFIRM);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Install with npm and start now?');
    expect(prompt!.options).toEqual(['Yes', 'No']);
    const flipped = detectPrompt(VITE_CONFIRM.replace('│  ● Yes / ○ No', '│  ○ Yes / ● No'))!;
    expect(flipped.signature).toBe(prompt!.signature);
  });

  it('reads a step whose message, rows and footer wrap on a narrow screen', () => {
    // Clack wraps the message and the rows inside the gutter; the terminal
    // wraps the end of the footer onto a line of its own. A wrapped option is
    // read by its first line, as a wrapped numbered row is.
    const prompt = detectPrompt(VITE_NOT_EMPTY_NARROW);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Target directory "shop" is not empty. Please choose how to proceed:');
    expect(prompt!.options).toEqual(['Cancel operation', 'Remove existing', 'Ignore files and']);
  });

  it('reads a select with no footer, keeping its signature as the hint follows the selection', () => {
    const prompt = detectPrompt(SV_TEMPLATE);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Which template would you like?');
    expect(prompt!.options).toEqual([
      'SvelteKit minimal (barebones scaffolding for your new app)',
      'SvelteKit demo',
      'Svelte library',
    ]);
    // One down arrow, as captured: sv draws the hint beside the selected row only.
    const moved = detectPrompt(
      SV_TEMPLATE.replace(
        '│  ● SvelteKit minimal (barebones scaffolding for your new app)\n│  ○ SvelteKit demo',
        '│  ○ SvelteKit minimal\n│  ● SvelteKit demo (showcase app with a word guessing game that works without JavaScript)',
      ),
    )!;
    expect(moved.options[1]).toMatch(/^SvelteKit demo \(showcase app/);
    expect(moved.signature).toBe(prompt!.signature);
  });

  it('reads a clack multi-select, keeping its signature as rows are checked and the focus moves', () => {
    const prompt = detectPrompt(SV_ADD_ONS);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('What would you like to add to your project? (use arrow keys / space bar)');
    expect(prompt!.options).toHaveLength(13);
    expect(prompt!.options[0]).toBe('prettier (formatter - https://prettier.io)');
    // prettier and vitest checked and the focus on playwright, as captured:
    // a checked row keeps its hint, and the focused row gains one.
    const checked = detectPrompt(
      SV_ADD_ONS.replace('│  ◻ prettier', '│  ◼ prettier')
        .replace('│  ◻ vitest', '│  ◼ vitest (unit testing - https://vitest.dev)')
        .replace('│  ◻ playwright', '│  ◻ playwright (browser testing - https://playwright.dev)'),
    )!;
    expect(checked.options[2]).toBe('vitest (unit testing - https://vitest.dev)');
    expect(checked.signature).toBe(prompt!.signature);
  });

  it('reads a step showing a validation error (▲) as still waiting, with the signature it had', () => {
    const prompt = detectPrompt(SV_VITEST_ERROR);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('vitest: What do you want to use vitest for?');
    expect(prompt!.options).toEqual(['unit testing', 'component testing']);
    const before = detectPrompt(
      SV_VITEST_ERROR.replace('▲  vitest', '◆  vitest').replace(
        '└  Please select at least one option.\n   Press  space  to select,  enter  to submit',
        '└',
      ),
    )!;
    expect(before.signature).toBe(prompt!.signature);
  });

  it("takes the question from the step's own headline, not from clack's success line above it", () => {
    const prompt = detectPrompt(SV_PACKAGE_MANAGERS);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe(
      'Detected package managers. Which one should we use to install dependencies?',
    );
    expect(prompt!.options).toHaveLength(9);
  });

  it('returns null once every step is answered', () => {
    expect(detectPrompt(VITE_DONE)).toBeNull();
  });

  it("does not read clack's success line as a step: it has no choice rows", () => {
    expect(detectPrompt(SV_PROJECT_CREATED)).toBeNull();
  });

  it('returns null for a cancelled step', () => {
    expect(detectPrompt(SV_CANCELLED)).toBeNull();
  });

  it('goes by the headline glyph: rows under a ◇ or ■ headline are not waiting', () => {
    const headline = '◆  Target directory';
    expect(detectPrompt(VITE_NOT_EMPTY.replace(headline, '◇  Target directory'))).toBeNull();
    expect(detectPrompt(VITE_NOT_EMPTY.replace(headline, '■  Target directory'))).toBeNull();
  });

  it('returns null for a step left on screen by a wizard that was killed', () => {
    expect(detectPrompt(VITE_KILLED)).toBeNull();
  });

  it('returns null when busy output is drawn under a step', () => {
    const scrolled = `${VITE_NOT_EMPTY}\n ⠇ Generating... (esc to cancel, 9m 27s)`;
    expect(detectPrompt(scrolled)).toBeNull();
  });

  it('does not read a step before the └ closing its frame is drawn', () => {
    expect(detectPrompt(VITE_NOT_EMPTY.replace(/└\n$/, ''))).toBeNull();
  });

  it('needs exactly one radio selected', () => {
    expect(detectPrompt(VITE_NOT_EMPTY.replace('│  ● Cancel', '│  ○ Cancel'))).toBeNull();
    expect(detectPrompt(VITE_NOT_EMPTY.replace('│  ○ Ignore', '│  ● Ignore'))).toBeNull();
  });

  it('reads choice rows only in the │ gutter', () => {
    // A checkbox row at the left edge under a step headline is not the step's choice.
    expect(detectPrompt('◆  Which add-ons?\n◼ TypeScript\n└\n')).toBeNull();
  });

  it('reads choice rows only with clack choice glyphs', () => {
    // The same step with its radios drawn as bullets or as answered-step markers.
    expect(detectPrompt(VITE_NOT_EMPTY.replace(/^│ {2}[●○]/gm, '│  •'))).toBeNull();
    expect(detectPrompt(VITE_NOT_EMPTY.replace(/^│ {2}[●○]/gm, '│  ◇'))).toBeNull();
  });

  it("does not read Claude Code's ● transcript as a chooser, idle or working", () => {
    expect(detectPrompt(CLAUDE_CODE_IDLE)).toBeNull();
    expect(detectPrompt(CLAUDE_CODE_WORKING)).toBeNull();
  });

  /**
   * MiMo Code 0.1.15's folder-trust question: a select with no message of its
   * own, under the message it logs (`●`). The folder is a stand-in.
   */
  const MIMO_TRUST = `
│
●  Accessing workspace:
│
│  D:\\projects\\shop
│
│  Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.
│
│  MiMo Code will be able to read, edit, and execute files here.
│
│  If malicious plugins exist in this directory, they can execute arbitrary code, read, modify, or exfiltrate your files.
│
◆
│  ● Yes, I trust this folder
│  ○ No, exit
└
`;

  it("reads a step with no message of its own, asked by the message logged above it (MiMo Code's folder trust)", () => {
    const prompt = detectPrompt(MIMO_TRUST);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toMatch(
      /^Accessing workspace: D:\\projects\\shop Quick safety check: Is this a project you created or one you trust\? /,
    );
    expect(prompt!.question).toMatch(/exfiltrate your files\.$/);
    expect(prompt!.options).toEqual(['Yes, I trust this folder', 'No, exit']);
  });

  it('reads the same question when the terminal wraps its long lines out of the gutter', () => {
    // As MiMo Code draws it 120 columns wide: two lines break, one inside a word.
    const narrow = MIMO_TRUST.replace(
      'well-known open source project, ',
      'well-known open source pro\nject, ',
    ).replace('exfiltrate your files.', 'exfiltrate your files\n.');
    expect(narrow).not.toBe(MIMO_TRUST);
    const prompt = detectPrompt(narrow);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe(detectPrompt(MIMO_TRUST)!.question);
    expect(prompt!.signature).toBe(detectPrompt(MIMO_TRUST)!.signature);
  });

  it('takes only the message logged directly above, not the steps before it', () => {
    const prompt = detectPrompt(`◇  Project name:\n│  shop\n${MIMO_TRUST}`);
    expect(prompt!.question).toMatch(/^Accessing workspace: /);
  });

  it('asks with the first choice when nothing is logged above a step with no message', () => {
    const prompt = detectPrompt('◆\n│  ● Yes, carry on\n│  ○ No, exit\n└\n');
    expect(prompt!.question).toBe('Yes, carry on');
    expect(prompt!.options).toEqual(['Yes, carry on', 'No, exit']);
  });

  it('does not take a message from across a blank line', () => {
    const prompt = detectPrompt('●  An earlier note\n\n◆\n│  ● Yes, carry on\n│  ○ No, exit\n└\n');
    expect(prompt!.question).toBe('Yes, carry on');
  });

  it('returns null for a step with no message once it is answered', () => {
    expect(detectPrompt(MIMO_TRUST.replace(/^◆$/m, '◇'))).toBeNull();
  });

  it('does not take a line out of the gutter as part of the message unless the row above fills the screen', () => {
    const prompt = detectPrompt('●  Build complete\nworker: copied files\n◆\n│  ● Ready\n│  ○ Pending\n└\n');
    expect(prompt!.question).toBe('Ready');
  });

  it('leaves the hint beside the first choice out of a question taken from it', () => {
    const focused = detectPrompt('◆\n│  ● Ready (recommended)\n│  ○ Pending\n└\n')!;
    const moved = detectPrompt('◆\n│  ○ Ready\n│  ● Pending (recommended)\n└\n')!;
    expect(focused.question).toBe('Ready');
    expect(moved.signature).toBe(focused.signature);
  });

  it('does not read a step-shaped diagram an agent printed above its input box', () => {
    const transcript = '●  Here is the status diagram:\n◆\n│  ● Ready\n│  ○ Pending\n└\n\n  ❯ Ask anything\n';
    expect(detectPrompt(transcript)).toBeNull();
    expect(detectPrompt(transcript.replace('◆\n', '◆  Status:\n'))).toBeNull();
  });

  it('does not take an input box under a captioned closing line for a validation message', () => {
    const diagram = '●  Here is the status diagram:\n◆\n│  ● Ready\n│  ○ Pending\n└  End of diagram\n';
    expect(detectPrompt(`${diagram}  ❯ Ask anything\n`)).toBeNull();
    expect(detectPrompt(`${diagram}   ❯ Ask anything\n`)).toBeNull();
    expect(detectPrompt(`${diagram}    an indented note\n`)).toBeNull();
    expect(detectPrompt(`${diagram}   ╭────────────╮\n   │ >          │\n   ╰────────────╯\n`)).toBeNull();
  });

  it('still reads a validation message drawn under the step', () => {
    const step = '◆  Pick one:\n│  ◻ unit testing\n│  ◻ component testing\n└  Please select at least one option.\n   Press  space  to select\n';
    expect(detectPrompt(step)).not.toBeNull();
    expect(detectPrompt(`${step}\n  ❯ Ask anything\n`)).toBeNull();
  });
});
