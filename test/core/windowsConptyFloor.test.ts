/**
 * The Windows ConPTY floor. node-pty 1.2.0 removed its winpty fallback, so a
 * build below the ConPTY floor cannot start a terminal at all; such a start
 * is refused before anything is spawned, with the floor named, instead of
 * failing deep inside ConPTY as a bare "Cannot launch conpty". The build
 * number is injected, so these run on any machine.
 */

import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';
import {
  CONPTY_MINIMUM_BUILD,
  WindowsWithoutConPTYError,
  windowsBuildNumber,
} from '../../src/core/session.js';
import type { Logger } from '../../src/core/types.js';

class StubPty implements IPty {
  readonly pid = 4321;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'true';
  handleFlowControl = false;
  onData(): { dispose(): void } {
    return { dispose(): void {} };
  }
  onExit(): { dispose(): void } {
    return { dispose(): void {} };
  }
  resize(): void {}
  clear(): void {}
  write(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function sessionWith(osRelease: string): Session {
  return new Session('floor', { command: 'cmd.exe', shell: true }, {
    platform: 'win32',
    osRelease,
    logger: quiet,
    spawn: () => new StubPty(),
    queueConsoleHostEnd: () => undefined,
    registerConsoleHostWindow: () => undefined,
  });
}

describe('windowsBuildNumber', () => {
  it('reads the build from an os.release() string, or says 0', () => {
    expect(windowsBuildNumber('10.0.17763')).toBe(17763);
    expect(windowsBuildNumber('10.0.19045')).toBe(19045);
    expect(windowsBuildNumber('not a release')).toBe(0);
  });
});

describe('a start on a Windows build below the ConPTY floor', () => {
  it(`is refused with the floor named (build < ${String(CONPTY_MINIMUM_BUILD)})`, () => {
    // Windows 10 version 1809, build 17763: the release the floor's build
    // number belongs to the middle of.
    expect(() => sessionWith('10.0.17763')).toThrow(WindowsWithoutConPTYError);
    expect(() => sessionWith('10.0.17763')).toThrow(/ConPTY/);
    expect(() => sessionWith('10.0.17763')).toThrow(/1809/);
    expect(() => sessionWith('10.0.17763')).toThrow(new RegExp(String(CONPTY_MINIMUM_BUILD)));
  });

  it('starts as usual on a build at or above the floor', () => {
    expect(() => sessionWith('10.0.19045')).not.toThrow();
    expect(() => sessionWith(`10.0.${String(CONPTY_MINIMUM_BUILD)}`)).not.toThrow();
  });
});
