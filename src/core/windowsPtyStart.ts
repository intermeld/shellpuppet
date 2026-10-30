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
 * The same wrapper decides what a ConPTY kill ends (`consoleProcessList`):
 * the processes on the terminal's console that node-pty's helper reports,
 * never the pid of a program that may have gone, and with the helper's errors
 * heard. Through `listenForTerminalErrors` it hears the other errors node-pty
 * 1.1.0 leaves unheard, those of a live terminal's streams.
 * `recordedExitCode` reads whether node-pty has seen a terminal's program
 * end, where `canReadExitCode` says it can.
 */

import { fork } from 'node:child_process';
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

/** The method of node-pty's agent that a ConPTY kill takes its list of pids from. */
interface AgentPrototype {
  _getConsoleProcessList?: (this: { _innerPid?: number }) => Promise<number[]>;
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
 * start, and whose kill takes its list of pids from `consoleProcessList`.
 * node-pty looks the constructor up on this module object each time it
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
  agents.WindowsPtyAgent = Wrapped;
  // node-pty's kill looks the method up on the prototype, which the wrapped
  // constructor shares, so every terminal from here on uses this one.
  if (typeof Original.prototype._getConsoleProcessList === 'function') {
    Original.prototype._getConsoleProcessList = function getConsoleProcessList(this: {
      _innerPid?: number;
    }): Promise<number[]> {
      return this._innerPid === undefined ? Promise.resolve([]) : consoleProcessList(this._innerPid);
    };
  }
}

/** How long node-pty gives its console-list helper to answer; the same here. */
const CONSOLE_LIST_TIMEOUT_MS = 5_000;

/** What `consoleProcessList` needs of the helper process it starts. */
export interface ConsoleListHelper {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error' | 'close', listener: () => void): unknown;
  kill(): unknown;
}

/**
 * node-pty's helper, which attaches to the terminal's console and sends back
 * the pids attached to it. Its output goes nowhere: core code must not write
 * to its host's stderr, and a helper that cannot attach exits with a stack
 * trace. Hidden, because a daemon started detached has no console for it to
 * share, and a console of its own would otherwise open a window.
 */
function startConsoleListHelper(innerPid: number): ConsoleListHelper {
  const require = createRequire(import.meta.url);
  return fork(require.resolve('node-pty/lib/conpty_console_list_agent.js'), [String(innerPid)], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
}

/**
 * The pids attached to a ConPTY terminal's console, which node-pty 1.1.0 kills
 * one by one when the terminal is killed (`lib/windowsPtyAgent.js`), or none.
 *
 * node-pty asks a helper process for them, and when the helper cannot answer
 * it waits five seconds and returns the pid of the program the terminal
 * started, which it then kills. The helper cannot answer once that program
 * has gone, because there is no console left to attach to, and a session's
 * kill always gets there first: it ends the whole process tree before it
 * calls node-pty's kill (`session.ts`). Left to itself, then, node-pty kills
 * a pid five seconds after it was freed, and Windows hands pids out again:
 * whatever process has been given it by then is terminated, with exit code 1.
 *
 * Here the helper's answer is the list, as in node-pty. Every way of having
 * no answer gives an empty list: a helper that cannot be started (out of
 * handles, say), whose fork throws, that fails, that exits without answering
 * or that has not answered in five seconds. node-pty's fallback would also
 * kill a program still running after the five seconds; a session's tree kill
 * has already been sent to it by then, and the session checks that its root
 * has gone as soon as node-pty's kill returns, so a survivor is reported
 * rather than killed later through a pid that may no longer be its own.
 *
 * The helper is forked here, so its errors are listened to on the child
 * itself: a start that fails would otherwise be an uncaught exception, on
 * which the daemon stops with every session. No other child is touched.
 *
 * Exported for its unit test, which supplies a stand-in helper.
 */
export function consoleProcessList(
  innerPid: number,
  start: (innerPid: number) => ConsoleListHelper = startConsoleListHelper,
  timeoutMs: number = CONSOLE_LIST_TIMEOUT_MS,
): Promise<number[]> {
  return new Promise((resolve) => {
    let helper: ConsoleListHelper;
    try {
      helper = start(innerPid);
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      helper.kill();
      resolve([]);
    }, timeoutMs);
    const settle = (pids: number[]): void => {
      clearTimeout(timer);
      resolve(pids);
    };
    helper.on('message', (message) => {
      const list = (message as { consoleProcessList?: unknown } | null)?.consoleProcessList;
      settle(Array.isArray(list) ? list.filter((pid): pid is number => Number.isInteger(pid)) : []);
    });
    // 'close' rather than 'exit': it waits for the IPC channel, so an answer
    // sent just before the helper exits is read before this settles.
    helper.on('error', () => settle([]));
    helper.on('close', () => settle([]));
  });
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

type ExitRecordingTerminal = { _agent?: { _useConpty?: boolean; exitCode?: number } };

/**
 * Whether node-pty records when this Windows terminal's program ends, so that
 * `recordedExitCode` can say: node-pty 1.1.0 under ConPTY, whose exit thread
 * records the program's code as it sees the program end. Not under winpty,
 * whose agent asks Windows about whichever process has the pid now (a live one
 * answers 259, still active), and not with another node-pty version.
 */
export function canReadExitCode(pty: unknown): boolean {
  return wrapped && (pty as ExitRecordingTerminal)._agent?._useConpty === true;
}

/**
 * The exit code node-pty has recorded for a Windows terminal's program, or
 * undefined while it has recorded none: while the program runs, and wherever
 * `canReadExitCode` is false. node-pty holds the program's handle while the
 * program runs and closes it as it sees the program end, a moment before the
 * code is recorded here (`src/win/conpty.cc`). A kill in that moment can reach
 * a pid just freed: the same kind of race every kill has while `taskkill`
 * enumerates the processes.
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
