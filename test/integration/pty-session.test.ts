/**
 * Real-PTY session tests (design §6: integration on real PTYs, no mocks).
 * Exercises SessionManager + Session directly, in-process.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { keyToBytes } from '../../src/core/keys.js';
import type { Session } from '../../src/core/session.js';
import { eventually, interactiveShell, makeTempHome, processAlive, removeTempHome } from './helpers.js';

/**
 * Sink programs live as real files under test/fixtures rather than being
 * generated into a string here: their whole job is to handle escape sequences
 * (ESC, CR, LF) exactly, and escaping those through a generator is an easy
 * way to produce sinks that do not parse.
 */
function fixturePath(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);
}

/** DECTCEM hide, which `viewerState` appends when the program hid its cursor. */
const CURSOR_HIDE = '\x1b[?25l';

const managers: SessionManager[] = [];
function makeManager(): SessionManager {
  const manager = new SessionManager(compilePolicy(undefined));
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length > 0) await managers.pop()?.killAll();
});

function waitForExit(session: Session, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (session.exited) {
      resolve(session.exitCode ?? -1);
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('session did not exit in time')),
      timeoutMs,
    );
    session.onExit((code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

describe('PTY sessions', () => {
  it('write resolves with the screen as it was just before its own input went in', async () => {
    const manager = makeManager();
    const session = manager.create(interactiveShell());
    await session.waitFor({ quiet: 700 }, { timeout: 20_000 });

    // Not submitted: the shell only echoes it.
    const beforeFirst = await session.write('echo FIRST-MARK');
    expect(beforeFirst).not.toContain('FIRST-MARK');
    await eventually(async () => (await session.snapshot()).screen.includes('FIRST-MARK'), 20_000);

    // The second write's screen holds the first one's echo, and not its own.
    const beforeSecond = await session.write('-SECOND-MARK');
    expect(beforeSecond).toContain('FIRST-MARK');
    expect(beforeSecond).not.toContain('SECOND-MARK');
  });

  it('round-trips a typed command: echo appears, then output appears', async () => {
    const manager = makeManager();
    const session = manager.create(interactiveShell());
    // Let the shell paint its banner/prompt before typing (§3.1: first paint ≠ ready).
    await session.waitFor({ quiet: 700 }, { timeout: 20_000 });

    await session.write(`echo hello-round-trip${keyToBytes('enter') ?? '\r'}`);
    // The marker must appear TWICE: once as the echo of what we typed, once as
    // command output. Waiting for two occurrences dodges the echo trap.
    await eventually(async () => {
      const snap = await session.snapshot();
      return (snap.screen.match(/hello-round-trip/g) ?? []).length >= 2;
    }, 20_000);

    const snapshot = await session.snapshot();
    expect(snapshot.exited).toBe(false);
    expect(snapshot.screen).toContain('hello-round-trip');
  });

  it('delivers input larger than the chunk threshold in full, front included', async () => {
    // Session.write splits input above WRITE_CHUNK_CHARS. This pins the property
    // that matters about that split: chunking must not lose or reorder anything.
    // The FRONT marker is the meaningful assertion: a chunked write that dropped
    // or transposed a piece would show up there first.
    const manager = makeManager();
    const session = manager.create(interactiveShell());
    await session.waitFor({ quiet: 700 }, { timeout: 20_000 });

    // Comfortably over the threshold so the chunking path is the one under test.
    const filler = 'x'.repeat(3000);
    await session.write(`echo FRONT-${filler}-BACK\r`);

    // The tail appears last, so waiting on it means the whole line has landed.
    await eventually(async () => {
      const snap = await session.snapshot();
      return (snap.screen.match(/-BACK/g) ?? []).length >= 2;
    }, 25_000);

    const snapshot = await session.snapshot();
    // Both ends present, the front included.
    expect(snapshot.screen).toContain('FRONT-');
    expect(snapshot.screen).toContain('-BACK');
  });

  it('serialises concurrent writes so a keystroke cannot land mid-chunk', async () => {
    // What this guards: chunking yields between pieces, so a second
    // write issued while a large one is still in flight could interleave and
    // produce gibberish. That is not hypothetical here: a human typing into the
    // shared viewer while an agent sends a long prompt is the tool's whole point,
    // and xterm delivers a clipboard paste as one multi-character string.
    //
    // Two writes are started WITHOUT awaiting the first, which is exactly how the
    // viewer's data handler issues them. If ordering held, the shell sees two
    // clean lines; if it did not, it sees one corrupted one.
    const manager = makeManager();
    const session = manager.create(interactiveShell());
    await session.waitFor({ quiet: 700 }, { timeout: 20_000 });

    const big = 'y'.repeat(3000);
    const first = session.write(`echo BIG-${big}-END\r`);
    const second = session.write('echo SECOND-LINE-INTACT\r');
    await Promise.all([first, second]);

    await eventually(async () => {
      const snap = await session.snapshot();
      return (snap.screen.match(/SECOND-LINE-INTACT/g) ?? []).length >= 2;
    }, 25_000);

    const snapshot = await session.snapshot();
    // The second command survived whole. An interleaved write would have spliced
    // it into the middle of the first and the shell would never have run it.
    expect(snapshot.screen).toContain('SECOND-LINE-INTACT');
    expect(snapshot.screen).toContain('-END');
  });

  it('ctrl+c interrupts a long-running child and the shell prompts again', async () => {
    const manager = makeManager();
    const session = manager.create(interactiveShell());
    await session.waitFor({ quiet: 700 }, { timeout: 20_000 });

    // Start a spinner that would run forever, typed into the shell like a human.
    await session.write(`node -e "console.log('SPINNING'); setInterval(() => {}, 100)"\r`);
    const spinning = await session.waitFor({ text: 'SPINNING' }, { timeout: 20_000 });
    expect(spinning.matched).toBe(true);

    await session.write(keyToBytes('ctrl+c') ?? '\x03');
    await session.waitFor({ quiet: 1_500 }, { timeout: 15_000 });

    // Proof of interruption: the shell accepts a NEW command afterwards.
    //
    // Two things make this hostile under parallel load. Windows cmd may ask
    // "Terminate batch job (Y/N)?" at any point, and a probe typed before that
    // prompt appears is eaten as an invalid answer, so answer the prompt
    // whenever it is on screen, and RE-probe periodically rather than trusting
    // a single attempt. Each probe carries a unique marker and must appear
    // twice (its echo plus its output), so echoes of two different probes can
    // never add up to a false pass.
    let attempt = 0;
    let marker = '';
    let lastProbeAt = 0;
    let lastScreen = '';
    try {
      await eventually(async () => {
        const screen = (await session.snapshot()).screen;
        lastScreen = screen;
        if (/Terminate batch job/i.test(screen)) {
          await session.write('y\r');
          return false;
        }
        if (marker !== '' && (screen.match(new RegExp(marker, 'g')) ?? []).length >= 2) {
          return true;
        }
        if (Date.now() - lastProbeAt > 5_000) {
          attempt++;
          marker = `interrupt-ok-${String(attempt)}`;
          await session.write(`echo ${marker}\r`);
          lastProbeAt = Date.now();
        }
        return false;
        // Ninety seconds for the probe loop: Windows cmd's "Terminate batch
        // job" prompt makes the number of probes it takes genuinely variable,
        // and a heavily loaded machine slows each one down.
      }, 90_000, 250);
    } catch (error) {
      // Show the screen, so a failure can be diagnosed rather than guessed at.
      throw new Error(
        `${String(error)}\nprobes sent: ${String(attempt)}, last marker: ${marker}\n` +
          `exited: ${String(session.exited)}\n--- last screen ---\n${lastScreen}\n---`,
        { cause: error },
      );
    }
    expect(session.exited).toBe(false);
    // The whole test gets more than the probe loop it contains, or the loop's
    // own budget could never be reached.
  }, 150_000);

  it('captures the exit code of a direct (unwrapped) process', async () => {
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      shell: false,
    });
    const code = await waitForExit(session);
    expect(code).toBe(7);
    expect(session.exited).toBe(true);
    expect(session.exitCode).toBe(7);
  });

  it('propagates the exit code through the daemon-side shell wrapper', async () => {
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      // Args are SHELL TEXT under shell:true, so the parentheses must be quoted
      // or /bin/sh reads them as syntax (exit 2).
      args: ['-e', '"process.exit(9)"'],
      shell: true, // cmd.exe /c … on Windows, /bin/sh -c … elsewhere
    });
    const code = await waitForExit(session);
    expect(code).toBe(9);
  });

  it('resize changes geometry and the session stays usable', async () => {
    const manager = makeManager();
    const session = manager.create(interactiveShell());
    await session.waitFor({ quiet: 700 }, { timeout: 20_000 });

    session.resize(100, 30);
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);

    await session.write('echo after-resize-ok\r');
    await eventually(async () => {
      const snap = await session.snapshot();
      return (snap.screen.match(/after-resize-ok/g) ?? []).length >= 2;
    }, 20_000);
    const snapshot = await session.snapshot();
    expect(snapshot.cols).toBe(100);
    expect(snapshot.rows).toBe(30);
  });

  it('reports ready=false until readyText appears (§3.1: first paint ≠ ready)', async () => {
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      args: [
        '-e',
        "setTimeout(() => { console.log('BOOT-COMPLETE'); setInterval(() => {}, 100); }, 1500)",
      ],
      shell: false,
      readyText: 'BOOT-COMPLETE',
    });
    expect(session.ready).toBe(false);
    expect(session.readyReason).toBe('pending');
    await eventually(() => session.ready, 20_000);
    expect(session.ready).toBe(true);
    expect(session.readyReason).toBe('condition-met');
  });

  it('readyQuiet does not hold before the program has painted anything', async () => {
    // A command that sleeps before its first write. "No output for N ms"
    // alone would hold vacuously from spawn, because ConPTY's own mode-set
    // sequences at start render nothing and a program still loading emits
    // nothing, and a prompt typed on that false ready would be discarded by a
    // CLI still loading its MCP servers.
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      args: [
        '-e',
        "setTimeout(() => { console.log('FIRST-PAINT'); setInterval(() => {}, 100); }, 1500)",
      ],
      shell: false,
      readyQuiet: 300,
    });
    expect(session.readyReason).toBe('pending');

    // Well past 300 ms of silence, and nothing has painted: not ready.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(session.ready).toBe(false);
    expect(session.readyReason).toBe('pending');

    // The first paint, then 300 ms of quiet: ready, for the right reason.
    await eventually(() => session.ready, 20_000);
    expect(session.readyReason).toBe('condition-met');
    expect((await session.snapshot()).screen).toContain('FIRST-PAINT');
  });

  it('a prompt wait after answering does not return the answered prompt', async () => {
    // wait prompt:true → enter → wait prompt:true can look before the TUI has
    // repainted, with the question just answered still on screen. The fixture
    // reproduces the TUI's latency (400 ms before it clears the block), then
    // asks the identical question again 1.5 s later, which the wait must
    // report, and only then.
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      args: [fixturePath('prompt-sink.mjs')],
      shell: false,
    });
    const first = await session.waitFor({ prompt: true }, { timeout: 15_000 });
    expect(first.matched).toBe(true);
    expect(first.prompt?.question).toMatch(/allow this command/i);

    await session.write('\r');
    const second = await session.waitFor({ prompt: true }, { timeout: 10_000 });
    expect(second.matched).toBe(true);
    // Matching here in ~0 ms would return the block enter had dismissed.
    expect(second.waitedMs).toBeGreaterThanOrEqual(1_500);
    expect(second.screen).not.toContain('Running');
    expect(second.prompt?.question).toMatch(/allow this command/i);
  });

  it('reports readyReason=not-tracked when no condition was given (§3.1)', () => {
    // `ready: true` here means only "nothing is being checked", but it reads as
    // a green light, and agent CLIs silently discard input for tens of seconds
    // while they load. The reason is what lets a caller tell the two apart.
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      args: ['-e', "console.log('no-readiness-condition'); setInterval(() => {}, 100)"],
      shell: false,
    });
    expect(session.ready).toBe(true);
    expect(session.readyReason).toBe('not-tracked');
    expect(session.summary().readyReason).toBe('not-tracked');
  });

  it('start geometry says where to begin; only hold keeps it there', () => {
    const manager = makeManager();
    // A size at start is a starting size: freezing the grid would leave a
    // viewer unable to fill a window of a different shape.
    const sized = manager.create({
      command: process.execPath,
      args: ['-e', "console.log('sized'); setInterval(() => {}, 100)"],
      shell: false,
      cols: 120,
      rows: 34,
    });
    expect(sized.geometryHeld).toBe(false);
    expect(sized.cols).toBe(120);

    // A resize that says nothing about holding leaves the setting alone, so a
    // viewport following a window cannot release a hold a run depends on.
    sized.resize(90, 28);
    expect(sized.geometryHeld).toBe(false);
    expect(sized.cols).toBe(90);

    const held = manager.create({
      command: process.execPath,
      args: ['-e', "console.log('held'); setInterval(() => {}, 100)"],
      shell: false,
      cols: 100,
      rows: 30,
      hold: true,
    });
    expect(held.geometryHeld).toBe(true);
    expect(held.summary().geometryHeld).toBe(true);

    // And holding can be asked for, or given up, on a running session.
    sized.resize(110, 32, { hold: true });
    expect(sized.geometryHeld).toBe(true);
    sized.resize(110, 32, { hold: false });
    expect(sized.geometryHeld).toBe(false);
  });

  it('KILLS THE WHOLE PROCESS TREE: the grandchild dies too (design §3.1)', async () => {
    // Shell-wrapped session: the PTY child is the shell, node is the
    // grandchild. Killing only the PTY child would orphan node: the exact
    // failure mode that leaves agent CLIs running and spending API tokens.
    const home = makeTempHome('shellpuppet-treekill-');
    const pidFile = path.join(home, 'grandchild.pid');
    try {
      const script =
        "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
      const manager = makeManager();
      const session = manager.create({
        command: process.execPath,
        args: ['-e', `"${script}"`, `"${pidFile}"`],
        shell: true,
      });

      await eventually(() => fs.existsSync(pidFile), 20_000);
      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(processAlive(grandchildPid)).toBe(true);

      await manager.kill(session.id);

      await eventually(() => !processAlive(grandchildPid), 15_000);
      expect(processAlive(grandchildPid)).toBe(false);
    } finally {
      removeTempHome(home);
    }
  });

  it('lastLines reaches back into scrollback past the viewport', async () => {
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      args: [
        '-e',
        '"for (let i = 1; i <= 60; i++) console.log(\'scroll-line-\' + String(i).padStart(2, \'0\'))"',
      ],
      rows: 10,
      shell: true,
    });
    await waitForExit(session);
    await session.waitFor({ quiet: 300 }, { timeout: 5_000 });

    const tail = await session.lastLines(40);
    const joined = tail.join('\n');
    expect(joined).toContain('scroll-line-60');
    expect(joined).toContain('scroll-line-30'); // long gone from the 10-row viewport
  });

  // Long input and TUIs: the write path must match what the program asked for.
  // A TUI can keep only the last burst of a chunked write, so a long prompt
  // sent in chunks may arrive as its tail alone. Programs that enable
  // bracketed paste (DEC 2004) ask for one atomic paste event; these two tests
  // pin both halves of that contract.
  it('wraps long input in bracketed paste when the program enabled DEC 2004', async () => {
    const manager = makeManager();
    const sink = fixturePath('paste-sink.mjs');

    // shell:false with a PLAIN path: quoting the arg for a shell wrap makes the
    // quotes part of the filename on POSIX, where nothing strips them, so the
    // spawn fails and the test times out on Linux CI only.
    const session = manager.create({
      command: 'node',
      args: [sink],
      shell: false,
      cols: 120,
      rows: 20,
    });
    await eventually(async () => (await session.snapshot()).screen.includes('SINK READY'), 20_000);

    await session.write(`FRONTMARK${'x'.repeat(1200)}TAILMARK\r`);

    await eventually(async () => (await session.snapshot()).screen.includes('RESULT'), 20_000);
    const line = (await session.snapshot()).screen.split('\n').find((l) => l.startsWith('RESULT')) ?? '';
    // ConPTY can strip ESC[200~/ESC[201~ off the INPUT path (seen on
    // windows-latest with Node 20): it implements bracketed paste itself and
    // does not forward ours to the child. The child then reports no markers
    // even though the mode was seen, the flag was set and the write was
    // wrapped. That is a property of the Windows console transport, not of
    // this code, and no change here can alter it.
    //
    // So the contract worth pinning is asserted on EVERY platform:
    //   - the paste branch was taken, i.e. ONE atomic write and no chunking,
    //     which is what keeps a long prompt from reaching a TUI with only
    //     its tail;
    //   - the content arrived whole, front marker and tail marker both.
    // Marker delivery is asserted only where the transport preserves markers.
    // The wrapped-write assertion is a real check on Windows too: it fails
    // there if the paste branch ever stops being taken.
    expect(session.lastWriteWrapped).toBe(true);
    // The FRONT is the assertion that matters: it is what chunking loses.
    expect(line).toContain('front=true');
    expect(line).toContain('tail=true');
    if (process.platform !== 'win32') {
      expect(line).toContain('bracketed=true');
    }
  }, 40_000);

  it('still chunks long input for a program that never enabled bracketed paste', async () => {
    const manager = makeManager();
    const sink = fixturePath('plain-sink.mjs');

    // shell:false with a PLAIN path: quoting the arg for a shell wrap makes the
    // quotes part of the filename on POSIX, where nothing strips them, so the
    // spawn fails and the test times out on Linux CI only.
    const session = manager.create({
      command: 'node',
      args: [sink],
      shell: false,
      cols: 120,
      rows: 20,
    });
    await eventually(async () => (await session.snapshot()).screen.includes('SINK READY'), 20_000);

    await session.write(`FRONTMARK${'x'.repeat(1200)}TAILMARK\r`);

    await eventually(async () => (await session.snapshot()).screen.includes('RESULT'), 20_000);
    const line = (await session.snapshot()).screen.split('\n').find((l) => l.startsWith('RESULT')) ?? '';
    // No markers injected, and chunking still delivers every byte: the 4 KB
    // canonical-mode limit is why the chunked path stays for these programs.
    expect(line).toContain('markers=false');
    expect(line).toContain('front=true');
    expect(line).toContain('tail=true');
  }, 40_000);

  it('the viewer state carries a hidden cursor, and stops carrying it after a reset', async () => {
    // xterm's serialisation omits DECTCEM, so `viewerState` appends the hide
    // itself (design §5). Without it a program that hides its cursor would
    // get a blinking one drawn over its TUI in the human's window.
    const manager = makeManager();
    const session = manager.create({
      command: process.execPath,
      args: [
        '-e',
        [
          // Hide the cursor, then a second later reset the terminal, which
          // brings it back.
          "process.stdout.write('\\x1b[?25lHIDDEN\\r\\n');",
          "setTimeout(() => process.stdout.write('\\x1bcRESTORED\\r\\n'), 1000);",
          'setInterval(() => {}, 200);',
        ].join('\n'),
      ],
      shell: false,
      cols: 80,
      rows: 20,
    });

    await eventually(async () => (await session.snapshot()).screen.includes('HIDDEN'), 20_000);
    const hidden = await session.viewerState();
    expect(hidden.endsWith(CURSOR_HIDE)).toBe(true);

    await eventually(async () => (await session.snapshot()).screen.includes('RESTORED'), 20_000);
    const restored = await session.viewerState();
    expect(restored.endsWith(CURSOR_HIDE)).toBe(false);
  }, 40_000);
});
