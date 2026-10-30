/**
 * Bracketed-paste tracking across a terminal reset.
 *
 * The daemon writes long input as one atomic paste when the program has
 * enabled DEC 2004, and in chunks when it has not. Which path it takes is
 * decided by a scan of the program's own output, and that scan follows the
 * emulator the daemon mirrors, which turns the mode off on a reset as well
 * as on `?2004l`: in @xterm/headless, RIS (`ESC c`) and DECSTR's soft
 * reset both reach `CoreService.reset()`, which puts the DEC private modes
 * back to their defaults, where bracketed paste is false.
 *
 * A scan that missed the reset would leave the daemon's flag and the
 * program's real mode disagreeing, and the next long paste would go out
 * wrapped in `ESC[200~` and `ESC[201~` markers the program does not expect,
 * which it reads as literal input.
 *
 * `session.lastWriteWrapped` is the crisp assertion, the diagnostic that
 * exists for exactly this question, with the leak asserted where the
 * transport preserves markers. ConPTY strips them, which is why the second
 * half is POSIX-only (see the comment in pty-session.test.ts).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { eventually } from './helpers.js';

const managers: SessionManager[] = [];
function makeManager(): SessionManager {
  const manager = new SessionManager(compilePolicy(undefined));
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length > 0) await managers.pop()?.killAll();
});

/** Enable DEC 2004, then reset the terminal: RIS by default, DECSTR with soft. */
function resettingSink(soft: boolean): string {
  const reset = soft ? '\\x1b[!p' : '\\x1bc';
  return [
    "process.stdout.write('\\x1b[?2004h');",
    'setTimeout(() => {',
    `  process.stdout.write('${reset}\\x1b[?25hRESET READY\\r\\n');`,
    '}, 400);',
    'process.stdin.setRawMode?.(true);',
    'process.stdin.resume();',
    "process.stdin.on('data', (b) => {",
    "  const s = b.toString('utf8');",
    '  if (/[\\r\\n]/.test(s)) {',
    "    process.stdout.write(`\\r\\nRESULT bracketed=${s.includes('\\x1b[200~')}\\r\\n`);",
    '  }',
    '});',
  ].join('\n');
}

async function screenShows(
  session: { snapshot: () => Promise<{ screen: string }> },
  text: string,
): Promise<void> {
  await eventually(async () => (await session.snapshot()).screen.includes(text), 20_000);
}

async function expectPasteOffAfterReset(soft: boolean): Promise<void> {
  const manager = makeManager();
  const session = manager.create({
    command: process.execPath,
    args: ['-e', resettingSink(soft)],
    shell: false,
    cols: 120,
    rows: 20,
  });

  // The reset must have happened, and been seen by the daemon's scan, before
  // the write under test.
  await screenShows(session, 'RESET READY');

  // Over WRITE_CHUNK_CHARS (1024), so the two paths diverge.
  await session.write(`${'p'.repeat(1_500)}\r`);
  await screenShows(session, 'RESULT');

  // After a reset the program no longer has DEC 2004 on, so the paste branch
  // must not be taken.
  expect(session.lastWriteWrapped).toBe(false);

  // And the observable consequence, where the transport keeps markers: a
  // stale wrap leaks ESC[200~ and ESC[201~ into the program as literal bytes.
  if (process.platform !== 'win32') {
    const line =
      (await session.snapshot()).screen.split('\n').find((l) => l.includes('RESULT')) ?? '';
    expect(line).toContain('bracketed=false');
  }
}

describe('bracketed paste across a terminal reset', () => {
  it('a full reset (RIS) turns it off, so a long write is not wrapped', async () => {
    await expectPasteOffAfterReset(false);
  }, 40_000);

  it('a soft reset (DECSTR) turns it off, so a long write is not wrapped', async () => {
    await expectPasteOffAfterReset(true);
  }, 40_000);
});
