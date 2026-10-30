/**
 * A Windows start that fails part-way releases what node-pty had built.
 *
 * node-pty 1.1.0 builds a Windows terminal in steps (`lib/windowsPtyAgent.js`):
 * it creates the pseudoconsole, which is a `conhost.exe` and two pipes; it
 * starts a worker thread that connects to the output pipe; it opens the input
 * pipe; and only then does it create the process. When either of the last two
 * steps throws, the constructor gives up without undoing the others. Opening
 * the input pipe fails on every start under a sandbox that denies pipe access;
 * creating the process fails for a file Windows cannot run, such as a script
 * started with `shell: false`. The console host keeps running, and when the
 * worker's own connect fails too, nothing listens for the worker's error, so
 * it would reach the daemon as an uncaught exception.
 *
 * `releaseFailedStarts` wraps node-pty's Windows agent so that a failed start
 * listens for the worker's error, ends the worker, destroys both sockets and,
 * under ConPTY, closes the pseudoconsole, before the error reaches the caller.
 * Windows builds before 18309 get winpty instead, which has no pseudoconsole
 * and whose native kill takes other arguments, so there only that step is
 * skipped. The wrapper reads node-pty's private fields, so it wraps version
 * 1.1.0 only and leaves any other alone. The two pipe handles node-pty keeps
 * for the pseudoconsole stay open: its native kill does not close them.
 *
 * The same wrapper gives a listener to the other errors node-pty 1.1.0 leaves
 * unheard: those of the helper its ConPTY kill forks
 * (`hearConsoleListFailures`), and, through `listenForTerminalErrors`, those
 * of a live terminal's streams.
 */

import type { ChildProcess } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { createRequire } from 'node:module';

/** The node-pty version whose private fields this relies on. */
const WRAPPED_VERSION = '1.1.0';

/** The fields of node-pty's `WindowsPtyAgent` that a failed start leaves set. */
export interface HalfBuiltAgent {
  _useConpty?: boolean;
  _pty?: number;
  _useConptyDll?: boolean;
  _ptyNative?: { kill(pty: number, useConptyDll: boolean): void };
  _inSocket?: { destroy(): void };
  _outSocket?: { on(event: 'error', listener: () => void): unknown; destroy(): void };
  _conoutSocketWorker?: {
    _worker?: { on(event: 'error', listener: () => void): unknown; terminate(): unknown };
  };
}

/** The method of node-pty's agent that a ConPTY kill forks a helper in. */
interface AgentPrototype {
  _getConsoleProcessList?: (this: { _innerPid: number }) => Promise<number[]>;
}

type AgentConstructor = ((this: HalfBuiltAgent, ...args: unknown[]) => void) & {
  prototype: AgentPrototype;
  releasesFailedStarts?: true;
};

/** The shape of node-pty's `lib/windowsPtyAgent.js` exports that matter here. */
export interface AgentModule {
  WindowsPtyAgent: AgentConstructor;
}

/**
 * Replace the module's `WindowsPtyAgent` with one that releases a failed
 * start. node-pty looks the constructor up on this module object each time it
 * builds a terminal, so the replacement takes effect for every later start.
 */
export function wrapWindowsPtyAgent(agents: AgentModule): void {
  const Original = agents.WindowsPtyAgent;
  if (Original.releasesFailedStarts === true) return;

  const Wrapped = function WindowsPtyAgent(this: unknown, ...args: unknown[]): HalfBuiltAgent {
    const agent = Object.create(Original.prototype) as HalfBuiltAgent;
    try {
      Original.apply(agent, args);
    } catch (error) {
      release(agent);
      throw error;
    }
    return agent;
  } as unknown as AgentConstructor;
  Wrapped.prototype = Original.prototype;
  Wrapped.releasesFailedStarts = true;
  hearConsoleListFailures(Original.prototype);
  agents.WindowsPtyAgent = Wrapped;
}

/**
 * Under ConPTY, node-pty's kill forks a helper that lists the console's
 * processes (`_getConsoleProcessList`) and listens only for its answer. A
 * fork that cannot start, out of handles say, emits 'error' on the child,
 * or throws, which rejects a promise nothing handles, and either would stop
 * the daemon. The fork happens inside the call, so the child is given a
 * listener as Node publishes it on the `child_process` diagnostics channel,
 * and a fork that throws leaves the list to the shell's pid, as node-pty's
 * own timeout does. Either way the kill goes on to close the pseudoconsole,
 * which tells the processes still attached to it to close.
 */
function hearConsoleListFailures(prototype: AgentPrototype): void {
  const list = prototype._getConsoleProcessList;
  if (list === undefined) return;
  prototype._getConsoleProcessList = function getConsoleProcessList(this: { _innerPid: number }) {
    const listen = (message: unknown): void => {
      (message as { process: ChildProcess }).process.on('error', () => undefined);
    };
    subscribe('child_process', listen);
    try {
      return list.call(this).catch(() => [this._innerPid]);
    } finally {
      unsubscribe('child_process', listen);
    }
  };
}

/** Undo what a failed start built, as far as node-pty lets us. */
function release(agent: HalfBuiltAgent): void {
  const worker = agent._conoutSocketWorker?._worker;
  if (worker !== undefined) {
    // The worker's connect may still fail after this, and an 'error' with no
    // listener would reach the daemon as an uncaught exception.
    worker.on('error', () => undefined);
    void worker.terminate();
  }
  // The input socket exists only when the process could not be created.
  agent._inSocket?.destroy();
  // A 'ready' from the worker arriving after this would reconnect the output
  // socket (connecting revives a destroyed socket), and its error would have
  // no listener either.
  agent._outSocket?.on('error', () => undefined);
  agent._outSocket?.destroy();
  // Only ConPTY has a pseudoconsole to close; winpty's kill takes a pid.
  if (agent._useConpty === true && agent._pty !== undefined && agent._ptyNative !== undefined) {
    try {
      agent._ptyNative.kill(agent._pty, agent._useConptyDll ?? false);
    } catch {
      // Best effort: the start has already failed and its caller is told.
    }
  }
}

let wrapped = false;

/**
 * Wrap the installed node-pty's Windows agent, once. True when it is wrapped;
 * false when the installed version is not the one this was written against.
 */
export function releaseFailedStarts(): boolean {
  if (wrapped) return true;
  const require = createRequire(import.meta.url);
  const { version } = require('node-pty/package.json') as { version: string };
  wrapped = wrapIfKnownVersion(version, () => require('node-pty/lib/windowsPtyAgent.js') as AgentModule);
  return wrapped;
}

type ErrorSource = { on(event: 'error', listener: (error: Error) => void): unknown };

/**
 * Take the errors of the streams of a live Windows terminal that node-pty
 * 1.1.0 leaves unheard, each of which would otherwise be an uncaught
 * exception, on which the daemon shuts down with every session.
 *
 * - `input`: input reaches the pseudoconsole through a socket on its input
 *   pipe (`lib/windowsPtyAgent.js`). Once the console host has closed its end,
 *   a write the pipe refuses (`write EAGAIN`) is emitted as an 'error'; a
 *   viewer's focus report racing the session's exit does it.
 * - `output`: a worker thread copies the output pipe to a local socket
 *   (`lib/worker/conoutSocketWorker.js`), and an error thrown there becomes
 *   the worker's 'error'. The terminal reads that socket, and listens on it
 *   only once it has connected; its handler then throws any error but EIO
 *   while it is the socket's only 'error' listener (`lib/windowsTerminal.js`).
 *   The terminal's own `on('error')`, which its typings leave out, adds the
 *   second.
 *
 * With the listener the stream fails as before and the daemon and its other
 * sessions carry on. False when the installed node-pty is not the wrapped
 * version or the terminal has none of these.
 */
export function listenForTerminalErrors(
  pty: unknown,
  listener: (error: Error, stream: 'input' | 'output') => void,
): boolean {
  if (!wrapped) return false;
  const terminal = pty as {
    on?: ErrorSource['on'];
    _agent?: { inSocket?: ErrorSource; _conoutSocketWorker?: { _worker?: ErrorSource } };
  };
  const input = terminal._agent?.inSocket;
  const worker = terminal._agent?._conoutSocketWorker?._worker;
  input?.on('error', (error) => listener(error, 'input'));
  worker?.on('error', (error) => listener(error, 'output'));
  terminal.on?.('error', (error) => listener(error, 'output'));
  return input !== undefined || worker !== undefined || terminal.on !== undefined;
}

/**
 * Wrap the agent module only for the node-pty version whose private fields
 * `release` reads. Another version is left alone and its module not loaded:
 * wrapping internals nobody has read could break every start, where leaving
 * them alone costs only the release.
 */
export function wrapIfKnownVersion(version: string, load: () => AgentModule): boolean {
  if (version !== WRAPPED_VERSION) return false;
  wrapWindowsPtyAgent(load());
  return true;
}
