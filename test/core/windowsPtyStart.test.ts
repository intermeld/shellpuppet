/**
 * A Windows start that fails part-way releases what node-pty had built: the
 * output worker, both sockets and, under ConPTY, the pseudoconsole. These
 * drive the wrapper with a stand-in for node-pty's agent module;
 * `test/integration/failed-start.test.ts` drives the real one. The rest cover
 * what the same wrapper decides and listens to: the list of pids a kill ends,
 * driven here through node-pty's agent and with a stand-in helper process
 * (and in `test/integration/kill-reused-pid.test.ts` with a real terminal), a
 * live terminal's streams and the exit code node-pty records.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { channel, subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  consoleProcessList,
  releaseFailedStarts,
  wrapIfKnownVersion,
  wrapWindowsPtyAgent,
} from '../../src/core/windowsPtyStart.js';
import type { AgentModule, ConsoleListHelper, HalfBuiltAgent } from '../../src/core/windowsPtyStart.js';

type StandInAgent = HalfBuiltAgent & { started?: true; describe(): string };

/** Where the stand-in's start fails, as node-pty's can: or not at all. */
type FailAt = 'input pipe' | 'process' | 'nowhere';

/**
 * A stand-in agent module whose constructor sets node-pty's fields in
 * node-pty's order, failing where told.
 */
function standInModule(failAt: FailAt, useConpty = true): { module: AgentModule; events: string[] } {
  const events: string[] = [];
  function WindowsPtyAgent(this: StandInAgent): void {
    this._useConpty = useConpty;
    this._useConptyDll = false;
    this._ptyNative = { kill: (pty, dll) => events.push(`native kill ${String(pty)} ${String(dll)}`) };
    this._pty = 7;
    this._outSocket = {
      on: (event) => events.push(`output socket listens for ${event}`),
      destroy: () => events.push('output socket destroyed'),
    };
    this._conoutSocketWorker = {
      _worker: {
        on: (event) => events.push(`worker listens for ${event}`),
        terminate: () => events.push('worker terminated'),
      },
    };
    if (failAt === 'input pipe') throw new Error("EPERM: operation not permitted, open '\\\\.\\pipe\\conpty-1-in'");
    this._inSocket = { destroy: () => events.push('input socket destroyed') };
    if (failAt === 'process') throw new Error('Cannot create process, error code: 193');
    this.started = true;
  }
  (WindowsPtyAgent.prototype as { describe(): string }).describe = function describe(): string {
    return 'agent';
  };
  return { module: { WindowsPtyAgent } as unknown as AgentModule, events };
}

function construct(module: AgentModule): StandInAgent {
  const Agent = module.WindowsPtyAgent as unknown as new () => StandInAgent;
  return new Agent();
}

describe('wrapWindowsPtyAgent', () => {
  it('releases the worker, its socket and the pseudoconsole when the input pipe cannot be opened', () => {
    const { module, events } = standInModule('input pipe');
    wrapWindowsPtyAgent(module);

    expect(() => construct(module)).toThrow('EPERM');
    expect(events).toEqual([
      'worker listens for error',
      'worker terminated',
      'output socket listens for error',
      'output socket destroyed',
      'native kill 7 false',
    ]);
  });

  it('releases the input socket as well when the process cannot be created', () => {
    const { module, events } = standInModule('process');
    wrapWindowsPtyAgent(module);

    expect(() => construct(module)).toThrow('Cannot create process');
    expect(events).toEqual([
      'worker listens for error',
      'worker terminated',
      'input socket destroyed',
      'output socket listens for error',
      'output socket destroyed',
      'native kill 7 false',
    ]);
  });

  it('leaves the native kill alone under winpty, whose kill takes a pid', () => {
    const { module, events } = standInModule('input pipe', false);
    wrapWindowsPtyAgent(module);

    expect(() => construct(module)).toThrow('EPERM');
    expect(events).toEqual([
      'worker listens for error',
      'worker terminated',
      'output socket listens for error',
      'output socket destroyed',
    ]);
  });

  it('leaves a start that succeeds as node-pty built it', () => {
    const { module, events } = standInModule('nowhere');
    const prototype = module.WindowsPtyAgent.prototype;
    wrapWindowsPtyAgent(module);

    const agent = construct(module);
    expect(agent.started).toBe(true);
    expect(agent.describe()).toBe('agent');
    // The module still reports node-pty's own prototype, as it did before.
    expect(module.WindowsPtyAgent.prototype).toBe(prototype);
    expect(agent).toBeInstanceOf(module.WindowsPtyAgent);
    expect(events).toEqual([]);
  });

  it('replaces the list of pids a kill ends, which lists nothing for a terminal with no program', async () => {
    const { module } = standInModule('nowhere');
    const prototype = module.WindowsPtyAgent.prototype;
    // node-pty's own falls back to the program's pid when nothing answers.
    const nodePtys = (): Promise<number[]> => Promise.resolve([42]);
    prototype._getConsoleProcessList = nodePtys;
    wrapWindowsPtyAgent(module);

    expect(prototype._getConsoleProcessList).not.toBe(nodePtys);
    expect(await prototype._getConsoleProcessList.call({})).toEqual([]);
  });

  it('wraps a module once', () => {
    const { module } = standInModule('nowhere');
    wrapWindowsPtyAgent(module);
    const first = module.WindowsPtyAgent;
    wrapWindowsPtyAgent(module);
    expect(module.WindowsPtyAgent).toBe(first);
  });
});

describe('wrapIfKnownVersion', () => {
  it('leaves another node-pty version alone, without loading its module', () => {
    const { module } = standInModule('input pipe');
    const original = module.WindowsPtyAgent;
    let loaded = false;

    const result = wrapIfKnownVersion('1.2.0', () => {
      loaded = true;
      return module;
    });

    expect(result).toBe(false);
    expect(loaded).toBe(false);
    expect(module.WindowsPtyAgent).toBe(original);
  });
});

describe('releaseFailedStarts', () => {
  it('wraps the installed node-pty, the version it was written against', () => {
    // Fails when node-pty changes version: read the new windowsPtyAgent.js and
    // check the fields the wrapper releases before moving the pin.
    expect(releaseFailedStarts()).toBe(true);
  });
});

/**
 * The `_getConsoleProcessList` of the installed node-pty's agent, which a
 * ConPTY kill calls, as the wrapper leaves it, run with only the field it
 * reads. `execPath` is where Node looks for the program it forks, swapped for
 * the length of the call only.
 */
function listConsoleProcesses(execPath: string): Promise<number[]> {
  const require = createRequire(import.meta.url);
  const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent.js') as {
    WindowsPtyAgent: { prototype: { _getConsoleProcessList(this: { _innerPid: number }): Promise<number[]> } };
  };
  const realExecPath = process.execPath;
  process.execPath = execPath;
  try {
    return WindowsPtyAgent.prototype._getConsoleProcessList.call({ _innerPid: 4321 });
  } finally {
    process.execPath = realExecPath;
  }
}

describe("the helper node-pty's kill forks", () => {
  it('is listened to for errors, so a fork that cannot start is heard', async () => {
    expect(releaseFailedStarts()).toBe(true);
    const children: ChildProcess[] = [];
    const capture = (message: unknown): void => {
      children.push((message as { process: ChildProcess }).process);
    };
    subscribe('child_process', capture);
    let listed: Promise<number[]>;
    try {
      listed = listConsoleProcesses(path.join(os.tmpdir(), 'shellpuppet-no-such-node.exe'));
    } finally {
      unsubscribe('child_process', capture);
    }
    expect(children).toHaveLength(1);
    const child = children[0] as ChildProcess;

    // Read before the error arrives on the next tick; the test's own listener
    // then keeps a run without the wrapper to this assertion.
    const heard = child.listenerCount('error');
    const failed = once(child, 'error');
    expect(heard).toBeGreaterThan(0);
    expect((await failed)[0]).toMatchObject({ code: 'ENOENT' });
    // A helper that never started has nothing to report, so the kill ends
    // nothing more: never the shell's pid, which may be another process's.
    await expect(listed).resolves.toEqual([]);
  }, 15_000);

  it('settles the list with nothing when the fork throws, never on the shell pid', async () => {
    expect(releaseFailedStarts()).toBe(true);
    // A program path holding a NUL byte is refused before anything starts.
    await expect(listConsoleProcesses('no\0such-node')).resolves.toEqual([]);
  });

  it('listens on the helper only, not on a child another subscriber starts during the call', async () => {
    expect(releaseFailedStarts()).toBe(true);
    // Node publishes every child as it is constructed, so another subscriber
    // can start a child of its own while node-pty's helper is published.
    let started = false;
    let helper: ChildProcess | undefined;
    let unrelated: ChildProcess | undefined;
    const startAnother = (message: unknown): void => {
      if (started) return;
      started = true;
      helper = (message as { process: ChildProcess }).process;
      unrelated = spawn(path.join(os.tmpdir(), 'shellpuppet-no-such-program.exe'));
    };
    subscribe('child_process', startAnother);
    try {
      void listConsoleProcesses(path.join(os.tmpdir(), 'shellpuppet-no-such-node.exe'));
    } finally {
      unsubscribe('child_process', startAnother);
    }
    if (helper === undefined || unrelated === undefined) throw new Error('no child published');

    // Read before either error arrives on the next tick; the test's own
    // listeners then keep a run without the fix to these assertions.
    const heard = { helper: helper.listenerCount('error'), unrelated: unrelated.listenerCount('error') };
    const failures = Promise.all([once(helper, 'error'), once(unrelated, 'error')]);
    expect(heard).toEqual({ helper: 1, unrelated: 0 });
    await failures;
  });

  it('leaves no subscriber on the child_process channel once the call returns', async () => {
    expect(releaseFailedStarts()).toBe(true);
    const processes = channel('child_process');
    expect(processes.hasSubscribers).toBe(false);
    await expect(listConsoleProcesses('no\0such-node')).resolves.toEqual([]);
    expect(processes.hasSubscribers).toBe(false);
  });
});

/** A stand-in live terminal: its input socket, output worker and output socket. */
function standInTerminal(): { pty: unknown; sources: EventEmitter[] } {
  const input = new EventEmitter();
  const worker = new EventEmitter();
  const output = new EventEmitter();
  const pty = {
    // node-pty's terminal puts an 'error' listener on its output socket.
    on: (event: string, listener: (error: Error) => void): void => {
      output.on(event, listener);
    },
    _agent: { inSocket: input, _conoutSocketWorker: { _worker: worker } },
  };
  return { pty, sources: [input, worker, output] };
}

describe('listenForTerminalErrors', () => {
  it('attaches nothing while node-pty is not wrapped', async () => {
    // A fresh copy of the module, which has wrapped nothing yet.
    vi.resetModules();
    const fresh = await import('../../src/core/windowsPtyStart.js');
    const { pty, sources } = standInTerminal();

    expect(fresh.listenForTerminalErrors(pty, () => undefined)).toBe(false);
    expect(sources.map((source) => source.listenerCount('error'))).toEqual([0, 0, 0]);

    // The same terminal is listened to on all three once the wrapper is in
    // place, so it is the gate that kept it apart above.
    expect(fresh.releaseFailedStarts()).toBe(true);
    expect(fresh.listenForTerminalErrors(pty, () => undefined)).toBe(true);
    expect(sources.map((source) => source.listenerCount('error'))).toEqual([1, 1, 1]);
  });
});

describe('recordedExitCode', () => {
  it("reads the exit code node-pty records for a terminal's program, only while it is wrapped", async () => {
    // A fresh copy of the module, which has wrapped nothing yet.
    vi.resetModules();
    const fresh = await import('../../src/core/windowsPtyStart.js');
    const ended = { _agent: { _useConpty: true, exitCode: 3 } };

    expect(fresh.recordedExitCode(ended)).toBeUndefined();
    expect(fresh.releaseFailedStarts()).toBe(true);
    expect(fresh.recordedExitCode(ended)).toBe(3);
    // node-pty's agent reports no code while the program runs.
    expect(fresh.recordedExitCode({ _agent: { _useConpty: true } })).toBeUndefined();
    // Under winpty the agent asks Windows about whatever process has the pid
    // now, which answers 259 (still active) for a live one: not a code.
    expect(fresh.recordedExitCode({ _agent: { _useConpty: false, exitCode: 259 } })).toBeUndefined();
  });
});

describe('canReadExitCode', () => {
  it('holds only for a ConPTY terminal of the wrapped node-pty', async () => {
    // A fresh copy of the module, which has wrapped nothing yet.
    vi.resetModules();
    const fresh = await import('../../src/core/windowsPtyStart.js');
    const conpty = { _agent: { _useConpty: true } };

    expect(fresh.canReadExitCode(conpty)).toBe(false);
    expect(fresh.releaseFailedStarts()).toBe(true);
    expect(fresh.canReadExitCode(conpty)).toBe(true);
    expect(fresh.canReadExitCode({ _agent: { _useConpty: false } })).toBe(false);
    expect(fresh.canReadExitCode({})).toBe(false);
  });
});

/** A helper process that does what it is told, and records being killed. */
class StandInHelper extends EventEmitter implements ConsoleListHelper {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('consoleProcessList', () => {
  // The program's own pid is 4242 throughout: whatever happens, the list must
  // never fall back to it, because by the time a kill asks, that pid may
  // belong to another process.
  const PROGRAM = 4242;

  it('is what the helper reports', async () => {
    const helper = new StandInHelper();
    const listed = consoleProcessList(PROGRAM, () => helper, 60_000);
    helper.emit('message', { consoleProcessList: [PROGRAM, 11, 22] });
    helper.emit('close');
    expect(await listed).toEqual([PROGRAM, 11, 22]);
  });

  it('is empty, at once, when the helper exits without answering', async () => {
    // As node-pty's helper does when the program has gone: it cannot attach
    // to a console nobody holds. A minute's cap shows this does not wait.
    const helper = new StandInHelper();
    const listed = consoleProcessList(PROGRAM, () => helper, 60_000);
    helper.emit('close');
    expect(await listed).toEqual([]);
  });

  it('is empty when the helper cannot be started or fails', async () => {
    expect(
      await consoleProcessList(PROGRAM, () => {
        throw new Error('spawn EPERM');
      }),
    ).toEqual([]);
    const helper = new StandInHelper();
    const listed = consoleProcessList(PROGRAM, () => helper, 60_000);
    helper.emit('error', new Error('channel closed'));
    expect(await listed).toEqual([]);
  });

  it('is empty, and the helper is ended, when it does not answer in time', async () => {
    const helper = new StandInHelper();
    expect(await consoleProcessList(PROGRAM, () => helper, 10)).toEqual([]);
    expect(helper.killed).toBe(true);
  });

  it('leaves out anything in an answer that is not a pid', async () => {
    const helper = new StandInHelper();
    const listed = consoleProcessList(PROGRAM, () => helper, 60_000);
    helper.emit('message', { consoleProcessList: [11, 'x', 2.5, null] });
    expect(await listed).toEqual([11]);
  });
});
