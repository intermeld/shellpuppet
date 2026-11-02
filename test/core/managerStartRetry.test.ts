import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import type { Logger } from '../../src/core/types.js';

type Exit = (event: { exitCode: number }) => void;

class StartPty implements IPty {
  pid: number;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'cmd.exe';
  handleFlowControl = false;
  kills = 0;
  private exit?: Exit;
  private errors: ((error: Error) => void)[] = [];
  readonly _agent = { onError: (listener: (error: Error) => void): void => { this.errors.push(listener); } };

  constructor(pid: number, error?: string) {
    this.pid = pid;
    if (error !== undefined) setTimeout(() => {
      for (const listener of this.errors) listener(new Error(error));
      this.exit?.({ exitCode: -1 });
    }, 0);
  }
  onData(): { dispose(): void } { return { dispose(): void {} }; }
  onExit(listener: Exit): { dispose(): void } { this.exit = listener; return { dispose(): void {} }; }
  resize(): void {}
  clear(): void {}
  write(): void {}
  kill(): void { this.kills++; }
  pause(): void {}
  resume(): void {}
}

function harness(errors: (string | undefined)[]) {
  const ptys: StartPty[] = [];
  const queued: string[] = [];
  const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
  const noop = (): void => undefined;
  const logger: Logger = {
    debug: noop, info: noop, error: noop,
    warn: (message, meta) => { warnings.push({ message, meta }); },
  };
  const manager = new SessionManager(compilePolicy(undefined), logger, {
    platform: 'win32',
    treeKiller: () => Promise.resolve(null),
    spawn: () => {
      const error = errors[ptys.length];
      const pty = new StartPty(error === undefined ? 12345 : 0, error);
      ptys.push(pty);
      return pty;
    },
    queueConsoleHostEnd: (item) => { queued.push(item.id); },
    registerConsoleHostWindow: noop,
  });
  return { manager, ptys, queued, warnings };
}

const timeout = 'Timed out waiting for ConPTY output worker';

describe('ConPTY start retry', () => {
  it('retries one pre-program timeout under the same session id and cleans the first attempt', async () => {
    const { manager, ptys, queued, warnings } = harness([timeout, undefined]);
    const first = manager.create({ command: 'cmd.exe', shell: true });
    const result = await manager.finishStart(first, { command: 'cmd.exe', shell: true });
    expect(ptys).toHaveLength(2);
    expect(ptys[0]?.kills).toBe(1);
    expect(queued).toEqual([first.id]);
    expect(manager.size()).toBe(1);
    expect(result.id).toBe(first.id);
    expect(manager.get(first.id)).toBe(result);
    expect(warnings).toEqual([{ message: 'session ConPTY start retry', meta: { id: first.id, delayMs: 100 } }]);
    await manager.kill(first.id);
  });

  it('reports a second timeout once and leaves no session', async () => {
    const { manager, ptys, queued, warnings } = harness([timeout, timeout]);
    const first = manager.create({ command: 'cmd.exe', shell: true });
    await expect(manager.finishStart(first, { command: 'cmd.exe', shell: true })).rejects.toThrow('ConPTY output worker never connected');
    expect(ptys).toHaveLength(2);
    expect(ptys.map((pty) => pty.kills)).toEqual([1, 1]);
    expect(queued).toEqual([first.id, first.id]);
    expect(manager.size()).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it('does not retry another pre-program failure', async () => {
    const { manager, ptys, queued, warnings } = harness(['The output worker failed']);
    const first = manager.create({ command: 'cmd.exe', shell: true });
    await expect(manager.finishStart(first, { command: 'cmd.exe', shell: true })).rejects.toThrow('The output worker failed');
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.kills).toBe(1);
    expect(queued).toEqual([first.id]);
    expect(manager.size()).toBe(0);
    expect(warnings).toHaveLength(0);
  });
});
