import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import { MUSE_SUBMIT_DELAY_MS, NUDGE_SUBMIT_DELAY_MS, NUDGE_SUBMIT_WAIT_MS, Session } from '../../src/core/session.js';

class RecordingPty implements IPty {
  readonly pid = 0;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'stand-in';
  handleFlowControl = false;
  readonly writes: { data: string; at: number }[] = [];
  onData(): { dispose(): void } { return { dispose(): void {} }; }
  onExit(): { dispose(): void } { return { dispose(): void {} }; }
  resize(): void {}
  clear(): void {}
  write(data: string): void { this.writes.push({ data, at: Date.now() }); }
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

function recordingSession(agent: string, size?: { cols: number; rows: number }): { session: Session; pty: RecordingPty } {
  const pty = new RecordingPty();
  const session = new Session('input-order', { command: process.execPath, shell: false, agent, ...size }, {
    platform: 'linux', spawn: () => pty,
  });
  return { session, pty };
}

function draftWait(session: Session, seen: boolean, delayMs = 150): void {
  // These cases model a composer already on screen when the text is typed.
  vi.spyOn(session, 'shellPromptBeforeAgent').mockReturnValue(false);
  vi.spyOn(session, 'waitForTypedDraft').mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return seen;
  });
}

describe('Muse input submission', () => {
  it.each([
    ['codex-wrapped-draft', 'Please run this check: set PATH so that C:\\Windows\\System32\\bash.exe is found ' +
      'first, then run "D:/dev-sandbox/draft-notes/archive4/test-stubs:$PATH" with the quoted argument ' +
      "'a\\b\\c' and report back exactly what it printed, including any error text, without changing any files " +
      'in this folder or anywhere else on the machine. Repeat the check twice and compare the two outputs ' +
      'carefully before replying with a short summary only.'],
    ['codex-midtoken-draft', 'Check that the path a bb ccc dd eee ffff gg hhh iii jjjj kk ' +
      'C:\\Windows\\System32\\bash.exe exists, then list D:/dev-sandbox/draft-notes/archive4/test-stubs:$PATH ' +
      'entries, and report.'],
  ])('sends one Enter for the captured Codex composer in %s', async (name, body) => {
    const { session, pty } = recordingSession('codex', { cols: 80, rows: 24 });
    const capture = readFileSync(join(__dirname, '../fixtures/nudge', name + '.ansi'), 'utf8');
    const idle = '\x1b[2J\x1b[H› \x1b[2mAsk Codex to do anything\x1b[0m';
    const renderer = session['renderer'];
    const record = pty.write.bind(pty);
    vi.spyOn(pty, 'write').mockImplementation(data => {
      record(data);
      void renderer.write(data === body ? capture : idle);
    });
    try {
      await renderer.write(idle);
      const result = await session.writeWithResult(body + '\r');
      expect(pty.writes.map(entry => entry.data)).toEqual([body, '\r']);
      expect(result).toMatchObject({ submitted: true, submitRetried: false });
      await renderer.write(capture);
      expect(session.nudgeReadyWithLine(body)).toBe(true);
      expect(session.nudgeReadyWithLine(body + ' more')).toBe(false);
    } finally {
      await renderer.dispose();
    }
  }, 12_000);

  it('submits a Codex nudge after a separate delay', async () => {
    const { session, pty } = recordingSession('codex');
    const phases: string[] = [];
    expect(await session.writeNudge('fixed nudge\r', (_screen, phase) => {
      phases.push(phase);
      return true;
    })).toBe('sent');
    expect(phases).toEqual(['before', 'submit']);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', '\r']);
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual(NUDGE_SUBMIT_DELAY_MS - 5);
  });

  it('waits for a Codex nudge line painted after the pause, then submits it', async () => {
    const { session, pty } = recordingSession('codex');
    let checks = 0;
    const result = await session.writeNudge('fixed nudge\r', (_screen, phase) =>
      phase === 'before' || ++checks >= 4);
    expect(result).toBe('sent');
    expect(checks).toBe(4);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', '\r']);
  });

  it('abandons a Codex nudge whose line never shows within the wait', async () => {
    const { session, pty } = recordingSession('codex');
    const started = Date.now();
    expect(await session.writeNudge('fixed nudge\r', (_screen, phase) => phase === 'before')).toBe('aborted');
    expect(Date.now() - started).toBeGreaterThanOrEqual(NUDGE_SUBMIT_DELAY_MS + NUDGE_SUBMIT_WAIT_MS - 10);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge']);
  });

  it('abandons a waiting Codex nudge as soon as other input is queued', async () => {
    const { session, pty } = recordingSession('codex');
    const pending = session.writeNudge('fixed nudge\r', (_screen, phase) => phase === 'before');
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, NUDGE_SUBMIT_DELAY_MS + 200));
    const started = Date.now();
    const other = session.write('other');
    expect(await pending).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(500);
    await other;
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', 'other']);
  });

  it('leaves a Codex nudge visible when a prompt opens during the delay', async () => {
    const { session, pty } = recordingSession('codex');
    let promptOpen = false;
    const pending = session.writeNudge('fixed nudge\r', (_screen, phase) =>
      phase === 'before' || !promptOpen);
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    promptOpen = true;
    expect(await pending).toBe('aborted');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge']);
  });

  it('leaves a Codex nudge visible when another input is queued during the delay', async () => {
    const { session, pty } = recordingSession('codex');
    const pending = session.writeNudge('fixed nudge\r', () => true);
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = session.write('other');
    expect(await pending).toBe('aborted');
    await other;
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', 'other']);
  });
  it('writes Enter after the delay and before a following write', async () => {
    const { session, pty } = recordingSession('muse');
    draftWait(session, true, MUSE_SUBMIT_DELAY_MS);
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation(() =>
      !pty.writes.some((entry) => entry.data === '\r'));
    vi.spyOn(session, 'pendingComposerVerdict').mockReturnValue({ ready: true });
    const submitting = session.write('hello\r');
    const following = session.write('after');
    await Promise.all([submitting, following]);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r', 'after']);
    // Timers and Date.now() on Windows can disagree by a millisecond or two.
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual(MUSE_SUBMIT_DELAY_MS - 5);
  });

  it('separates typed Enter for Codex and leaves keys and unfinished writes alone', async () => {
    const codex = recordingSession('codex');
    vi.spyOn(codex.session, 'nudgeReadyWithLine').mockImplementation(() =>
      !codex.pty.writes.some((entry) => entry.data === '\r'));
    draftWait(codex.session, true);
    vi.spyOn(codex.session, 'pendingComposerVerdict').mockReturnValue({ ready: true });
    await codex.session.write('hello\r');
    expect(codex.pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r']);
    expect(codex.pty.writes[1]!.at - codex.pty.writes[0]!.at)
      .toBeGreaterThanOrEqual(NUDGE_SUBMIT_DELAY_MS - 5);
    const muse = recordingSession('muse');
    await muse.session.write('\r');
    await muse.session.write('hello');
    expect(muse.pty.writes.map((entry) => entry.data)).toEqual(['\r', 'hello']);
  });

  it('retries Enter only once when the exact typed draft remains', async () => {
    const { session, pty } = recordingSession('codex');
    vi.spyOn(session, 'nudgeReadyWithLine').mockReturnValue(true);
    draftWait(session, true);
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r', '\r']);
    expect(result).toMatchObject({ submitted: false, submitRetried: true });
  });

  it('never retries Enter once the program has ended', async () => {
    const { session, pty } = recordingSession('codex');
    vi.spyOn(session, 'nudgeReadyWithLine').mockReturnValue(true);
    draftWait(session, true);
    let ended = false;
    const originalWrite = pty.write.bind(pty);
    vi.spyOn(pty, 'write').mockImplementation((data) => { originalWrite(data); if (data === '\r') ended = true; });
    vi.spyOn(session, 'programEnded', 'get').mockImplementation(() => ended);
    await expect(session.writeWithResult('hello\r')).rejects.toThrow('exited while input was being written');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r']);
  });

  it('does not take a wrapped continuation row for a shell prompt', () => {
    const { session } = recordingSession('codex');
    vi.spyOn(session['renderer'], 'styledLines').mockReturnValue({ lines: [
      { text: '› please quote this:', spans: [] },
      { text: 'PS D:\\work>', spans: [], wrapped: true },
    ], firstVisible: 0 });
    vi.spyOn(session['renderer'], 'cursor', 'get').mockReturnValue({ x: 11, y: 1 });
    expect(session.shellPromptBeforeAgent()).toBe(false);
  });

  it('does not retry when the composer shows something else', async () => {
    const { session, pty } = recordingSession('codex');
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation(() =>
      !pty.writes.some((entry) => entry.data === '\r'));
    draftWait(session, true);
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r']);
    expect(result.submitRetried).toBe(false);
    expect(result.submitted).toBeUndefined();
  });

  it('does not retry when a person types during the settle', async () => {
    const { session, pty } = recordingSession('codex');
    vi.spyOn(session, 'nudgeReadyWithLine').mockReturnValue(true);
    draftWait(session, true);
    const pending = session.writeWithResult('hello\r');
    while (pty.writes.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = session.write('person');
    const result = await pending;
    await other;
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r', 'person']);
    expect(result.submitRetried).toBe(false);
    expect(result.submitted).toBeUndefined();
  });

  it('sends one Enter and reports uncertainty when the module cannot read its composer', async () => {
    const { session, pty } = recordingSession('generic');
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r']);
    expect(result.submitRetried).toBe(false);
    expect(result.submitted).toBeUndefined();
    expect(result.message).toContain('no readable composer');
  });

  it('does not claim submission from an empty composer when the draft painted late', async () => {
    const { session, pty } = recordingSession('codex');
    draftWait(session, false);
    vi.spyOn(session, 'nudgeReadyWithLine').mockReturnValue(false);
    vi.spyOn(session, 'pendingComposerVerdict').mockReturnValue({ ready: true });
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello']);
    expect(result.submitted).toBe(false);
    expect(result.message).toContain('Enter was not sent');
  });

  it('leaves the submit key unsent when a prompt opens before Enter', async () => {
    const { session, pty } = recordingSession('codex');
    draftWait(session, true);
    vi.spyOn(session, 'nudgeReadyWithLine').mockReturnValue(false);
    vi.spyOn(session, 'pendingComposerVerdict').mockReturnValue({ ready: false, reason: 'prompt' });
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello']);
    expect(result).toMatchObject({ submitted: false, submitRetried: false });
    expect(result.message).toContain('Enter was not sent');
  });

  it('leaves the submit key unsent when another input arrives after the body', async () => {
    const { session, pty } = recordingSession('codex');
    draftWait(session, true);
    vi.spyOn(session, 'nudgeReadyWithLine').mockReturnValue(true);
    const pending = session.writeWithResult('hello\r');
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // Model a write applied outside this queued operation after its body.
    session['inputVersion']++;
    const result = await pending;
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello']);
    expect(result).toMatchObject({ submitted: false, submitRetried: false });
    expect(result.message).toContain('Other input arrived');
  });

  it('sends Enter for a launch line typed at a shell prompt before the agent starts', async () => {
    const { session, pty } = recordingSession('codex');
    vi.spyOn(session['renderer'], 'styledLines').mockReturnValue({
      lines: [{ text: 'PS D:\\work> ', spans: [] }], firstVisible: 0,
    });
    vi.spyOn(session['renderer'], 'cursor', 'get').mockReturnValue({ x: 12, y: 0 });
    const line = 'codex -m example --add-dir \'D:\\A & B\'';
    const result = await session.writeWithResult(`${line}\r`);
    expect(pty.writes.map((entry) => entry.data)).toEqual([line, '\r']);
    expect(result.submitRetried).toBe(false);
  });

  it('keeps composer proof when an agent frame is unreadable but no shell prompt is shown', async () => {
    const { session, pty } = recordingSession('codex');
    vi.spyOn(session['renderer'], 'styledLines').mockReturnValue({
      lines: [{ text: '│ draft words not sent', spans: [] }], firstVisible: 0,
    });
    vi.spyOn(session['renderer'], 'cursor', 'get').mockReturnValue({ x: 22, y: 0 });
    expect(session.shellPromptBeforeAgent()).toBe(false);
    vi.spyOn(session, 'waitForTypedDraft').mockResolvedValue(false);
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello']);
    expect(result.submitted).toBe(false);
  });

  it('does not treat a bare composer marker as a shell prompt', () => {
    const { session } = recordingSession('qoder');
    vi.spyOn(session['renderer'], 'styledLines').mockReturnValue({ lines: [{ text: ' >', spans: [] }], firstVisible: 0 });
    vi.spyOn(session['renderer'], 'cursor', 'get').mockReturnValue({ x: 3, y: 0 });
    expect(session.shellPromptBeforeAgent()).toBe(false);
  });

  it('never sends Enter at a shell prompt once the program has ended', async () => {
    const { session, pty } = recordingSession('codex');
    vi.spyOn(session['renderer'], 'styledLines').mockReturnValue({
      lines: [{ text: 'PS D:\\work> ', spans: [] }], firstVisible: 0,
    });
    vi.spyOn(session['renderer'], 'cursor', 'get').mockReturnValue({ x: 12, y: 0 });
    vi.spyOn(session, 'programEnded', 'get').mockReturnValue(true);
    await expect(session.writeWithResult('codex\r')).rejects.toThrow('exited while input was being written');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['codex']);
  });

  it('rejects a paste placeholder that was visible before this body', async () => {
    const { session, pty } = recordingSession('codex');
    const body = 'x'.repeat(1200);
    vi.spyOn(session['renderer'], 'styledLines').mockReturnValue({
      lines: [{ text: '› [Pasted Content 1200 chars]', spans: [] }], firstVisible: 0,
    });
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation((line) => line === '[Pasted Content 1200 chars]');
    draftWait(session, true);
    const result = await session.writeWithResult(`${body}\r`);
    expect(pty.writes.map((entry) => entry.data).join('')).toBe(body);
    expect(pty.writes.some((entry) => entry.data === '\r')).toBe(false);
    expect(result).toMatchObject({ submitted: false, submitRetried: false });
  });

  it('never takes a placeholder painted late by an earlier paste as this body', async () => {
    const { session, pty } = recordingSession('codex');
    const body = 'hello';
    let bodyWritten = false;
    const originalWrite = pty.write.bind(pty);
    vi.spyOn(pty, 'write').mockImplementation((data) => {
      originalWrite(data);
      if (data === body) bodyWritten = true;
    });
    // An earlier paste was still painting when this body was written.
    session['lastChange'] = Date.now();
    vi.spyOn(session['renderer'], 'styledLines').mockImplementation(() => ({
      lines: bodyWritten ? [{ text: '› [Pasted Content 5 chars]', spans: [] }] : [], firstVisible: 0,
    }));
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation((line) => line === '[Pasted Content 5 chars]');
    // The wait reports the draft seen; the guard before Enter must still refuse it.
    draftWait(session, true);
    const result = await session.writeWithResult(`${body}\r`);
    expect(pty.writes.map((entry) => entry.data)).toEqual([body]);
    expect(result).toMatchObject({ submitted: false, submitRetried: false });
  });

  it('takes a matching placeholder painted after a settled screen as this body', async () => {
    const { session, pty } = recordingSession('codex');
    const body = 'hello';
    let bodyWritten = false;
    let entered = false;
    const originalWrite = pty.write.bind(pty);
    vi.spyOn(pty, 'write').mockImplementation((data) => {
      originalWrite(data);
      if (data === body) bodyWritten = true;
      if (data === '\r') entered = true;
    });
    session['lastChange'] = Date.now() - 5_000;
    session['lastInputAt'] = Date.now() - 5_000;
    vi.spyOn(session['renderer'], 'styledLines').mockImplementation(() => ({
      lines: bodyWritten && !entered ? [{ text: '› [Pasted Content 5 chars]', spans: [] }] : [], firstVisible: 0,
    }));
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation((line) => !entered && line === '[Pasted Content 5 chars]');
    const result = await session.writeWithResult(`${body}\r`);
    expect(pty.writes.map((entry) => entry.data)).toEqual([body, '\r']);
    expect(result.submitRetried).toBe(false);
  });

  it('rejects a new paste placeholder with a different character count', async () => {
    const { session, pty } = recordingSession('codex');
    const body = 'hello';
    let bodyWritten = false;
    const originalWrite = pty.write.bind(pty);
    vi.spyOn(pty, 'write').mockImplementation((data) => {
      originalWrite(data);
      if (data === body) bodyWritten = true;
    });
    vi.spyOn(session['renderer'], 'styledLines').mockImplementation(() => ({
      lines: bodyWritten ? [{ text: '› [Pasted Content 1200 chars]', spans: [] }] : [], firstVisible: 0,
    }));
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation((line) => line === '[Pasted Content 1200 chars]');
    draftWait(session, true);
    const result = await session.writeWithResult(`${body}\r`);
    expect(pty.writes.map((entry) => entry.data)).toEqual([body]);
    expect(result).toMatchObject({ submitted: false, submitRetried: false });
  });

  it('does not retry after the composer changes during the settle', async () => {
    const { session, pty } = recordingSession('codex');
    let readings = 0;
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation(() => ++readings < 3);
    draftWait(session, true);
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r']);
    expect(result.submitRetried).toBe(false);
  });

  it('waits for a painted draft and a quiet period before Enter', async () => {
    const { session, pty } = recordingSession('codex');
    let painted = false;
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation(() => painted &&
      !pty.writes.some((entry) => entry.data === '\r'));
    vi.spyOn(session, 'lastChangeAt').mockImplementation(() => painted ? pty.writes[0]!.at + 250 : Date.now());
    vi.spyOn(session, 'pendingComposerVerdict').mockReturnValue({ ready: true });
    setTimeout(() => { painted = true; }, 250);
    const result = await session.writeWithResult('hello\r');
    expect(pty.writes.map((entry) => entry.data)).toEqual(['hello', '\r']);
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual(590);
    expect(result.submitted).toBe(true);
  });

  it('recognises a pasted-content placeholder as the typed draft', () => {
    const { session } = recordingSession('codex');
    vi.spyOn(session['renderer'], 'styledLines').mockReturnValue({
      lines: [{ text: '› [Pasted Content 1200 chars]', spans: [] }],
      firstVisible: 0,
    });
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation((line) => line === '[Pasted Content 1200 chars]');
    expect(session['typedDraftVisible']('a'.repeat(1200), new Set())).toBe(true);
    expect(session['typedDraftVisible']('a'.repeat(1199), new Set())).toBe(false);
    expect(session['typedDraftVisible']('a'.repeat(1200), new Set(['[Pasted Content 1200 chars]']))).toBe(false);
    expect(session['typedDraftVisible']('[Pasted Content 1200 chars]',
      new Set(['[Pasted Content 1200 chars]']))).toBe(false);
  });

  it('accepts a busy indicator after Enter as positive confirmation', async () => {
    const { session, pty } = recordingSession('codex');
    draftWait(session, true);
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation(() =>
      !pty.writes.some((entry) => entry.data === '\r'));
    vi.spyOn(session, 'pendingComposerVerdict')
      .mockReturnValueOnce({ ready: false, reason: 'unknown' })
      .mockReturnValue({ ready: false, reason: 'busy' });
    const result = await session.writeWithResult('hello\r');
    expect(result.submitted).toBe(true);
    expect(result.submitRetried).toBe(false);
  });

  it('accepts a newly echoed line in the transcript', async () => {
    const { session, pty } = recordingSession('codex');
    draftWait(session, true);
    vi.spyOn(session, 'nudgeReadyWithLine').mockImplementation(() =>
      !pty.writes.some((entry) => entry.data === '\r'));
    vi.spyOn(session, 'pendingComposerVerdict').mockReturnValue({ ready: false, reason: 'unknown' });
    vi.spyOn(session, 'typedLineInTranscript').mockReturnValue(true);
    const result = await session.writeWithResult('hello\r');
    expect(result.submitted).toBe(true);
    expect(result.submitRetried).toBe(false);
  });

  it('excludes each module\'s composer when looking for a transcript echo', () => {
    const codex = recordingSession('codex').session;
    const codexScreen = vi.spyOn(codex['renderer'], 'snapshot');
    codexScreen.mockReturnValue({ screen: 'BURST READY\n› hello\n• ok\n› Ask Codex to do anything' } as never);
    expect(codex['typedLineInTranscript']('hello', 'BURST READY\n› hello')).toBe(true);

    const claude = recordingSession('claude').session;
    const claudeScreen = vi.spyOn(claude['renderer'], 'snapshot');
    claudeScreen.mockReturnValue({ screen: 'READY\n❯ hello' } as never);
    expect(claude['typedLineInTranscript']('hello', 'READY\n❯ ')).toBe(false);
  });

  it('leaves a typed nudge unsubmitted when a prompt opens during the delay', async () => {
    const { session, pty } = recordingSession('muse');
    let promptOpen = false;
    const phases: string[] = [];
    const pending = session.writeNudge('fixed nudge\r', (_screen, phase) => {
      phases.push(phase);
      return phase === 'before' || !promptOpen;
    });
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    promptOpen = true;
    expect(await pending).toBe('aborted');
    expect(phases[0]).toBe('before');
    expect(phases.slice(1).length).toBeGreaterThan(0);
    expect(phases.slice(1).every((phase) => phase === 'submit')).toBe(true);
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge']);
  });

  it('leaves a typed nudge unsubmitted when other input is queued during the delay', async () => {
    const { session, pty } = recordingSession('muse');
    const pending = session.writeNudge('fixed nudge\r', () => true);
    while (pty.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = session.write('other');
    expect(await pending).toBe('aborted');
    await other;
    expect(pty.writes.map((entry) => entry.data)).toEqual(['fixed nudge', 'other']);
  });

  it('advances the screen revision for every applied resize', async () => {
    const { session } = recordingSession('muse');
    const before = session.nudgeScreenRevision();
    await session.resize(80, 24);
    expect(session.nudgeScreenRevision()).toBe(before + 1);
    await session.resize(90, 30);
    expect(session.nudgeScreenRevision()).toBe(before + 2);
  });
});
