/**
 * node-pty 1.1.0's Windows exit watchers, one per terminal, removed their
 * terminal from a list every agent shares with no lock (microsoft/node-pty
 * #921), so two sessions whose programs ended at about the same moment could
 * crash the whole process with 0xC0000005 — in ShellPuppet the shared
 * daemon, taking every session with it. 1.2.0-beta.13 fixed the race with a
 * mutex (#922); the pin to 1.2.0-beta.18 is what this test guards.
 *
 * Each round starts many sessions through the session manager whose programs
 * all wait for one marker file and then end at one absolute moment, while
 * every session is resized throughout, as a busy daemon's viewers do — the
 * resize walks the same list the exit watchers remove from. Every exit must
 * be recorded and the test process must still be standing at the end: a
 * native crash kills the worker running this file.
 *
 * The race is a low-probability one, and honestly: this test could NOT be
 * made to crash node-pty 1.1.0 on the machine it was written on — not with 3
 * rounds of 16, 6 of 40 or 2 of 120 sessions ending together (528 in all,
 * over about eight minutes). It stays as a guard: the exits it drives are the
 * ones that crashed CI's workers, and it proves the shape works and every
 * exit is recorded on the pinned version. `SHELLPUPPET_PTY_CONCURRENT_HEAVY=1`
 * runs a longer, heavier version than CI takes by default.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import type { Session } from '../../src/core/session.js';
import { whenConsoleHostBatchSettled } from '../../src/core/windowsConsoleHost.js';
import { eventually } from './helpers.js';

const HEAVY = process.env['SHELLPUPPET_PTY_CONCURRENT_HEAVY'] === '1';
const ROUNDS = HEAVY ? 6 : 2;
const SESSIONS = HEAVY ? 40 : 16;
/**
 * How long a program waits for the marker before failing the round. It must
 * cover the whole paced start of the round (every program starts waiting
 * while its neighbours are still being started, and a start can take seconds
 * of its own), so that a program leaving with 9 means the round went wrong,
 * not that the starts were slow. The round's worst case is well under this.
 */
const WAIT_FOR_MARKER_MS = 120_000;
/** How far ahead the deadline the marker names is written. */
const MARKER_LEAD_MS = 350;

const managers: SessionManager[] = [];
const markerDirs: string[] = [];
afterEach(async () => {
  for (const dir of markerDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  while (managers.length > 0) await managers.pop()?.killAll();
});

/**
 * The argv of a program that prints one line, waits for the marker file and
 * then ends at the deadline the marker names (9 if it never appears): every
 * session's program holds itself ready, and the deadline — one absolute
 * moment written into the marker — lets them all end together, as a daemon's
 * own stop does when its one `taskkill` run ends every session's tree at
 * once. `Atomics.wait` times out on the OS clock, so the programs leave at
 * the same instant rather than each on its own timer.
 */
function waitingProgram(marker: string): string[] {
  const quoted = JSON.stringify(marker);
  return [
    '-e',
    "const fs=require('fs');",
    `console.log('waiting');`,
    `const marker=${quoted};const end=Date.now()+${String(WAIT_FOR_MARKER_MS)};`,
    '(function check(){',
    '  let deadline=0;',
    "  try{deadline=Number(fs.readFileSync(marker,'utf8'));}catch{}",
    '  if(deadline>0){',
    '    const sleep=new SharedArrayBuffer(4);',
    '    Atomics.wait(new Int32Array(sleep),0,0,Math.max(0,deadline-Date.now()));',
    '    process.exit(0);',
    '  }',
    '  if(Date.now()>end){process.exit(9);}',
    '  setTimeout(check,1);',
    '})();',
  ];
}

/** The marker: one absolute moment, near enough for every program to see it. */
function writeMarker(marker: string): void {
  fs.writeFileSync(marker, String(Date.now() + MARKER_LEAD_MS));
}

function exitOf(session: Session): Promise<number | null> {
  return new Promise((resolve) => {
    if (session.exited) resolve(session.exitCode);
    else session.onExit(resolve);
  });
}

/**
 * One round's sessions, all of whose programs hold for the marker. Started
 * one at a time, each program up before the next: node-pty defers creating a
 * Windows terminal's program until its output worker has connected, gives
 * that five seconds, and a tight burst of starts on a busy machine can eat
 * them — so the burst is paced and the ends, which are what this file drives,
 * still all land on one moment.
 */
async function waitingSessions(manager: SessionManager, marker: string, count: number): Promise<Session[]> {
  const sessions: Session[] = [];
  let replacements = 0;
  while (sessions.length < count) {
    const session = manager.create({
      command: process.execPath,
      args: waitingProgram(marker),
      shell: false,
      cols: 40,
      rows: 8,
    });
    await eventually(() => session.pid > 0 || session.exited, 60_000);
    if (session.pid > 0) {
      sessions.push(session);
      continue;
    }
    // The start gave up on its output worker, as node-pty's deferred
    // connection can on a busy machine (its own five-second bound, reported
    // as exit -1 with nothing spawned). The round needs programs that run, so
    // the start is replaced — but only so far: a machine where most starts
    // fail is a finding, not a pattern to paper over.
    replacements += 1;
    if (replacements > count) {
      throw new Error(`more starts failed their connection than the round needs (${String(count)} wanted)`);
    }
    await manager.kill(session.id);
  }
  return sessions;
}

describe.skipIf(process.platform !== 'win32')('many sessions whose programs end together', () => {
  it(`records every exit and the process survives (${String(ROUNDS)} rounds of ${String(SESSIONS)})`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const manager = new SessionManager(compilePolicy(undefined));
      managers.push(manager);
      const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-concurrent-exit-'));
      markerDirs.push(markerDir);
      const marker = path.join(markerDir, 'go');
      const sessions = await waitingSessions(manager, marker, SESSIONS);

      writeMarker(marker);
      // A busy daemon does not sit still while its sessions end: viewers
      // reshape their panes, and every resize walks the handle list the exit
      // watchers are removing from. Churn them through the whole storm, as
      // the real thing does; a session that has ended refuses its resize.
      const churn = (async () => {
        while (!sessions.every((session) => session.exited)) {
          for (const session of sessions) {
            try {
              session.resize(60, 12);
            } catch {
              // The program has ended: nothing left to resize.
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })();
      const codes = await Promise.all(sessions.map(exitOf));
      await churn;
      expect(codes).toEqual(Array.from({ length: SESSIONS }, () => 0));
      expect(sessions.every((session) => session.exited)).toBe(true);

      await manager.killAll();
      managers.pop();
    }
    // The console-host ends the rounds queued settle here: the process that
    // survived the exits also sees its own clean-up through.
    await whenConsoleHostBatchSettled();
  }, HEAVY ? 600_000 : 240_000);

  it(`survives a stop that ends every tree at once, mid-exit (${String(SESSIONS)} sessions)`, async () => {
    const manager = new SessionManager(compilePolicy(undefined));
    managers.push(manager);
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-concurrent-exit-stop-'));
    markerDirs.push(markerDir);
    const sessions = await waitingSessions(manager, path.join(markerDir, 'go'), SESSIONS);

    // The daemon's own stop: one `taskkill` run ends every session's tree
    // while every exit watcher is about to fire, and each session's kill then
    // walks the handle list the watchers are removing from.
    await manager.killAll();
    managers.pop();
    const codes = await Promise.all(sessions.map(exitOf));
    expect(sessions.every((session) => session.exited)).toBe(true);
    expect(codes).toHaveLength(SESSIONS);
    await whenConsoleHostBatchSettled();
  }, HEAVY ? 600_000 : 240_000);
});
