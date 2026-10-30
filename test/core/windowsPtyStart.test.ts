/**
 * A Windows start that fails part-way releases what node-pty had built: the
 * output worker, both sockets and, under ConPTY, the pseudoconsole. These
 * drive the wrapper with a stand-in for node-pty's agent module;
 * `test/integration/failed-start.test.ts` drives the real one. The rest cover
 * what the same wrapper decides and listens to: the list of pids node-pty's
 * kill ends, which is empty and found with no helper started (and in
 * `test/integration/kill-reused-pid.test.ts` with real terminals), a live
 * terminal's streams and the exit code node-pty records.
 */

import type { ChildProcess } from 'node:child_process';
import { channel, subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { releaseFailedStarts, wrapIfKnownVersion, wrapWindowsPtyAgent } from '../../src/core/windowsPtyStart.js';
import type { AgentModule, HalfBuiltAgent } from '../../src/core/windowsPtyStart.js';

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

  it('replaces the list of pids a kill ends with an empty one', async () => {
    const { module } = standInModule('nowhere');
    const prototype = module.WindowsPtyAgent.prototype;
    // node-pty's own lists a console by the program's pid, or returns that pid.
    const nodePtys = (): Promise<number[]> => Promise.resolve([42]);
    prototype._getConsoleProcessList = nodePtys;
    wrapWindowsPtyAgent(module);

    expect(prototype._getConsoleProcessList).not.toBe(nodePtys);
    expect(await prototype._getConsoleProcessList()).toEqual([]);
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

describe("the list of pids node-pty's kill ends", () => {
  it('is empty, and no helper is forked to find it', async () => {
    expect(releaseFailedStarts()).toBe(true);
    const require = createRequire(import.meta.url);
    const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent.js') as {
      WindowsPtyAgent: { prototype: { _getConsoleProcessList(this: { _innerPid: number }): Promise<number[]> } };
    };
    // Node publishes every child process as it is constructed; node-pty's own
    // method forks its helper inside the call.
    const children: ChildProcess[] = [];
    const capture = (message: unknown): void => {
      children.push((message as { process: ChildProcess }).process);
    };
    subscribe('child_process', capture);
    let listed: Promise<number[]>;
    try {
      listed = WindowsPtyAgent.prototype._getConsoleProcessList.call({ _innerPid: 4321 });
    } finally {
      unsubscribe('child_process', capture);
    }

    expect(children).toEqual([]);
    await expect(listed).resolves.toEqual([]);
    expect(channel('child_process').hasSubscribers).toBe(false);
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
