/**
 * A failed write on a live Windows terminal's pipes must not take the daemon
 * down. node-pty 1.1.0 listens for no error on the socket it writes input
 * through, nor on the worker that copies the output pipe, and throws an
 * output-socket error while its own handler is the socket's only listener,
 * so each would be an uncaught exception. The input pipe refuses a write once
 * the console host has closed its end (`write EAGAIN`): the last test makes
 * that happen for real by ending the session's own console host. The others
 * emit the errors libuv and the worker would deliver, on the session's own
 * objects, and check that input after a failed input pipe is refused, not
 * lost, over the API and in the viewer. A failed output socket closes the
 * terminal with an exit that carries no code while the program runs on; the
 * session's kill still walks the program's tree.
 */

import { execFileSync } from 'node:child_process';
import type * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import { compilePolicy } from '../../src/core/policy.js';
import { taskkillTrees } from '../../src/core/session.js';
import type { Session, TreeKiller } from '../../src/core/session.js';
import type { Logger } from '../../src/core/types.js';
import type { Auditor } from '../../src/daemon/audit.js';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, connectWs, eventually, interactiveShell, processAlive, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const managers: SessionManager[] = [];
const daemons: TestDaemon[] = [];
afterEach(async () => {
  while (managers.length > 0) await managers.pop()?.killAll();
  while (daemons.length > 0) await daemons.pop()?.stop();
});

type Warning = { message: string; meta?: Record<string, unknown> };

function managerWithLog(): { manager: SessionManager; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const ignore = (): void => undefined;
  const logger: Logger = { debug: ignore, info: ignore, error: ignore, warn: (message, meta) => warnings.push({ message, meta }) };
  const manager = new SessionManager(compilePolicy(undefined), logger);
  managers.push(manager);
  return { manager, warnings };
}

type Agent = {
  inSocket?: NodeJS.EventEmitter;
  outSocket?: net.Socket;
  exitCode?: number;
  _conoutSocketWorker?: { _worker?: NodeJS.EventEmitter };
};
function agentOf(session: Session): Agent {
  const agent = (session as unknown as { pty: { _agent?: Agent } }).pty._agent;
  if (agent === undefined) throw new Error('no Windows agent on this terminal');
  return agent;
}

function refusal(): Error {
  return Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN', errno: -4088, syscall: 'write' });
}

/** A logger that keeps every line, at every level. */
function recordingLogger(): { logger: Logger; entries: Warning[] } {
  const entries: Warning[] = [];
  const keep = (message: string, meta?: Record<string, unknown>): void => {
    entries.push({ message, meta });
  };
  return { logger: { debug: keep, info: keep, warn: keep, error: keep }, entries };
}

/** Start the platform's shell on a test daemon; its id. */
async function startShell(td: TestDaemon): Promise<string> {
  const started = await api(td.port, td.token, '/sessions', { body: { ...interactiveShell(), cols: 80, rows: 24 } });
  expect(started.status).toBe(200);
  return String(started.body['id']);
}

function sessionOf(td: TestDaemon, id: string): Session {
  const session = (td.daemon as unknown as { manager: SessionManager }).manager.get(id);
  if (session === undefined) throw new Error(`no session ${id}`);
  return session;
}

/**
 * The console hosts this process owns: one per pseudoconsole it created. A
 * busy machine can cancel the WMI query ("Call cancelled"), so it is tried
 * three times.
 */
function consoleHosts(): number[] {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(process.pid)} AND Name='conhost.exe'" | ForEach-Object { $_.ProcessId }`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      return out
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

describe.skipIf(process.platform !== 'win32')('a failed write on a Windows terminal', () => {
  it('is taken by the session when its input is refused, logged once, and leaves its neighbour running', async () => {
    const { manager, warnings } = managerWithLog();
    const refused = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    const neighbour = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    const input = agentOf(refused).inSocket;
    if (input === undefined) throw new Error('no input socket');

    // With no listener, emit('error') throws the error back at its caller.
    expect(() => input.emit('error', refusal())).not.toThrow();
    expect(() => input.emit('error', refusal())).not.toThrow();

    const reports = warnings.filter((w) => w.message === 'session input failed');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.meta).toMatchObject({ id: refused.id, error: 'Error: write EAGAIN' });

    // The neighbour still takes input and shows its output.
    await neighbour.write('echo still-here\r');
    await eventually(() => neighbour.getScreen().includes('still-here'));
  }, 60_000);

  it('is taken by the session when the output worker fails, and input still goes in', async () => {
    const { manager, warnings } = managerWithLog();
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    const worker = agentOf(session)._conoutSocketWorker?._worker;
    if (worker === undefined) throw new Error('no output worker');

    expect(() => worker.emit('error', refusal())).not.toThrow();
    expect(warnings.filter((w) => w.message === 'session output failed')).toHaveLength(1);
    // Only the input pipe failing refuses input.
    await expect(session.write('echo still-typed\r')).resolves.toBeTypeOf('string');
  }, 60_000);

  it('is taken by the session when its output socket fails, with node-pty listening on it too', async () => {
    const { manager, warnings } = managerWithLog();
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    // Output arrives only once the socket has connected, and node-pty puts
    // its own handler on the socket then. That handler throws any error but
    // EIO while it is the socket's only 'error' listener.
    await eventually(() => session.getScreen().trim() !== '');
    const output = agentOf(session).outSocket;
    if (output === undefined) throw new Error('no output socket');

    expect(() => output.emit('error', refusal())).not.toThrow();
    expect(warnings.filter((w) => w.message === 'session output failed')).toHaveLength(1);
  }, 60_000);

  it('refuses input once its input pipe has failed, rather than losing it', async () => {
    const { manager } = managerWithLog();
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    const input = agentOf(session).inSocket;
    if (input === undefined) throw new Error('no input socket');

    input.emit('error', refusal());
    await expect(session.write('echo lost\r')).rejects.toThrow(
      /^Session s\d+'s input pipe has failed \(Error: write EAGAIN\), .*Kill the session and start it again\.$/,
    );
    // And every write after it, not only the first.
    await expect(session.write('echo lost\r')).rejects.toMatchObject({ name: 'SessionInputFailedError' });
  }, 60_000);

  it('refuses the rest of a long write when the input pipe fails part-way through it', async () => {
    const { manager } = managerWithLog();
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    await eventually(() => session.getScreen().trim() !== '');
    const input = agentOf(session).inSocket;
    if (input === undefined) throw new Error('no input socket');
    // The pipe fails as the first piece goes in, as a refused write reports
    // itself after the write.
    const pty = (session as unknown as { pty: { write(data: string): void } }).pty;
    const write = pty.write.bind(pty);
    let pieces = 0;
    pty.write = (data: string): void => {
      pieces += 1;
      write(data);
      if (pieces === 1) input.emit('error', refusal());
    };

    await expect(session.write(`echo ${'x'.repeat(3_000)}`)).rejects.toMatchObject({ name: 'SessionInputFailedError' });
    expect(pieces).toBe(1);
  }, 60_000);

  it('answers input and keys with a 409 over HTTP once its input pipe has failed', async () => {
    const td = await startTestDaemon();
    daemons.push(td);
    const id = await startShell(td);
    const input = agentOf(sessionOf(td, id)).inSocket;
    if (input === undefined) throw new Error('no input socket');

    input.emit('error', refusal());
    const typed = await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'echo lost\r' } });
    expect(typed.status).toBe(409);
    expect(String(typed.body['error'])).toBe(
      `Session ${id}'s input pipe has failed (Error: write EAGAIN), so input cannot reach its program. ` +
        'Kill the session and start it again.',
    );
    const pressed = await api(td.port, td.token, `/sessions/${id}/key`, { body: { key: 'enter' } });
    expect(pressed.status).toBe(409);
    expect(String(pressed.body['error'])).toBe(String(typed.body['error']));
  }, 60_000);

  it('tells a viewer once that its input has failed, and writes, audits and logs none of its keys', async () => {
    const { logger, entries } = recordingLogger();
    const audited: string[] = [];
    const audit: Auditor = { captureContent: false, record: (_actor, action) => audited.push(action) };
    const td = await startTestDaemon({ logger, audit });
    daemons.push(td);
    const id = await startShell(td);
    const session = sessionOf(td, id);
    await eventually(() => session.getScreen().trim() !== '');
    const viewer = await connectWs(td.port, id, td.token);
    const input = agentOf(session).inSocket;
    if (input === undefined) throw new Error('no input socket');

    input.emit('error', refusal());
    const auditedBefore = audited.length;
    const sourcesBefore = viewer.controls().filter((control) => control['type'] === 'input-source').length;
    for (const key of ['a', 'b', 'c']) viewer.ws.send(key);
    await eventually(
      () =>
        viewer.controls().some((control) => control['type'] === 'input-refused') ||
        entries.filter((entry) => entry.message === 'viewer input failed').length === 3,
      5_000,
    );
    // Time for any further frame or log line to arrive.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(viewer.controls().filter((control) => control['type'] === 'input-refused')).toEqual([
      { type: 'input-refused', reason: 'input-failed' },
    ]);
    expect(audited.slice(auditedBefore)).toEqual([]);
    expect(viewer.controls().filter((control) => control['type'] === 'input-source')).toHaveLength(sourcesBefore);
    expect(entries.filter((entry) => entry.message === 'viewer input failed')).toEqual([]);
    expect(session.exited).toBe(false);
    viewer.close();
  }, 60_000);

  it("shows the person at the viewer that the session's input has failed", async (context) => {
    const browser = await findBrowser();
    if (browser === null) {
      context.skip();
      return;
    }
    const td = await startTestDaemon();
    daemons.push(td);
    const id = await startShell(td);
    const session = sessionOf(td, id);
    await eventually(() => session.getScreen().trim() !== '');
    const input = agentOf(session).inSocket;
    if (input === undefined) throw new Error('no input socket');
    input.emit('error', refusal());
    const minted = await api(td.port, td.token, `/sessions/${id}/viewer`, { body: {} });
    expect(minted.status).toBe(200);

    // The page types a key a second, as a person would, until it shows the
    // notice or has tried six times; then it reports the line it shows.
    const capture = await captureViewer({
      browser,
      viewerUrl: String(minted.body['viewerUrl']),
      width: 900,
      height: 600,
      drive: true,
      timeoutMs: 60_000,
      probe: `(() => {
        const hint = document.getElementById('mode-hint');
        const typing = document.querySelector('.xterm-helper-textarea');
        if (!hint || !typing) return null;
        const st = (window.__typing = window.__typing || { tries: 0, at: 0 });
        if (hint.textContent.includes('input has failed') || st.tries >= 6) return hint.textContent;
        if (Date.now() - st.at >= 1000) {
          st.at = Date.now();
          st.tries += 1;
          typing.dispatchEvent(new InputEvent('input', { data: 'a', inputType: 'insertText' }));
        }
        return null;
      })()`,
    });
    expect(capture.probe).toBe("this session's input has failed; kill it and start it again");
  }, 120_000);

  it('walks the tree of a program whose output socket failed, though the session has ended', async () => {
    const { logger, entries } = recordingLogger();
    const manager = new SessionManager(compilePolicy(undefined), logger);
    managers.push(manager);
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    await eventually(() => session.getScreen().trim() !== '');
    const pid = session.pid;
    const output = agentOf(session).outSocket;
    if (output === undefined) throw new Error('no output socket');

    // A dying output worker ends the socket with an error that is not EIO.
    // node-pty then closes the terminal and reports an exit with no code,
    // while the program runs on.
    output.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -4077, syscall: 'read' }));
    await eventually(() => session.exited, 10_000);
    const codeAtExit = session.exitCode;
    expect(processAlive(pid)).toBe(true);

    await manager.kill(session.id);
    const messages = entries.map((entry) => entry.message);
    expect(messages).toContain('session tree killed');
    expect(messages.filter((message) => message.includes('SURVIVED'))).toEqual([]);
    expect(processAlive(pid)).toBe(false);
    expect(codeAtExit).toBeNull();
  }, 60_000);

  it('leaves out of the shutdown tree kill a program node-pty has seen end after its output socket failed', async () => {
    const { logger } = recordingLogger();
    const walked: number[][] = [];
    const treeKiller: TreeKiller = (pids) => {
      walked.push([...pids]);
      return taskkillTrees(pids);
    };
    const manager = new SessionManager(compilePolicy(undefined), logger, { treeKiller });
    managers.push(manager);
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    await eventually(() => session.getScreen().trim() !== '');
    const pid = session.pid;
    const agent = agentOf(session);
    agent.outSocket?.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await eventually(() => session.exited, 10_000);

    // The program then ends, and node-pty records its code. Its pid is free
    // from then on, for Windows to give to another process.
    process.kill(pid);
    await eventually(() => agent.exitCode !== undefined, 10_000);

    await manager.killAll();
    expect(walked).toEqual([]);
  }, 60_000);

  it('takes a real refusal, once the console host has gone', async () => {
    const { manager, warnings } = managerWithLog();
    const before = new Set(consoleHosts());
    const session = manager.create({ ...interactiveShell(), cols: 80, rows: 24 });
    await eventually(() => session.getScreen().trim() !== '');
    const added = consoleHosts().filter((pid) => !before.has(pid));
    expect(added).toHaveLength(1);

    // Ending the session's own console host closes its end of the input
    // pipe; writes then race the exit node-pty reports soon after. A write
    // that lands in between is refused by Windows, and with no listener
    // that would be uncaught, failing this run.
    process.kill(added[0] as number);
    const until = Date.now() + 3_000;
    while (!session.exited && Date.now() < until && !warnings.some((w) => w.message === 'session input failed')) {
      void session.write('\x1b[O');
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(warnings.filter((w) => w.message === 'session input failed').length).toBeLessThanOrEqual(1);
  }, 60_000);
});
