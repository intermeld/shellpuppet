import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { Daemon } from '../../src/daemon/server.js';
import { NULL_LOGGER } from '../../src/core/types.js';
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

  constructor(pid: number, error?: string, pidDelayMs = 0) {
    this.pid = pid;
    if (pidDelayMs > 0) {
      this.pid = 0;
      setTimeout(() => { this.pid = pid; }, pidDelayMs);
    }
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
  kill(): void { this.kills++; this.pid = 0; }
  pause(): void {}
  resume(): void {}
}

function harness(errors: (string | undefined)[], options: {
  secondPidDelayMs?: number;
  onSecondSpawn?: () => void;
  hostEnded?: boolean;
  onHostQueue?: (settle: (ended: boolean) => void) => void;
} = {}) {
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
      const pty = new StartPty(error === undefined ? 12345 : 0, error,
        ptys.length === 1 ? options.secondPidDelayMs : 0);
      ptys.push(pty);
      if (ptys.length === 2) options.onSecondSpawn?.();
      return pty;
    },
    queueConsoleHostEnd: (item) => {
      queued.push(item.id);
      const settle = item.onSettled;
      if (options.onHostQueue !== undefined) options.onHostQueue((ended) => settle?.(ended));
      else settle?.(options.hostEnded ?? true);
    },
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

  for (const [name, cancel] of [
    ['kill', (manager: SessionManager, id: string) => manager.kill(id)],
    ['killAll', (manager: SessionManager) => manager.killAll()],
  ] as const) {
    it(`fails a start cancelled by ${name} while the second pid is pending`, async () => {
      let secondSpawned: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => { secondSpawned = resolve; });
      const { manager, ptys } = harness([timeout, undefined], {
        secondPidDelayMs: 300, onSecondSpawn: secondSpawned,
      });
      const first = manager.create({ command: 'cmd.exe', shell: true });
      const starting = manager.finishStart(first, { command: 'cmd.exe', shell: true });
      const failed = expect(starting).rejects.toThrow();
      await entered;
      const stopping = cancel(manager, first.id);
      await failed;
      await stopping;
      expect(manager.size()).toBe(0);
      expect(ptys[1]?.kills).toBe(1);
      expect(ptys[1]?.pid).toBe(0);
    }, 15_000);
  }

  it('fails a start when daemon stop begins while the second pid is pending', async () => {
    let secondSpawned: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { secondSpawned = resolve; });
    const { manager, ptys } = harness([timeout, undefined], {
      secondPidDelayMs: 300, onSecondSpawn: secondSpawned,
    });
    const home = fs.mkdtempSync(path.join(process.env['TMP'] ?? process.cwd(), 'retry-stop-'));
    const daemon = new Daemon({ home, logger: NULL_LOGGER });
    await daemon.start();
    (daemon as unknown as { manager: SessionManager }).manager = manager;
    try {
      const first = manager.create({ command: 'cmd.exe', shell: true });
      const failed = expect(manager.finishStart(first, { command: 'cmd.exe', shell: true })).rejects.toThrow();
      await entered;
      const stopping = daemon.stop();
      await failed;
      await stopping;
      expect(manager.size()).toBe(0);
      expect(ptys[1]?.kills).toBe(1);
      expect(ptys[1]?.pid).toBe(0);
    } finally {
      await daemon.stop();
    }
  }, 25_000);

  it('does not spawn a retry when kill begins during the first attempt cleanup', async () => {
    let settleHost: (ended: boolean) => void = () => undefined;
    let hostQueued: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { hostQueued = resolve; });
    const { manager, ptys } = harness([timeout, undefined], {
      onHostQueue: (settle) => { settleHost = settle; hostQueued(); },
    });
    const first = manager.create({ command: 'cmd.exe', shell: true });
    const failed = expect(manager.finishStart(first, { command: 'cmd.exe', shell: true })).rejects.toThrow();
    await entered;
    while (ptys[0]?.kills !== 1) await new Promise((resolve) => setTimeout(resolve, 1));
    const killing = manager.kill(first.id);
    settleHost(true);
    await failed;
    await killing;
    expect(ptys).toHaveLength(1);
    expect(manager.size()).toBe(0);
  });

  it('does not retry when the failed attempt\'s console host was not ended', async () => {
    const { manager, ptys } = harness([timeout, undefined], { hostEnded: false });
    const first = manager.create({ command: 'cmd.exe', shell: true });
    await expect(manager.finishStart(first, { command: 'cmd.exe', shell: true })).rejects.toThrow('ConPTY output worker never connected');
    expect(ptys).toHaveLength(1);
    expect(manager.size()).toBe(0);
  });

  it('waits past node-pty\'s worker disposal bound before the retry spawn', async () => {
    let secondAt = 0;
    const { manager } = harness([timeout, undefined], { onSecondSpawn: () => { secondAt = Date.now(); } });
    const first = manager.create({ command: 'cmd.exe', shell: true });
    const began = Date.now();
    await manager.finishStart(first, { command: 'cmd.exe', shell: true });
    expect(secondAt - began).toBeGreaterThanOrEqual(1_100);
    await manager.kill(first.id);
  });
});
