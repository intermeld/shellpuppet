import type { IPty } from 'node-pty';
import { expect, it, vi } from 'vitest';
import { codex } from '../../src/agents/codex/index.js';
import { grok } from '../../src/agents/grok/index.js';
import { Session } from '../../src/core/session.js';

it('submits by default only for a matching built-in launch', async () => {
  const pty = { pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
    onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; },
    write() {}, resize() {}, kill() {}, clear() {}, pause() {}, resume() {} } satisfies IPty;
  const session = new Session('s1', { command: 'codex', agent: 'codex', shell: true },
    { platform: 'linux', spawn: () => pty });
  try {
    const write = vi.spyOn(session as unknown as { writeInput: (...args: never[]) => Promise<string | null> }, 'writeInput')
      .mockResolvedValue('');
    await session.writeWithResult('ok', { submitMode: 'auto' });
    expect(write.mock.calls[0]?.[0]).toBe('ok\r');
  } finally { await session['renderer'].dispose(); }
});

it('recognises a repeated short Codex line after a completed turn', () => {
  const line = 'Reply with the word ok.';
  const rows = ['› ' + line, 'ordinary answer', '› ' + line, '', '  ? for shortcuts'];
  expect(codex.nudge?.readiness({ rows, viewportCols: 80, expectedDraft: line })).toBe('ready');
});

it('recognises a padded Grok welcome composer after send hints replace the build row', () => {
  const line = 'Reply with the word ok.';
  const rows = ['   Tip: Use Enter to send a message.',
    '  ┌' + '─'.repeat(72) + '┐', '  │ > ' + line.padEnd(68) + '│',
    '  └' + '─'.repeat(45) + ' Grok session ─┘', ' '.repeat(80),
    '  Enter:send  │  Alt+Enter:newline  │  Shift+Tab:mode  │  Ctrl+x:shortcuts'.padEnd(80)];
  expect(grok.nudge?.readiness({ rows, cursor: { x: 6 + line.length, y: 2 }, expectedDraft: line })).toBe('ready');
});
