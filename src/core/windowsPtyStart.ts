/**
 * A Windows start that fails part-way releases what node-pty had built.
 *
 * node-pty 1.2.0-beta.18 builds a Windows terminal in steps
 * (`lib/windowsPtyAgent.js`): it creates the pseudoconsole, which is a
 * `conhost.exe` and two pipes; it starts a worker thread that connects to the
 * output pipe; it arms a five-second timer and records a pending connection;
 * and only then does it open the input pipe. Creating the *program* is
 * deferred: `conptyNative.connect()` runs from the worker's 'ready' callback,
 * so `ConnectNamedPipe` never blocks the event loop (upstream #763), and a
 * connect that fails, late, no longer throws out of the constructor: the
 * agent records an exit code, releases everything it built and reports the
 * failure through `onError`, which the terminal turns into an 'exit' with
 * that code (upstream #934, #935). A worker that errors or exits before it
 * connects is heard the same way.
 *
 * What can still throw inside the constructor is the input pipe's open, which
 * fails on every start under a sandbox that denies pipe access — after the
 * worker has started and the deferred connection has been armed. Left alone,
 * a worker that becomes ready afterwards would run the deferred `connect` and
 * spawn the program of a start whose caller was told it failed, and the
 * connection's own failure paths would then reach sockets that were never
 * built. So `releaseFailedStarts` wraps node-pty's Windows agent so that a
 * failed start cancels the deferred connection, gives the worker's error a
 * listener, ends the worker, destroys both sockets and closes the
 * pseudoconsole, before the error reaches the caller. The wrapper reads
 * node-pty's private fields, so it wraps version 1.2.0-beta.18 only and
 * leaves any other alone.
 *
 * The same wrapper makes a kill end no process of its own
 * (`listNothingToKill`): node-pty would look them up by a pid the program may
 * no longer hold. It drops a resize that arrives once node-pty has seen the
 * program end, where node-pty would throw `Cannot resize a pty that has
 * already exited`. node-pty holds a resize asked for before the terminal's
 * first output and runs it from the output socket's first 'data' event, so
 * when the program has ended by then, as it can on a busy daemon, that throw
 * reaches no caller and would be an uncaught exception. Once the program has
 * ended a resize changes nothing the session shows, so dropping the call
 * loses nothing; a resize asked for after the end is refused by `Session.resize`
 * instead, to its caller. Through `listenForTerminalErrors` it hears the
 * errors node-pty leaves unheard on a live terminal's streams: the input
 * socket, which nothing listens to at all, and the output socket, whose own
 * handler rethrows any error but EIO while it is the socket's only 'error'
 * listener. The worker's own errors node-pty now takes itself before it
 * connects; after that they are swallowed, and the listener here keeps them
 * recorded. `recordedExitCode` reads whether node-pty has seen a terminal's
 * program end, where `canReadExitCode` says it can.
 */

import { createRequire } from 'node:module';

/** The node-pty version whose private fields this relies on. */
const WRAPPED_VERSION = '1.2.0-beta.18';

/** The fields of node-pty's `WindowsPtyAgent` that a failed start leaves set. */
export interface HalfBuiltAgent {
  _pty?: number;
  _useConptyDll?: boolean;
  _ptyNative?: { kill(pty: number, useConptyDll: boolean): void };
  _inSocket?: { destroy(): void };
  _outSocket?: { on(event: 'error', listener: () => void): unknown; destroy(): void };
  _conoutSocketWorker?: {
    _worker?: { on(event: 'error', listener: () => void): unknown; terminate(): unknown };
  };
  /** node-pty's deferred `connect`; undefined once it has run, failed or been cancelled. */
  _pendingPtyInfo?: unknown;
  /** The timer that fails the connection when the output worker never connects. */
  _connectionTimeout?: ReturnType<typeof setTimeout> | undefined;
}

/** The fields of node-pty's agent that its resize reads. */
interface ResizingAgent {
  /** Set by node-pty's exit thread as it sees the terminal's program end. */
  _exitCode?: number;
}

/** The methods of node-pty's agent that the wrapper replaces. */
interface AgentPrototype {
  /** Where a kill takes its list of pids from. */
  _getConsoleProcessList?: () => Promise<number[]>;
  resize?: (this: ResizingAgent, cols: number, rows: number) => void;
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
 * start, whose kill ends no process of its own (`listNothingToKill`) and whose
 * resize is dropped once node-pty has seen the program end. node-pty looks the
 * constructor up on this module object each time it builds a terminal, so the
 * replacement takes effect for every later start.
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
  agents.WindowsPtyAgent = Wrapped;
  // node-pty's kill and resize look their methods up on the prototype, which
  // the wrapped constructor shares, so every terminal from here on uses these.
  if (typeof Original.prototype._getConsoleProcessList === 'function') {
    Original.prototype._getConsoleProcessList = listNothingToKill;
  }
  const resize = Original.prototype.resize;
  if (typeof resize === 'function') {
    Original.prototype.resize = function resizeWhileRunning(this: ResizingAgent, cols: number, rows: number): void {
      if (this._exitCode !== undefined) return;
      resize.call(this, cols, rows);
    };
  }
}

/**
 * The pids node-pty 1.2.0-beta.18's kill ends one by one
 * (`lib/windowsPtyAgent.js`): none, found without starting anything.
 *
 * node-pty forks a helper that attaches to the console of whichever process
 * now holds the program's pid and lists the processes on it, and with no
 * answer waits five seconds and returns that pid itself; it then kills every
 * pid in the list. It lists nothing while the deferred connection has not
 * run, but once the program has started and ended, Windows is free to give
 * its pid to another process, so either way the kill can end processes that
 * are not the session's, as many as a whole console of them.
 *
 * A session's processes are ended by its tree kill instead (`session.ts`):
 * every kill of a session whose program has not been seen to end runs
 * `taskkill /T /F` from the program's pid, before node-pty's kill, and a
 * program that has ended has nothing left for the helper to find. This
 * replaces `_getConsoleProcessList` only, which the kill calls. node-pty's
 * kill still closes the pseudoconsole while it holds the terminal, which it
 * does until the program ends, so a program a tree kill left running is sent
 * CTRL_CLOSE_EVENT with the rest of its console.
 */
function listNothingToKill(): Promise<number[]> {
  return Promise.resolve([]);
}

/** Undo what a failed start built, as far as node-pty lets us. */
function release(agent: HalfBuiltAgent): void {
  // Cancel the deferred connection first, so a worker that becomes ready after
  // this cannot run it and spawn the program of a start that already failed,
  // and the five-second timer cannot fire into a half-built terminal either.
  agent._pendingPtyInfo = undefined;
  if (agent._connectionTimeout !== undefined) clearTimeout(agent._connectionTimeout);
  const worker = agent._conoutSocketWorker?._worker;
  if (worker !== undefined) {
    // The worker's connect may still fail after this, and an 'error' with no
    // listener would reach the daemon as an uncaught exception.
    worker.on('error', () => undefined);
    void worker.terminate();
  }
  // The input socket exists only when the input pipe could be opened.
  agent._inSocket?.destroy();
  // A 'ready' from the worker arriving after this would reconnect the output
  // socket (connecting revives a destroyed socket), and its error would have
  // no listener either.
  agent._outSocket?.on('error', () => undefined);
  agent._outSocket?.destroy();
  if (agent._pty !== undefined && agent._ptyNative !== undefined) {
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
 * 1.2.0-beta.18 leaves unheard, each of which would otherwise be an uncaught
 * exception, on which the daemon shuts down with every session.
 *
 * - `input`: input reaches the pseudoconsole through a socket on its input
 *   pipe (`lib/windowsPtyAgent.js`), and nothing listens for its errors.
 *   Once the console host has closed its end, a write the pipe refuses
 *   (`write EAGAIN`) is emitted as an 'error'; a viewer's focus report racing
 *   the session's exit does it.
 * - `output`: a worker thread copies the output pipe to a local socket
 *   (`lib/worker/conoutSocketWorker.js`), and an error thrown there becomes
 *   the worker's 'error'. node-pty's own listener takes it only while the
 *   worker has not yet connected; after that it is swallowed, so the listener
 *   here is what records it. The terminal reads that socket, and listens on
 *   it only once it has connected; its handler then throws any error but EIO
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

type ExitRecordingTerminal = { _agent?: { exitCode?: number } };

/**
 * Whether node-pty records when this Windows terminal's program ends, so that
 * `recordedExitCode` can say: node-pty 1.2.0-beta.18, which is ConPTY only
 * and whose exit thread records the program's code as it sees the program
 * end. Not with another node-pty version.
 */
export function canReadExitCode(pty: unknown): boolean {
  return wrapped && (pty as ExitRecordingTerminal)._agent !== undefined;
}

/**
 * The exit code node-pty has recorded for a Windows terminal's program, or
 * undefined while it has recorded none: while the program runs, and wherever
 * `canReadExitCode` is false. node-pty holds the program's handle while the
 * program runs and closes it as it sees the program end, a moment before the
 * code is recorded here (`src/win/conpty.cc`). A kill in that moment can reach
 * a pid just freed: the same kind of race every kill has while `taskkill`
 * enumerates the processes. A connection that failed records a code too, with
 * nothing ever spawned: no pid is walked for it.
 */
export function recordedExitCode(pty: unknown): number | undefined {
  return canReadExitCode(pty) ? (pty as ExitRecordingTerminal)._agent?.exitCode : undefined;
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
