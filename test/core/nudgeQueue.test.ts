import { describe, expect, it } from 'vitest';
import { claude } from '../../src/agents/claude/index.js';
import { grok } from '../../src/agents/grok/index.js';
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
function grokFrame(draft: string): string[] {
  const label = ' Grok 4.7 (xhigh) · auto-review ─┘';
  return [
    `  ┌${'─'.repeat(COLS - 4)}┐`,
    `  │ > ${draft}`.padEnd(COLS - 1) + '│',
    `  └${'─'.repeat(COLS - 3 - label.length)}${label}`,
  ];
}

/**
 * Paint rows the way Grok does: a full-width row is followed directly by the
 * next row with no line break, so xterm marks the next row as a wrap.
 */
async function painted(rows: string[]): Promise<NudgeView> {
  const renderer = new ScreenRenderer({ cols: COLS, rows: ROWS });
  let stream = '';
  // A blank row after a full-width row needs its own line break: the first
  // break only ends the full-width row the cursor is still parked on.
  rows.forEach((row, index) => {
    stream += row.length >= COLS && rows[index + 1] !== '' ? row : `${row}\r\n`;
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
    const empty = [...busy];
    empty[2] = '❯ ';
    expect(claude.nudge!.readiness({ rows: empty })).toBe('queue');
  });

  it('never queues a nudge while the composer block is still changing', async () => {
    const view = await painted(['   / Thinking… 3s', ...grokFrame(''), '  Grok 4.7 xhigh █░░░░░░░░░ 12%', BUSY_HINTS]);
    const observation = { ...view, viewportRows: ROWS, unchangedMs: 0 };
    expect(nudgeVerdict(grok, observation)).toEqual({ ready: false, reason: 'quiet' });
    expect(nudgeVerdict(grok, { ...observation, composerUnchangedMs: NUDGE_QUIET_MS - 1 })).toEqual({ ready: false, reason: 'quiet' });
    expect(nudgeVerdict(grok, { ...observation, composerUnchangedMs: NUDGE_QUIET_MS })).toEqual({ ready: true, queued: true });
  });
});
