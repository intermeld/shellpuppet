import type { IPty } from 'node-pty';
import { Session } from '../../src/core/session.js';

/** Real Session and xterm, with deterministic delivery at the PTY boundary. */
export function sessionFixture(id: string): { session: Session; data: (text: string) => void; exit: () => void } {
  let data: (text: string) => void = () => {};
  let exit = (): void => {};
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
    onData(listener: (text: string) => void) { data = listener; return { dispose() {} }; },
    onExit(listener: (event: { exitCode: number }) => void) {
      exit = () => { listener({ exitCode: 0 }); };
      return { dispose() {} };
    },
    write() {}, resize() {}, kill() {}, clear() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session(id, { command: process.execPath, shell: false }, {
    spawn: () => pty, queueConsoleHostEnd() {}, registerConsoleHostWindow() {},
  });
  return { session, data: text => { data(text); }, exit: () => { exit(); } };
}
