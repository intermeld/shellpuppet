/**
 * Without the shell (`shell: false`), a Windows session starts its command as
 * a program. Windows hands a batch file to cmd.exe on its own, with arguments
 * quoted for a program's parser, and anything else that is not an .exe or a
 * .com fails with error 193 once the terminal is built. Both are refused up
 * front, as a caller error that says what to do instead.
 *
 * The refusal comes from resolving the command, before node-pty is loaded, so
 * the platform override lets every CI leg check the Windows rule.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CommandNotFoundError, Session } from '../../src/core/session.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-command-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const savedPath = process.env['PATH'];
afterEach(() => {
  process.env['PATH'] = savedPath;
});

function script(name: string): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, '@exit /b 0\r\n');
  return file;
}

/** What starting `command` without the shell, as Windows would, throws. */
function startOnWindows(command: string): unknown {
  try {
    new Session('s1', { command, shell: false }, { platform: 'win32' });
  } catch (error) {
    return error;
  }
  return null;
}

describe('a command started without the shell on Windows', () => {
  it.each(['run.cmd', 'run.bat', 'RUN.CMD', 'run.ps1', 'run-script'])(
    'refuses %s with a 400-class error that says to use the shell or name the interpreter',
    (name) => {
      const error = startOnWindows(script(name));
      expect(error).toBeInstanceOf(CommandNotFoundError);
      const message = (error as Error).message;
      expect(message).toContain('Not a program Windows can start directly');
      expect(message).toContain(name);
      expect(message).toContain('Drop shell:false');
      expect(message).toContain('interpreter');
    },
  );

  it('names both the command and the file it resolved to, for a bare name found on PATH', () => {
    const file = script('sp-probe-tool.CMD');
    process.env['PATH'] = tempDir;
    const error = startOnWindows('sp-probe-tool');
    expect(error).toBeInstanceOf(CommandNotFoundError);
    expect((error as Error).message).toContain(`sp-probe-tool (${file})`);
  });
});
