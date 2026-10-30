/**
 * A Windows start that fails part-way releases what node-pty had built: the
 * output worker, both sockets and, under ConPTY, the pseudoconsole. These
 * drive the wrapper with a stand-in for node-pty's agent module;
 * `test/integration/failed-start.test.ts` drives the real one.
 */

import { describe, expect, it } from 'vitest';
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
