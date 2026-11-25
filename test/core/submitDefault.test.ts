import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codex } from '../../src/agents/codex/index.js';
import { grok } from '../../src/agents/grok/index.js';
import { preparedInput } from '../../src/client/input.js';
import { EncodedJson, request } from '../../src/client/http.js';
import { Session, submitOutcome } from '../../src/core/session.js';

const sessions: Session[] = [];
const line = 'Reply with the word ok.';

function fixture(command: string, agent: string, shell = false) {
  let exit!: (event: { exitCode: number }) => void;
  let output!: (data: string) => void;
  const writes: string[] = [];
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
    onData(listener) { output = listener; return { dispose() {} }; },
    onExit(listener) { exit = listener; return { dispose() {} }; },
    write(data: string) { writes.push(data); }, resize() {}, kill() {}, clear() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('s1', { command, agent, shell }, { platform: 'linux', spawn: () => pty });
  sessions.push(session);
  return { session, writes, exit: () => exit({ exitCode: 0 }),
    paint: async (data: string) => { output(data); await session['renderer'].flush(); } };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session['renderer'].dispose();
  vi.unstubAllGlobals();
});

describe('marked submit policy', () => {
  it('uses the policy-visible command for a one-shot wrapper and ignores an agent typed in a shell', async () => {
    const wrapped = fixture('codex', 'codex', true);
    const shell = fixture('pwsh', 'codex', true);
    const input = (s: Session) => vi.spyOn(s as unknown as { writeInput: (...args: never[]) => Promise<string | null> }, 'writeInput')
      .mockResolvedValue('');
    const wrappedWrite = input(wrapped.session);
    const shellWrite = input(shell.session);
    await wrapped.session.writeWithResult(line, { submitMode: 'auto' });
    await shell.session.writeWithResult(line, { submitMode: 'auto' });
    await wrapped.session.writeWithResult(line, { submitMode: 'off' });
    expect(wrappedWrite.mock.calls[0]?.[0]).toBe(line + '\r');
    expect(shellWrite.mock.calls[0]?.[0]).toBe(line);
    expect(wrappedWrite.mock.calls[1]?.[0]).toBe(line);
  });

  it('ends a wrapped agent session before any later auto input is written', async () => {
    const wrapped = fixture('codex', 'codex', true);
    wrapped.exit();
    expect(wrapped.session.exited).toBe(true);
    await expect(wrapped.session.writeWithResult(line, { submitMode: 'auto' })).rejects.toThrow(/exited/iu);
    expect(wrapped.writes).toEqual([]);
  });

  it('refuses omitted submit on an older daemon before encoding input', () => {
    const old = { port: 1, token: '', pid: 1, version: 'old', warnings: [] };
    expect(() => preparedInput(old, line, undefined, false)).toThrow(/explicit submit or upgrade/iu);
    const on = preparedInput(old, line, true, false).body;
    expect(on).toBeInstanceOf(EncodedJson);
    expect((on as EncodedJson).text).toContain('"submit":true');
    expect(preparedInput(old, line, false, false).body).toEqual({ data: line });
  });

  it('does not turn a legacy screen inference into marked acceptance', () => {
    const written = { before: '', submitted: true, submitRetried: false };
    expect(submitOutcome(written)).toEqual({ outcome: 'submitted' });
    expect(submitOutcome(written, true)).toEqual({ outcome: 'unconfirmed' });
  });

  it('sends the mode and instance in headers and never replays a failed marked request', async () => {
    const connection = { port: 1, token: 'token', pid: 1, version: 'new', warnings: [],
      instanceId: 'instance', inputSubmitMode: 1 };
    const prepared = preparedInput(connection, line, undefined, false);
    const fetch = vi.fn().mockRejectedValue(new Error('transport failed'));
    vi.stubGlobal('fetch', fetch);
    await expect(request(connection, 'POST', '/sessions/s1/input', prepared.body, prepared.options))
      .rejects.toThrow('transport failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1] as { headers: Record<string, string>; body: string };
    expect(init.headers['x-shellpuppet-submit']).toBe('auto');
    expect(init.headers['x-shellpuppet-expected-instance']).toBe('instance');
    expect(init.body).toBe(JSON.stringify({ data: line }));
  });
});

describe('pre-Enter composer ownership', () => {
  it('accepts a repeated short Codex line only after an earlier completed turn', () => {
    const rows = ['› ' + line, 'ordinary answer', '› ' + line, '', '  ? for shortcuts'];
    const cursor = { x: 2 + line.length, y: 2 };
    expect(codex.nudge?.readiness({ rows, cursor, viewportCols: 80, expectedDraft: line })).toBe('ready');
    expect(codex.nudge?.readiness({ rows: [rows[0]!, '', ...rows.slice(2)],
      cursor, viewportCols: 80, expectedDraft: line })).not.toBe('ready');
    expect(codex.nudge?.readiness({ rows: [...rows.slice(0, 2), '› Reply with the word no.', ...rows.slice(3)],
      cursor, viewportCols: 80, expectedDraft: line })).not.toBe('ready');
  });

  it('keeps a repeated Codex transcript line as draft when focus is off the selected composer', () => {
    const body = 'sample line';
    const rows = ['› sample line', 'ordinary answer', '› sample line', '', '  ? for shortcuts'];
    const view = { rows, viewportCols: 80, expectedDraft: body };
    expect(codex.nudge?.readiness({ ...view, cursor: { x: 2 + body.length, y: 2 } })).toBe('ready');
    for (const cursor of [{ x: 4, y: 1 }, { x: 4, y: 0 }, { x: 4, y: 4 }]) {
      expect(codex.nudge?.readiness({ ...view, cursor })).toBe('draft');
    }
    expect(codex.nudge?.readiness(view)).toBe('draft');
  });

  it('withholds auto Enter when the repeated Codex frame keeps its cursor on output', async () => {
    const body = 'sample line';
    const rows = ['› sample line', 'ordinary answer', '› sample line', '', '  ? for shortcuts'];
    const f = fixture('codex', 'codex', true);
    await f.paint('\x1b[2J\x1b[H' + rows.join('\r\n') + '\x1b[2;5H');
    const written = await f.session.writeWithResult(body, { submitMode: 'auto' });
    expect(f.writes).toEqual([body]);
    expect(written.submitted).toBe(false);
    expect(written.message).toMatch(/not seen in the composer/iu);
  }, 9_000);

  it('recognises a padded Grok welcome composer after its send hints appear', () => {
    const rows = ['   Tip: Use Enter to send a message.',
      '  ┌' + '─'.repeat(72) + '┐',
      '  │ > ' + line.padEnd(68) + '│',
      '  └' + '─'.repeat(45) + ' Grok session ─┘',
      ' '.repeat(80),
      '  Enter:send  │  Alt+Enter:newline  │  Shift+Tab:mode  │  Ctrl+x:shortcuts'.padEnd(80)];
    const cursor = { x: 6 + line.length, y: 2 };
    expect(grok.nudge?.readiness({ rows, cursor, expectedDraft: line })).toBe('ready');
    expect(grok.nudge?.readiness({ rows, cursor, expectedDraft: 'different line' })).not.toBe('ready');
    expect(grok.nudge?.readiness({ rows: [...rows, 'permission choice'], cursor, expectedDraft: line })).not.toBe('ready');
    expect(grok.nudge?.readiness({ rows, cursor: { x: 0, y: 5 }, expectedDraft: line })).not.toBe('ready');
  });
});
