import { describe, expect, it } from 'vitest';
import { claude } from '../../src/agents/claude/index.js';
import { grok } from '../../src/agents/grok/index.js';
import { muse } from '../../src/agents/muse/index.js';
import type { NudgeView } from '../../src/agents/types.js';
import { NUDGE_QUIET_MS, nudgeVerdict } from '../../src/core/nudge.js';
import { ScreenRenderer } from '../../src/core/renderer.js';

const COLS = 120;
const ROWS = 14;
const IDLE_HINTS = '  Shift+Tab:mode  │  Ctrl+x:shortcuts';
const BUSY_HINTS = '  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts';
const BUSY_COMMAND_HINTS = '  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+b:send to bg  │  Ctrl+x:shortcuts';
const BUSY_QUEUED_HINTS = '  Enter:send now  │  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+b:send to bg  │  Ctrl+;:queue  │  Ctrl+x:shortcuts';
const TYPED_BUSY_HINTS = '  Enter:queue  │  Alt+Enter:newline  │  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+Enter:send now  │  Ctrl+x:shortcuts';

/** A Grok Build 1.0.89 square composer frame, each row painted out to the full width. */
function grokFrame(draft: string, cols = COLS): string[] {
  const label = ' Grok 4.7 (xhigh) · auto-review ─┘';
  return [
    `  ┌${'─'.repeat(cols - 4)}┐`,
    `  │ > ${draft}`.padEnd(cols - 1) + '│',
    `  └${'─'.repeat(cols - 3 - label.length)}${label}`,
  ];
}

/**
 * Paint rows the way Grok does: a full-width row is followed directly by the
 * next row with no line break, so xterm marks the next row as a wrap.
 */
async function painted(rows: string[], cols = COLS): Promise<NudgeView> {
  const renderer = new ScreenRenderer({ cols, rows: ROWS });
  let stream = '';
  // A blank row after a full-width row needs its own line break: the first
  // break only ends the full-width row the cursor is still parked on.
  rows.forEach((row, index) => {
    stream += row.length >= cols && rows[index + 1] !== '' ? row : `${row}\r\n`;
  });
  await renderer.write(stream);
  const styled = renderer.styledLines({ last: ROWS }).lines;
  await renderer.dispose();
  return { rows: styled.map((line) => line.text), styled };
}

const transcript = ['     I answered the earlier question.', '', '     Worked for 41s', ''];

describe('Grok composer frame painted to the full width', () => {
  it('reads an idle composer after a turn as ready although its rows are marked as wraps', async () => {
    const view = await painted([...transcript, ...grokFrame(''), '  Grok 4.7 xhigh █░░░░░░░░░ 12%', IDLE_HINTS]);
    expect(view.styled!.some((line) => line.wrapped === true && /^ {2}│ > /u.test(line.text))).toBe(true);
    expect(grok.nudge!.readiness(view)).toBe('ready');
  });

  it('reads the start screen as ready whatever hint line rotates above the frame', async () => {
    for (const hint of ['   Tip: Press ctrl+x for shortcuts', '   Coming from another tool? Press ctrl+u to resume your session from moments ago']) {
      const view = await painted(['', hint, '', ...grokFrame(''), '', `${' '.repeat(COLS - 20)}[stable]`]);
      expect(grok.nudge!.readiness(view)).toBe('ready');
    }
  });

  it('confirms the typed daemon line under either newline hint', async () => {
    const line = '[ShellPuppet] Message m3 from shellpuppet-chair is waiting. Read it with the session_inbox tool.';
    for (const newline of ['Alt+Enter:newline', 'Shift+Enter/Alt+Enter:newline']) {
      const idle = await painted([...transcript, ...grokFrame(line), '  Grok 4.7 xhigh █░░░░░░░░░ 12%',
        `  Enter:send  │  ${newline}  │  Shift+Tab:mode  │  Ctrl+x:shortcuts`]);
      expect(grok.nudge!.readiness({ ...idle, expectedDraft: line })).toBe('ready');
      const busy = await painted(['   / Thinking… 3s', ...grokFrame(line, 187), '  Grok 4.7 xhigh █░░░░░░░░░ 12%',
        `  Enter:queue  │  ${newline}  │  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+Enter:send now  │  Ctrl+x:shortcuts`], 187);
      expect(grok.nudge!.readiness({ ...busy, expectedDraft: line })).toBe('ready');
    }
  });

  it('reads a draft as a draft', async () => {
    const view = await painted([...transcript, ...grokFrame('a reply being typed'), '  Grok 4.7 xhigh █░░░░░░░░░ 12%', IDLE_HINTS]);
    expect(grok.nudge!.readiness(view)).toBe('draft');
  });
});

describe('queueing behind a running turn', () => {
  it('reads an empty Grok composer under each running-turn hint line as queue', async () => {
    for (const hints of [BUSY_HINTS, BUSY_COMMAND_HINTS, BUSY_QUEUED_HINTS]) {
      const view = await painted(['   / Thinking… 3s', ...grokFrame(''), '  Grok 4.7 xhigh █░░░░░░░░░ 12%', hints]);
      expect(grok.nudge!.readiness(view)).toBe('queue');
    }
  });

  it('accepts the daemon line under the queue hints only when it is the expected line', async () => {
    const line = '[ShellPuppet] Message m1 from driver is waiting. Read it with the session_inbox tool.';
    const view = await painted(['   / Thinking… 3s', ...grokFrame(line), '  Grok 4.7 xhigh █░░░░░░░░░ 12%', TYPED_BUSY_HINTS]);
    expect(grok.nudge!.readiness({ ...view, expectedDraft: line })).toBe('ready');
    // A person's draft during a turn is never taken for an empty composer.
    expect(grok.nudge!.readiness(view)).toBe('unknown');
  });

  it('waits on a person typing in a busy Claude Code composer', () => {
    const rule = '─'.repeat(60);
    const busy = ['✻ Thinking… (12s · ↓ 300 tokens)', rule, '❯ a reply the person is typing', rule,
      '  Opus 5.5 medium █░░░░░░░░░ 6%', '  ⏵⏵ auto mode on · esc to interrupt'];
    expect(claude.nudge!.readiness({ rows: busy })).toBe('busy');
  });

  it('never queues into a dialog that replaced the composer under a running turn', () => {
    // An approval panel below an echoed turn: the echoed prompt row is not a framed composer.
    const rows = ['❯ send a message to the other chair', '◇ Calling tools (2m 09s · esc to interrupt)',
      'Would you like to allow this tool action?', '', '  tool action: send a message', 'Reviewer: a reason',
      '⟩ 1. Yes, proceed (y)', '  2. Yes, and do not ask again this session (p)', '  4. No, and say what to do differently (esc)',
      'Change approval defaults in /permissions'];
    expect(muse.nudge!.readiness({ rows })).not.toBe('queue');
    expect(claude.nudge!.readiness({ rows: rows.map((row) => row.replace('◇', '✻')) })).not.toBe('queue');
  });

  it('never queues a nudge while the composer block is still changing', async () => {
    const view = await painted(['   / Thinking… 3s', ...grokFrame(''), '  Grok 4.7 xhigh █░░░░░░░░░ 12%', BUSY_HINTS]);
    const observation = { ...view, viewportRows: ROWS, unchangedMs: 0 };
    expect(nudgeVerdict(grok, observation)).toEqual({ ready: false, reason: 'quiet' });
    expect(nudgeVerdict(grok, { ...observation, composerUnchangedMs: NUDGE_QUIET_MS - 1 })).toEqual({ ready: false, reason: 'quiet' });
    expect(nudgeVerdict(grok, { ...observation, composerUnchangedMs: NUDGE_QUIET_MS })).toEqual({ ready: true, queued: true });
  });
});

describe('what lies below a busy composer', () => {
  const claudeRule = '─'.repeat(60);
  const museTop = `── Voice input (Alt+V to start) ${'─'.repeat(35)}`;
  const inked = (rows: string[], rules: string[], fg: string, dim: boolean): NudgeView => ({
    rows,
    styled: rows.map((text) => ({ text, spans: rules.includes(text)
      ? [{ from: 0, to: text.length, fg, bg: null, bold: false, dim, italic: false, inverse: false }] : [] })),
  });
  const claudeBusy = (below: string[]) => inked(['❯ earlier request', '✻ Thinking… (12s · ↓ 300 tokens)', claudeRule, '❯',
    claudeRule, ...below], [claudeRule], '#888888', false);
  const museBusy = (below: string[]) => inked(['❯ earlier request', '◇ Calling tools (12s · esc to interrupt)', museTop, '❯',
    claudeRule, ...below], [museTop, claudeRule], '#676c74', true);
  const panel = ['Application requests access to files', '  > Permit this action', '    Cancel'];

  it('queues under Claude Code and Muse Code footers', () => {
    expect(claude.nudge!.readiness(claudeBusy(['  Opus 5.5 medium █░░░░░░░░░ 6%', '  ⏵⏵ auto mode on · 1 shell · esc to interrupt']))).toBe('queue');
    expect(muse.nudge!.readiness(museBusy(['main · ↓ to select', '└ ◇ Run the build  running',
      '  muse-wonder-1.0 · high · C:/work/project · Launch overrides']))).toBe('queue');
  });

  it('never queues when a panel is painted below the composer', () => {
    expect(claude.nudge!.readiness(claudeBusy(panel))).toBe('busy');
    expect(muse.nudge!.readiness(museBusy(panel))).toBe('busy');
    expect(nudgeVerdict(claude, { ...claudeBusy(panel), viewportRows: 24, unchangedMs: 0,
      composerUnchangedMs: NUDGE_QUIET_MS })).toEqual({ ready: false, reason: 'busy' });
    // A numbered choice, or any panel indented like a footer row, is still not a footer.
    expect(claude.nudge!.readiness(claudeBusy(['  1. Allow', '  2. Deny']))).toBe('busy');
    expect(claude.nudge!.readiness(claudeBusy(['  Application requests access to files', '  Allow access', '  Cancel']))).toBe('busy');
    expect(claude.nudge!.readiness(claudeBusy(['  Opus 5.5 medium █░░░░░░░░░ 6%', '  Allow access']))).toBe('busy');
    // Rows shaped like Claude's mode line or Muse's task list are not their footers.
    expect(claude.nudge!.readiness(claudeBusy(['  ⏵⏵ Allow workspace access', '  ⏸ Cancel access']))).toBe('busy');
    expect(claude.nudge!.readiness(claudeBusy(['  Opus 5.5 medium █░░░░░░░░░ 6%', '  ⏵⏵ Allow workspace access']))).toBe('busy');
    expect(muse.nudge!.readiness(museBusy(['main · ↓ to select', '└ ◇ Allow workspace access', '└ ◆ Cancel access']))).toBe('busy');
    expect(muse.nudge!.readiness(museBusy(['main · ↓ to select', '└ ◇ Allow workspace access',
      '  muse-wonder-1.0 · high · C:/work/project · Launch overrides']))).toBe('busy');
  });
});
