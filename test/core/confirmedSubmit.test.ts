import { resolve } from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, submitOutcome } from '../../src/core/session.js';
import { buildNudge, Mailbox } from '../../src/core/mailbox.js';
import { Daemon } from '../../src/daemon/server.js';

const folder = 'sample-folder';
const line = 'sample line';
const clear = '\x1b[2J\x1b[H';
const rule = '──────────────────────────────────────────';
const title = (s: string) => `\x1b]2;${s}\x07`;
const frame = (body: string, offset = 0) => clear + '\r\n'.repeat(offset) +
  '── Voice input (Alt+V to start) ──────────\r\n❯ ' + body + '\r\n' + rule;
const hint = '\x1b[38;2;103;108;116mSample tip\x1b[0m';
const running = title('⠋ ' + folder);
const focus = '\x1b[I';
const sessions: Session[] = [];

function fixture(agent: string, onWrite?: (data: string) => void) {
  let output!: (data: string) => void;
  const writes: string[] = [];
  const pty = {
    pid: 0, cols: 100, rows: 24, process: 'fixture', handleFlowControl: false,
    onData(listener) { output = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; }, write(data: string) { writes.push(data); onWrite?.(data); },
    resize() {}, kill() {}, clear() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('s1', { command: process.execPath, cwd: resolve(folder), agent, shell: false },
    { platform: 'linux', spawn: () => pty });
  sessions.push(session);
  const paint = (data: string) => { output(data); return session['renderer'].flush(); };
  return { session, paint, writes };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session['renderer'].dispose();
});

async function type(session: Session, data: string, options: { submit?: boolean }) {
  const written = await session.writeWithResult(data);
  return { ...written, ...(options.submit ? submitOutcome(written) : {}) };
}

async function museTurn(options: { submit?: boolean }, afterEnter: string, afterDraft = '') {
  const f = fixture('muse', data => {
    if (data === line) void f.paint(frame(line) + afterDraft);
    if (data === '\r') void f.paint(afterEnter);
  });
  await f.paint(frame('') + title(folder));
  return { result: await type(f.session, line + '\r', options), writes: f.writes };
}

// Both request shapes use the 0.4.1 client's encoding. Assert individual writes so a
// pasted body and Enter in one call cannot silently become two calls, or vice versa.
describe.each([{ name: 'legacy', options: {} }, { name: 'reported', options: { submit: true } }])(
  'PTY parity ($name)', ({ options }) => {
    it('sends one Enter even when another buffer shows a running turn', async () => {
      const f = fixture('muse', data => {
        if (data === line) void f.paint(frame(line));
        if (data === '\r') void f.paint('\x1b[?1049h' + frame(hint, 1) + running);
      });
      await f.paint(frame('') + title(folder));
      await type(f.session, line + '\r', options);
      expect(f.writes).toEqual([line, '\r']);
      await f.paint('\x1b[?1049l');
      expect(f.session['renderer'].snapshot().screen).toContain('❯ ' + line);
    });

    it('writes an ordinary character before a pending frame is parsed', async () => {
      let painted = false;
      const f = fixture('qoder', () => expect(painted).toBe(false));
      const painting = f.paint(clear + rule + '\r\n > \r\n' + rule).then(() => { painted = true; });
      const result = await type(f.session, 'x', 'submit' in options ? { submit: false } : {});
      await painting;
      expect(result.before).toBe('');
      expect(result).not.toHaveProperty('outcome');
      expect(f.writes).toEqual(['x']);
    });

    it.each(['generic', 'muse', 'claude', 'codex', 'agy', 'grok', 'opencode', 'mimo', 'qoder',
      'hermes', 'gemini', 'goose'])('keeps the multiline write intact for %s', async agent => {
      const f = fixture(agent);
      await type(f.session, 'A\nB\r', options);
      expect(f.writes).toEqual(['A\nB\r']);
    });

    it('keeps the original bracketed paste threshold and trailing Enter', async () => {
      const f = fixture('generic');
      await f.paint('\x1b[?2004h');
      const body = 'a'.repeat(511) + '\n' + 'b'.repeat(512);
      await type(f.session, body + '\r', options);
      expect(f.writes).toEqual(['\x1b[200~' + body + '\x1b[201~\r']);
    });

    it('writes the queued terminal focus report after Enter', async () => {
      let reply: Promise<string> | undefined;
      const qoder = (s: string) => clear + rule + '\r\n > ' + s + '\r\n' + rule;
      const f = fixture('qoder', data => {
        if (data === line) {
          void f.paint(qoder(line));
          reply = f.session.write(focus, { terminalReport: true });
        }
      });
      await f.paint(qoder(''));
      await type(f.session, line + '\r', options);
      await reply;
      expect(f.writes).toEqual([line, '\r', focus]);
    });

    it('retries once when only an unrelated title changed at the first Enter', async () => {
      let enters = 0;
      const f = fixture('muse', data => {
        if (data === line) void f.paint(frame(line));
        if (data === '\r') void f.paint(++enters === 1 ? title('different title') : frame(''));
      });
      await f.paint(frame('') + title(folder));
      const result = await type(f.session, line + '\r', options);
      expect(result.submitRetried).toBe(true);
      expect(f.writes).toEqual([line, '\r', '\r']);
    });

    it.each(['schedule', 'mailbox'])('allows %s delivery within the original recent-input window', async kind => {
      const editor = (s: string) => clear + rule + '\r\n❯ ' + s + '\r\n' + rule;
      const f = fixture('claude', data => { void f.paint(editor(data === '\r' ? '' : data)); });
      await f.paint(editor(''));
      const result = await type(f.session, line + '\r', options);
      expect(result.submitted).toBe(true);
      expect(f.session.recentInput).toBe(false);
      const mailbox = new Mailbox({ enabled: true, policy: () => true });
      mailbox.register({ id: 's1', name: 'worker', kind: 'session' });
      const daemon = Object.create(Daemon.prototype) as Daemon;
      Object.assign(daemon, { mailbox, pendingSchedules: new Map(), manager: { get: () => f.session },
        now: () => Date.now() + 1600, audit: { record() {} } });
      let body = 'Run the check.';
      if (kind === 'schedule') {
        const schedule = { name: 'check', session: 'worker', message: body, cron: '* * * * *', enabled: true, whenBusy: 'skip' } as const;
        expect(await daemon['deliverScheduled'](schedule, () => true)).toMatchObject({ outcome: 'sent' });
      } else {
        mailbox.send(mailbox.claim('sender').claimId, 'worker', body);
        body = buildNudge(mailbox.inbox('s1', { markRead: false }));
        expect(await daemon['deliverNudge']('s1')).toBe('sent');
      }
      expect(f.writes).toEqual([line, '\r', body, '\r']);
    });
  },
);

it.each([
  ['a running title and grey hint', frame(hint) + running + title(folder), '', undefined],
  ['a replacement editor at the same rows', clear + 'Choose an item' + frame(hint) + running, '', undefined],
  ['a title sequence started before Enter', folder + '\x07' + frame(hint), '\x1b]2;⠋ ', undefined],
  ['an empty editor without a title change', frame(''), '', true],
] as const)('reports the existing Muse verdict for %s', async (_name, after, partial, submitted) => {
  const { result } = await museTurn({ submit: true }, after, partial);
  expect(result.submitted).toBe(submitted);
  expect(result).toMatchObject({ outcome: submitted ? 'submitted' : 'unconfirmed' });
});

it('does the same viewport reads before the next queued write with and without reporting', async () => {
  async function readsBeforeNextWrite(submit: boolean) {
    let count = -1;
    const f = fixture('muse', data => {
      if (data === line) void f.paint(frame(line));
      if (data === '\r') {
        // Earlier polling depends on paint timing. Count just the work between these two PTY writes.
        reads.mockClear();
        void f.paint(frame(hint) + running);
      }
      if (data === 'x') count = reads.mock.calls.length;
    });
    await f.paint(frame('') + title(folder));
    const reads = vi.spyOn(f.session['renderer'], 'styledLines');
    await Promise.all([type(f.session, line + '\r', { submit }), f.session.write('x')]);
    expect(f.writes).toEqual([line, '\r', 'x']);
    expect(count).toBeGreaterThan(0);
    return count;
  }
  expect(await readsBeforeNextWrite(true)).toBe(await readsBeforeNextWrite(false));
});

it('reports the existing refusal after the supplied text failed to appear', async () => {
  const f = fixture('qoder');
  await f.paint(clear + rule + '\r\n > \r\n' + rule);
  expect(await type(f.session, line + '\r', { submit: true })).toMatchObject({
    submitted: false, submitRetried: false, outcome: 'withheld', reason: 'line-not-seen',
  });
  expect(f.writes).toEqual([line]);
}, 12_000);

it('reports unconfirmed when the draft remains after both Enters', async () => {
  const { result, writes } = await museTurn({ submit: true }, running);
  expect(result).toMatchObject({ submitted: false, submitRetried: true, outcome: 'unconfirmed' });
  expect(result).not.toHaveProperty('reason');
  expect(writes).toEqual([line, '\r', '\r']);
});

it.each(['queued edit', 'running turn', 'menu'])('keeps empty wire data empty over a %s', async scenario => {
  const f = fixture(scenario === 'menu' ? 'codex' : 'muse', data => {
    if (data === 'x') void f.paint(frame(line + 'x') + '\x1b[2;6H');
  });
  const screen = scenario === 'menu' ? 'Choose a colour\r\n› Blue\x1b[2;5H' :
    frame(line) + '\x1b[2;6H' + (scenario === 'running turn' ? running : '');
  await f.paint(screen);
  const edit = scenario === 'queued edit' ? f.session.write('x', { humanInput: true }) : undefined;
  await type(f.session, '', { submit: true });
  await edit;
  expect(f.writes).toEqual(scenario === 'queued edit' ? ['x', ''] : ['']);
});

it.each(['restored viewer draft', 'transcript copy'])('omits an idle flag for a %s', async scenario => {
  const qoder = (s: string) => clear + rule + '\r\n > ' + s + '\r\n' + rule;
  const f = fixture(scenario === 'restored viewer draft' ? 'muse' : 'qoder');
  if (scenario === 'restored viewer draft') {
    await f.session.write(line, { humanInput: true });
    await f.paint(frame(line) + '\x1b[2;5H\x1b[?1049h' + clear);
  } else {
    await f.paint(qoder(''));
  }
  await type(f.session, line, { submit: false });
  await f.paint(scenario === 'restored viewer draft' ? '\x1b[?1049l' : qoder(line) + '\x1b[2;5H');
  let now = Date.now() + 61_000;
  const daemon = Object.create(Daemon.prototype) as Daemon;
  Object.assign(daemon, { manager: { list: () => [f.session.summary()], get: () => f.session },
    schedules: { read: () => [] }, nudges: { tick() {} }, promptGraceTimers: new Map(), promptStates: new Map(),
    options: {}, now: () => now, updateFeedSession() {} });
  await daemon['scanForPromptStalls']();
  expect(f.session.summary()).not.toHaveProperty('unsubmittedInput');
  if (scenario === 'transcript copy') {
    await f.paint(clear + 'History\r\n > ' + line + '\r\n' + rule + '\r\nEnd of history');
    now += 60_000;
    await daemon['scanForPromptStalls']();
    expect(f.session.summary()).not.toHaveProperty('unsubmittedInput');
  }
});
