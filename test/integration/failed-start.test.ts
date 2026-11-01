/**
 * A Windows start that fails after node-pty has created the pseudoconsole
 * must not leave its console host running. Two failures are driven: a
 * sandbox that denies pipe access, simulated where it strikes (the open of
 * the terminal's input pipe is refused, inside the constructor), and a real
 * one, a file named as a program that Windows cannot run started with
 * `shell: false`. node-pty 1.2.0-beta.18 creates the program only after the
 * spawn has returned and reports the failure as an exit whose code Windows
 * gave (upstream #934) rather than a throw, so this file drives the session
 * manager directly; over HTTP the start contract refuses such a start again,
 * as 1.1.0 did (`start-contract.test.ts`), and what must hold either way is
 * that no console host is left behind.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';

// The module object node-pty itself calls `openSync` on.
const fs = createRequire(import.meta.url)('fs') as { openSync: (...args: unknown[]) => number };

/**
 * A file the start's own checks pass, an `.exe` like any program, that
 * Windows cannot run: it holds text, not an executable image.
 */
function notAProgram(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-not-a-program-'));
  const file = path.join(dir, 'sink.exe');
  writeFileSync(file, 'console.log("not an executable image");\n');
  return { dir, file };
}

/** Console hosts this process owns: one per pseudoconsole it created. */
function consoleHosts(): number[] {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(process.pid)} AND Name='conhost.exe'" | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/** Run a start that fails, then check it left no console host running. */
async function expectNoConsoleHostLeft(
  manager: SessionManager,
  failingStart: () => void | Promise<void>,
): Promise<void> {
  const before = new Set(consoleHosts());
  const newHosts = (): number[] => consoleHosts().filter((pid) => !before.has(pid));
  let left: number[] | undefined;
  try {
    await failingStart();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    left = newHosts();
    expect(left).toEqual([]);
  } finally {
    // Whatever failed above, even a start that succeeded, take down what it
    // left: the sessions it made, then any console host it created.
    await manager.killAll();
    for (const pid of left ?? newHosts()) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
  }
}

// Each test makes two process queries, which take seconds each and tens of
// seconds on a busy Windows machine: under the full suite, one test can
// overrun the default minute.
describe('a Windows start that fails part-way', () => {
  it.skipIf(process.platform !== 'win32')('leaves no console host running when the input pipe is refused', async () => {
    const manager = new SessionManager(compilePolicy(undefined));
    await expectNoConsoleHostLeft(manager, () => {
      const openSync = fs.openSync;
      fs.openSync = (...args: unknown[]): number => {
        if (/\\pipe\\conpty-[^\\]+-in$/.test(String(args[0]))) {
          throw Object.assign(new Error(`EPERM: operation not permitted, open '${String(args[0])}'`), {
            code: 'EPERM',
            syscall: 'open',
          });
        }
        return openSync(...args);
      };
      try {
        expect(() => manager.create({ command: process.execPath })).toThrow('EPERM');
      } finally {
        fs.openSync = openSync;
      }
    });
  }, 180_000);

  it.skipIf(process.platform !== 'win32')(
    'leaves no console host running when the process cannot be created',
    async () => {
      const manager = new SessionManager(compilePolicy(undefined));
      const { dir, file } = notAProgram();
      try {
        await expectNoConsoleHostLeft(manager, async () => {
          const session = manager.create({ command: file, shell: false });
          // Windows cannot run the file (193, not a valid Win32 application,
          // or 216, a machine-type mismatch), and the failed start reports
          // that code as its exit.
          const exited = new Promise<number | null>((resolve) => session.onExit(resolve));
          const code = await exited;
          expect([193, 216]).toContain(code);
          expect(session.exitCode).toBe(code);
          expect(session.programEnded).toBe(true);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
      expect(existsSync(dir)).toBe(false);
    },
    180_000,
  );
});
