import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitConditionError, waitFor } from '../../src/core/waiter.js';
import type { WaitTarget } from '../../src/core/waiter.js';
import { StalePromptGuard } from '../../src/core/promptDetector.js';

/** Scriptable stand-in for a live session. */
class FakeTarget implements WaitTarget {
  screen = '';
  exited = false;
  painted = false;
  private lastChange = Date.now();
  private lastInputData: string | null = null;
  private readonly stalePrompts = new StalePromptGuard();

  getScreen(): string {
    return this.screen;
  }
  lastChangeAt(): number {
    return this.lastChange;
  }
  isExited(): boolean {
    return this.exited;
  }
  hasPainted(): boolean {
    return this.painted;
  }
  lastInput(): string | null {
    return this.lastInputData;
  }
  observePrompt(signature: string | null): void {
    this.stalePrompts.observe(signature);
  }
  isStalePrompt(signature: string): boolean {
    return this.stalePrompts.isStale(signature);
  }
  /** Simulate PTY output arriving now. */
  emit(text: string): void {
    this.screen += text;
    this.painted = true;
    this.lastChange = Date.now();
  }
  /** Simulate input being written to the program, exactly as the session records it. */
  type(data: string): void {
    this.lastInputData = data;
    this.stalePrompts.noteInput(this.screen);
  }
}

// Coarse poll interval keeps fake-timer advancement cheap.
const POLL = { pollIntervalMs: 50 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('waitFor text/regex', () => {
  it('resolves when the text appears in later output', async () => {
    const target = new FakeTarget();
    const wait = waitFor(target, { text: 'Ready' }, POLL);
    await vi.advanceTimersByTimeAsync(200);
    target.emit('goose is READY');
    await vi.advanceTimersByTimeAsync(100);
    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'text' });
    expect(result.screen).toContain('READY');
  });

  it('matches regex case-insensitively', async () => {
    const target = new FakeTarget();
    target.emit('Status: 17 of 23 servers loaded');
    const result = await waitFor(target, { regex: 'status: \\d+ of \\d+' }, POLL);
    expect(result).toMatchObject({ matched: true, reason: 'regex' });
  });

  it('^ and $ anchor to LINES of the screen, matching terminal_find', async () => {
    // A REPL prints 42 on its own line: `wait regex ^42` must match it, as
    // `find ^42` does, rather than binding the anchor to the start of the
    // whole joined screen.
    const target = new FakeTarget();
    target.emit('> 6*7\n42\n>');
    const result = await waitFor(target, { regex: '^42$' }, POLL);
    expect(result).toMatchObject({ matched: true, reason: 'regex' });
  });

  it('the echo trap, by default: waiting for text you just typed matches its echo in ~0 ms', async () => {
    // Measured at 0 ms (design §3.1): type `Write-Host 'HELLO'`, wait for
    // HELLO, and the *echo of the input* matches before any output exists.
    // Without matchAfterInput the waiter does not distinguish echo from
    // output. This pins the default so the mitigation stays in the tool
    // descriptions: wait on output-only text, use quiet or opt in to
    // matchAfterInput (the tests below).
    const target = new FakeTarget();
    target.type("Write-Host 'HELLO'\r");
    target.emit(`PS D:\\> Write-Host 'HELLO'`); // the echo, with no output yet
    const result = await waitFor(target, { text: 'HELLO' }, POLL);
    expect(result.matched).toBe(true);
    expect(result.waitedMs).toBe(0);
  });

  it('reports the match even when the process exits on the same tick', async () => {
    const target = new FakeTarget();
    target.emit('done: all tests passed');
    target.exited = true;
    const result = await waitFor(target, { text: 'all tests passed' }, POLL);
    expect(result).toMatchObject({ matched: true, reason: 'text' });
  });
});

/**
 * matchAfterInput for text/regex: a warning alone does not avoid the echo
 * trap, because a regex that describes the expected OUTPUT (`PY_FILES\s*=`)
 * is by nature also in the prompt that asked for it. The guard ignores
 * matches at or before the echo of the last input.
 */
describe('waitFor text/regex with matchAfterInput', () => {
  it('ignores the echo of the typed text and waits for the output', async () => {
    const target = new FakeTarget();
    target.type("Write-Host 'HELLO'\r");
    target.emit(`PS D:\\> Write-Host 'HELLO'`); // the echo, with no output yet
    const wait = waitFor(target, { text: 'HELLO' }, { ...POLL, matchAfterInput: true });
    await vi.advanceTimersByTimeAsync(300);
    target.emit('\nHELLO\nPS D:\\>'); // the program's output
    await vi.advanceTimersByTimeAsync(100);
    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'text' });
    expect(result.waitedMs).toBeGreaterThanOrEqual(300);
  });

  it('a regex describing the expected output does not match the prompt that asked for it', async () => {
    // The submitted prompt mentions PY_FILES=, so without the guard a wait
    // for `PY_FILES\s*=` matches that echo at once.
    const target = new FakeTarget();
    const typed = 'Find the Python files and print PY_FILES=<list> when done';
    target.type(`${typed}\r`);
    target.emit(`│ > ${typed}\n\n● Working…`);
    const wait = waitFor(target, { regex: 'PY_FILES\\s*=' }, { ...POLL, matchAfterInput: true });
    await vi.advanceTimersByTimeAsync(500);
    target.emit('\n● PY_FILES = a.py b.py');
    await vi.advanceTimersByTimeAsync(100);
    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'regex' });
    expect(result.waitedMs).toBeGreaterThanOrEqual(500);
  });

  it('places the echo even when the TUI re-wrapped the prompt across rows', async () => {
    const target = new FakeTarget();
    const typed = 'List the Python files: set PY_FILES = the files under src, then print them';
    target.type(`${typed}\r`);
    target.emit(
      '│ > List the Python files: set PY_FILES = the files\n│   under src, then print them\n',
    );
    const wait = waitFor(target, { regex: 'PY_FILES\\s*=' }, { ...POLL, matchAfterInput: true });
    await vi.advanceTimersByTimeAsync(200);
    target.emit('\n● PY_FILES = a.py');
    await vi.advanceTimersByTimeAsync(100);
    const result = await wait;
    expect(result.matched).toBe(true);
    // From the program's line, not from the wrapped echo above it.
    expect(result.waitedMs).toBeGreaterThanOrEqual(200);
  });

  it('says why when the only matches lay in the echo', async () => {
    const target = new FakeTarget();
    target.type("Write-Host 'HELLO'\r");
    target.emit(`PS D:\\> Write-Host 'HELLO'`);
    const wait = waitFor(target, { text: 'HELLO' }, { ...POLL, matchAfterInput: true, timeout: 500 });
    await vi.advanceTimersByTimeAsync(600);
    const result = await wait;
    expect(result).toMatchObject({ matched: false, reason: 'timeout' });
    expect(result.detail).toMatch(/echo of your last input/i);
  });

  it('applies no echo guard when nothing has been typed or the input is a bare key', async () => {
    const target = new FakeTarget();
    target.emit('READY');
    expect((await waitFor(target, { text: 'ready' }, { ...POLL, matchAfterInput: true })).matched).toBe(true);
    target.type('\r');
    expect((await waitFor(target, { text: 'ready' }, { ...POLL, matchAfterInput: true })).matched).toBe(true);
  });
});

describe('waitFor debounce (settle after match)', () => {
  it('holds the match until the screen has been stable for debounce ms', async () => {
    const target = new FakeTarget();
    const wait = waitFor(target, { text: 'menu' }, { ...POLL, debounce: 300 });
    target.emit('menu'); // match found, but the TUI keeps painting…
    await vi.advanceTimersByTimeAsync(100);
    target.emit(' [1] option one');
    await vi.advanceTimersByTimeAsync(100);
    target.emit(' [2] option two');
    // …now it settles.
    await vi.advanceTimersByTimeAsync(400);
    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'text' });
    expect(result.screen).toContain('[2] option two'); // settled screen, not first-match screen
    expect(result.waitedMs).toBeGreaterThanOrEqual(500);
  });

  it('does not lose the match when the process exits mid-settle', async () => {
    const target = new FakeTarget();
    const wait = waitFor(target, { text: 'finished' }, { ...POLL, debounce: 5_000 });
    target.emit('finished');
    await vi.advanceTimersByTimeAsync(100);
    target.exited = true; // exit long before the debounce window lapses
    await vi.advanceTimersByTimeAsync(200);
    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'text' });
  });
});

describe('waitFor quiet', () => {
  it('does not resolve while output keeps arriving, then resolves once quiet', async () => {
    const target = new FakeTarget();
    target.emit('booting…');
    const wait = waitFor(target, { quiet: 500 }, POLL);

    let settled = false;
    void wait.then(() => {
      settled = true;
    });

    // Output every 100 ms for a second, never 500 ms of quiet.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      target.emit('.');
    }
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'quiet' });
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_500);
  });

  it('quiet is NOT satisfied by a session that has never painted', async () => {
    // A program that has not started satisfies "no output for N ms"
    // vacuously, which would make "not started" indistinguishable from
    // "finished and idle", and a prompt typed on that false ready would go
    // into a CLI still loading its MCP servers. Quiet needs a first paint
    // before the silence can count.
    const target = new FakeTarget();
    const wait = waitFor(target, { quiet: 200 }, { ...POLL, timeout: 5_000 });
    let settled = false;
    void wait.then(() => {
      settled = true;
    });

    // 1.5 s of silence from a program that has never painted is not quiet.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(false);

    // First paint, then the same 200 ms of silence: now it is.
    target.emit('booted');
    await vi.advanceTimersByTimeAsync(300);
    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'quiet' });
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_700);
  });

  it('says why when quiet times out on a program that never painted', async () => {
    // A timeout is an answer, but "still starting" and "printed nothing" are
    // different answers, and only the waiter can tell which one this was.
    const target = new FakeTarget();
    const wait = waitFor(target, { quiet: 200 }, { ...POLL, timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await wait;
    expect(result).toMatchObject({ matched: false, reason: 'timeout' });
    expect(result.detail).toMatch(/not painted anything/i);
  });

  it('a program that exits without ever painting reports exited, not quiet', async () => {
    const target = new FakeTarget();
    const wait = waitFor(target, { quiet: 100 }, { ...POLL, timeout: 5_000 });
    await vi.advanceTimersByTimeAsync(300);
    target.exited = true;
    await vi.advanceTimersByTimeAsync(300);
    const result = await wait;
    expect(result).toMatchObject({ matched: false, reason: 'exited' });
  });
});

describe('waitFor termination', () => {
  it('reports exited when the process dies before any match', async () => {
    const target = new FakeTarget();
    target.emit('some unrelated output');
    const wait = waitFor(target, { text: 'never appears' }, POLL);
    await vi.advanceTimersByTimeAsync(100);
    target.exited = true;
    await vi.advanceTimersByTimeAsync(100);
    const result = await wait;
    expect(result).toMatchObject({ matched: false, reason: 'exited' });
  });

  it('times out at the default 60 s', async () => {
    const target = new FakeTarget();
    const wait = waitFor(target, { text: 'never' }, POLL);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await wait;
    expect(result).toMatchObject({ matched: false, reason: 'timeout' });
    expect(result.waitedMs).toBeGreaterThanOrEqual(60_000);
  });

  it('clamps the timeout to the 300 s maximum', async () => {
    const target = new FakeTarget();
    const wait = waitFor(target, { text: 'never' }, { ...POLL, timeout: 999_999_999 });
    await vi.advanceTimersByTimeAsync(300_000 + 1_000);
    const result = await wait;
    expect(result.reason).toBe('timeout');
    expect(result.waitedMs).toBeLessThanOrEqual(301_000);
  });
});

describe('waitFor validation', () => {
  const target = new FakeTarget();

  it('rejects zero conditions', () => {
    expect(() => waitFor(target, {}, POLL)).toThrow(WaitConditionError);
  });

  it('rejects multiple conditions', () => {
    expect(() => waitFor(target, { text: 'a', quiet: 100 }, POLL)).toThrow(WaitConditionError);
    expect(() => waitFor(target, { text: 'a', regex: 'b' }, POLL)).toThrow(WaitConditionError);
  });

  it('rejects an invalid regex with a clear message', () => {
    expect(() => waitFor(target, { regex: '(unclosed' }, POLL)).toThrow(/Invalid regular expression/);
  });

  it('rejects a negative quiet value', () => {
    expect(() => waitFor(target, { quiet: -1 }, POLL)).toThrow(WaitConditionError);
  });

  it('rejects a NaN timeout instead of waiting forever', () => {
    // `--timeout abc` becomes Number('abc') = NaN. Unvalidated, the deadline
    // comparison `now - startedAt >= NaN` is permanently false: the wait never
    // times out, the HTTP response never completes and the one-shot CLI
    // hangs forever, and its calling shell with it: the hang the CLI must
    // never cause, reachable by a typo.
    expect(() => waitFor(target, { text: 'x' }, { ...POLL, timeout: Number.NaN })).toThrow(
      WaitConditionError,
    );
  });

  it('rejects non-finite and negative timeout/debounce values', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => waitFor(target, { text: 'x' }, { ...POLL, timeout: bad })).toThrow(
        WaitConditionError,
      );
      // Unvalidated, a NaN debounce never "settles" and mislabels a real
      // match as a timeout.
      expect(() => waitFor(target, { text: 'x' }, { ...POLL, debounce: bad })).toThrow(
        WaitConditionError,
      );
    }
  });

  it('accepts zero for timeout and debounce', async () => {
    const zeroTarget = new FakeTarget();
    zeroTarget.emit('already here');
    const result = await waitFor(zeroTarget, { text: 'already here' }, { ...POLL, timeout: 0, debounce: 0 });
    expect(result.matched).toBe(true);
  });
});

/**
 * The supervision wait. The daemon announces held prompts to `daemon.log` and
 * the `/events` socket, but an agent reaches the daemon through
 * request-and-answer tool calls or one-shot CLI runs and can never hold that
 * socket, so this condition is how a manager agent waits for "my delegate
 * needs me" rather than polling snapshots. These pin it.
 */
describe('waitFor prompt', () => {
  /** A Qoder permission prompt. */
  const PROMPT_SCREEN = `
 Permission Required
────────────────────────────────────────────────────────────
 Tool: Bash

 Allow this command to run?

  ❯ 1. Allow once
    2. Reject and type something
`;

  it('resolves when a permission prompt appears, carrying its question', async () => {
    const target = new FakeTarget();
    const wait = waitFor(target, { prompt: true }, POLL);

    await vi.advanceTimersByTimeAsync(200);
    target.emit(PROMPT_SCREEN);
    await vi.advanceTimersByTimeAsync(100);

    const result = await wait;
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('prompt');
    // The question and options travel with the result so a caller can decide
    // the answer without a second round trip to read the screen it has.
    expect(result.prompt?.question).toContain('Allow this command to run?');
    expect(result.prompt?.options.length).toBeGreaterThanOrEqual(2);
  });

  it('does not match a busy screen with no prompt', async () => {
    const target = new FakeTarget();
    target.emit('Generating...\n  reading files\n');
    const wait = waitFor(target, { prompt: true }, { ...POLL, timeout: 500 });
    await vi.advanceTimersByTimeAsync(600);
    const result = await wait;
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(result.prompt).toBeUndefined();
  });

  it('matches a prompt already on screen when the wait begins', async () => {
    // "Wait until a prompt is showing": a supervisor asking whether its
    // delegate is blocked must get an answer for a prompt that has been
    // sitting there, which is precisely the case worth catching.
    const target = new FakeTarget();
    target.emit(PROMPT_SCREEN);
    const result = await waitFor(target, { prompt: true }, POLL);
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('prompt');
  });

  it('rejects prompt combined with another condition', () => {
    const target = new FakeTarget();
    expect(() => waitFor(target, { prompt: true, text: 'x' }, POLL)).toThrow(WaitConditionError);
  });

  it('treats prompt:false as no condition at all', () => {
    // The daemon parses this off a query string, where `?prompt=false` is easy
    // to send by accident; it must not silently become a prompt wait.
    const target = new FakeTarget();
    expect(() => waitFor(target, { prompt: false }, POLL)).toThrow(WaitConditionError);
  });
});

/**
 * The stale prompt. A supervisor's natural loop is wait prompt:true → answer
 * with enter → wait prompt:true, and the second wait can look before the
 * program has repainted, with the question just answered still on screen.
 * Returning it would have the supervisor answer a prompt that no longer
 * exists, into whatever has focus next.
 */
describe('waitFor prompt: the answered prompt is stale until seen to go', () => {
  const PROMPT = `
 Permission Required
 Allow this command to run?

  ❯ 1. Allow once
    2. No
`;

  it('does not return the prompt that was showing when the last input was sent', async () => {
    const target = new FakeTarget();
    target.emit(PROMPT);
    expect((await waitFor(target, { prompt: true }, POLL)).matched).toBe(true);

    // The supervisor answers. The program has not repainted yet.
    target.type('\r');
    const wait = waitFor(target, { prompt: true }, { ...POLL, timeout: 5_000 });
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toBe(false); // resolving here would return the prompt just answered

    // The program processes the answer, works, then asks the NEXT question
    // with identical text, which is common (the same command run twice).
    target.screen = ' Running… (1s)\n';
    target.emit('');
    await vi.advanceTimersByTimeAsync(200);
    target.screen = PROMPT;
    target.emit('');
    await vi.advanceTimersByTimeAsync(200);

    const result = await wait;
    expect(result).toMatchObject({ matched: true, reason: 'prompt' });
    expect(result.waitedMs).toBeGreaterThanOrEqual(600);
  });

  it('counts a prompt observed absent by someone else (a snapshot or the stall scan) between waits', async () => {
    const target = new FakeTarget();
    target.emit(PROMPT);
    target.type('\r');
    // Between the answer and the next wait, some other look at the screen
    // saw it without the prompt; the identical prompt now showing is new.
    target.observePrompt(null);
    const result = await waitFor(target, { prompt: true }, POLL);
    expect(result.matched).toBe(true);
  });

  it('a different prompt after the answer is new immediately', async () => {
    const target = new FakeTarget();
    target.emit(PROMPT);
    target.type('\r');
    target.screen = ' Do you trust the files in this folder?\n\n  ❯ 1. Trust folder\n    2. Exit\n';
    target.emit('');
    const result = await waitFor(target, { prompt: true }, POLL);
    expect(result.matched).toBe(true);
    expect(result.prompt?.question).toMatch(/trust/i);
  });

  it('says why when the prompt never changed after the input', async () => {
    // The program ignored the answer (or never received it). The wait must
    // not guess that the prompt is live; it reports what it saw.
    const target = new FakeTarget();
    target.emit(PROMPT);
    target.type('\r');
    const wait = waitFor(target, { prompt: true }, { ...POLL, timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await wait;
    expect(result).toMatchObject({ matched: false, reason: 'timeout' });
    expect(result.prompt).toBeUndefined();
    expect(result.detail).toMatch(/last input/i);
  });

  it('matchAfterInput:false accepts the prompt on screen regardless', async () => {
    const target = new FakeTarget();
    target.emit(PROMPT);
    target.type('\r');
    const result = await waitFor(target, { prompt: true }, { ...POLL, matchAfterInput: false });
    expect(result.matched).toBe(true);
    expect(result.waitedMs).toBe(0);
  });

  it('input sent when no prompt was showing makes nothing stale', async () => {
    const target = new FakeTarget();
    target.emit(' > \n');
    target.type('run the tests\r');
    target.screen = PROMPT;
    target.emit('');
    const result = await waitFor(target, { prompt: true }, POLL);
    expect(result.matched).toBe(true);
    expect(result.waitedMs).toBe(0);
  });
});

describe('waitFor prompt: debounce retraction', () => {
  const PROMPT = `
 Permission Required
 Allow this command to run?

  ❯ 1. Allow once
    2. No
`;

  it('does not report a prompt that vanished while the screen was settling', async () => {
    // With a debounce, the match is made on one tick and resolved on a later
    // one. If the human answers at the viewer in between, resolving
    // matched:true with the remembered question would have a supervisor
    // answer a prompt that is no longer on screen, sending keystrokes into
    // whatever replaced it.
    const target = new FakeTarget();
    target.emit(PROMPT);
    const wait = waitFor(target, { prompt: true }, { ...POLL, debounce: 300, timeout: 1_000 });

    // Answered before the debounce settles: the prompt block is gone.
    await vi.advanceTimersByTimeAsync(100);
    target.screen = ' Working on it\n';
    await vi.advanceTimersByTimeAsync(1_200);

    const result = await wait;
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(result.prompt).toBeUndefined();
  });

  it('still resolves when the prompt is there throughout the settle', async () => {
    // The other half: proving the retraction above does not simply break the
    // debounced path.
    const target = new FakeTarget();
    target.emit(PROMPT);
    const wait = waitFor(target, { prompt: true }, { ...POLL, debounce: 200, timeout: 2_000 });
    await vi.advanceTimersByTimeAsync(600);
    const result = await wait;
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('prompt');
    expect(result.prompt?.question).toContain('Allow this command to run?');
  });
});
