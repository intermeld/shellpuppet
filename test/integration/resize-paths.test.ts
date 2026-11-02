/**
 * The resize paths through the daemon on Windows, over HTTP and a viewer's
 * socket, around the end of a session's program.
 *
 * - A resize over HTTP before the first output of a program that exits with
 *   code 0, the commonest code, leaves the daemon up, and `Session.resize`
 *   refuses one after that end as after any other.
 * - Between node-pty recording the program's end and the session's exit
 *   event (node-pty flushes output for a second first), a resize over HTTP is
 *   answered with the 409 a session that has exited gets, and nothing is
 *   logged as an error.
 * - In the same moment a viewer's proposal moves nothing and gets no answer,
 *   so a page whose window does not fit the grid, which proposes again on
 *   every geometry frame that says the grid is its own, does not ask again
 *   and again until the exit arrives.
 */

import * as fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionManager } from '../../src/core/manager.js';
import type { Session } from '../../src/core/session.js';
import { recordedExitCode } from '../../src/core/windowsPtyStart.js';
import { createFileLogger } from '../../src/daemon/logger.js';
import { daemonLogPath } from '../../src/daemon/paths.js';
import { Daemon } from '../../src/daemon/server.js';
import { api, connectWs, makeTempHome, removeTempHome } from './helpers.js';

type LogEntry = { level: string; message: string; meta?: Record<string, unknown> };

const daemons: Daemon[] = [];
const homes: string[] = [];
afterAll(async () => {
  for (const daemon of daemons) await daemon.stop();
  for (const home of homes) removeTempHome(home);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startDaemon(prefix: string): Promise<{ daemon: Daemon; port: number; token: string; logPath: string }> {
  const home = makeTempHome(prefix);
  homes.push(home);
  const logPath = daemonLogPath(home);
  const daemon = new Daemon({ home, logger: createFileLogger(logPath) });
  daemons.push(daemon);
  const { port, token } = await daemon.start();
  return { daemon, port, token, logPath };
}

function sessionOf(daemon: Daemon, id: string): Session {
  const session = (daemon as unknown as { manager: SessionManager }).manager.get(id);
  if (session === undefined) throw new Error(`no session ${id}`);
  return session;
}

function exitOf(session: Session): Promise<number | null> {
  return new Promise((resolve) => {
    if (session.exited) resolve(session.exitCode);
    else session.onExit(resolve);
  });
}

/** Until node-pty has recorded the program's end, which comes before the session's exit. */
async function untilRecordedEnd(session: Session): Promise<void> {
  const startedAt = Date.now();
  while (recordedExitCode((session as unknown as { pty: unknown }).pty) === undefined) {
    if (Date.now() - startedAt > 20_000) throw new Error('node-pty never recorded the end');
    await sleep(5);
  }
}

function logEntries(logPath: string): LogEntry[] {
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogEntry);
}

describe.skipIf(process.platform !== 'win32')('resizes around the end of a program (Windows)', () => {
  it('an HTTP resize before the first output of a program that exits 0 leaves the daemon up', async () => {
    const uncaught: unknown[] = [];
    const listener = (error: unknown): void => void uncaught.push(error);
    process.on('uncaughtException', listener);
    let output: { pause(): void; resume(): void } | undefined;
    try {
      const { daemon, port, token, logPath } = await startDaemon('resize-exit-zero-');
      const manager = (daemon as unknown as { manager: SessionManager }).manager;
      const create = manager.create.bind(manager);
      // Keep the output socket from delivering its first data event until
      // after the HTTP resize and the program's own exit. This forces the
      // deferred node-pty resize path on every run.
      manager.create = (options) => {
        const session = create(options);
        output = (session as unknown as { pty: { _socket: { pause(): void; resume(): void } } }).pty._socket;
        output.pause();
        return session;
      };
      const marker = `${logPath}.exit-now`;
      const script = `const fs = require('node:fs'); const timer = setInterval(() => { ` +
        `if (fs.existsSync(${JSON.stringify(marker)})) { clearInterval(timer); console.log('done'); process.exit(0); } ` +
        `}, 10);`;
      const started = await api(port, token, '/sessions', {
        body: { command: process.execPath, args: ['-e', script], shell: false },
      });
      expect(started.status).toBe(200);
      const id = String(started.body['id']);
      const session = sessionOf(daemon, id);
      const pty = (session as unknown as { pty: { _isReady: boolean } }).pty;
      expect(pty._isReady).toBe(false);
      const resized = await api(port, token, `/sessions/${id}/resize`, { body: { cols: 100, rows: 30 } });
      expect(resized.status).toBe(200);
      expect(pty._isReady).toBe(false);
      fs.writeFileSync(marker, '');
      await untilRecordedEnd(session);
      output?.resume();
      expect(await exitOf(session)).toBe(0);
      expect(uncaught).toEqual([]);
      expect((await api(port, null, '/health')).status).toBe(200);
      // After an exit with code 0, Session.resize refuses, as for any code.
      expect(() => session.resize(80, 24)).toThrow(/exited \(code 0\)/);
    } finally {
      output?.resume();
      process.off('uncaughtException', listener);
    }
  });

  it('an HTTP resize after node-pty recorded the end but before the exit event is refused with a 409', async () => {
    const { daemon, port, token, logPath } = await startDaemon('resize-window-');
    const started = await api(port, token, '/sessions', { body: { command: 'exit', args: ['0'] } });
    const id = String(started.body['id']);
    const session = sessionOf(daemon, id);
    await untilRecordedEnd(session);
    expect(session.exited).toBe(false);

    const inWindow = await api(port, token, `/sessions/${id}/resize`, { body: { cols: 100, rows: 30 } });
    await exitOf(session);
    const afterExit = await api(port, token, `/sessions/${id}/resize`, { body: { cols: 100, rows: 30 } });

    expect(afterExit.status).toBe(409);
    expect(inWindow.status).toBe(409);
    // The same answer, a moment earlier.
    expect(inWindow.body['error']).toBe(afterExit.body['error']);
    expect(String(inWindow.body['error'])).toContain(`Session ${id} has exited (code 0)`);
    expect(logEntries(logPath).filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it("a viewer's resize in that moment moves nothing, gets no answer and logs nothing", async () => {
    const { daemon, port, token, logPath } = await startDaemon('resize-viewer-');
    const started = await api(port, token, '/sessions', {
      body: { command: 'ping', args: ['-n', '2', '127.0.0.1'] },
    });
    const id = String(started.body['id']);
    const session = sessionOf(daemon, id);
    const viewer = await connectWs(port, id, token);
    try {
      await viewer.waitForControl((c) => c['type'] === 'geometry');
      const before = { cols: session.cols, rows: session.rows };
      await untilRecordedEnd(session);
      expect(session.exited).toBe(false);
      const seen = viewer.controls().length;
      viewer.ws.send(JSON.stringify({ type: 'resize', cols: before.cols - 10, rows: before.rows - 4 }));
      await sleep(300);

      expect([session.cols, session.rows]).toEqual([before.cols, before.rows]);
      expect(viewer.controls().slice(seen).filter((c) => c['type'] === 'geometry')).toEqual([]);
      expect(logEntries(logPath).filter((entry) => entry.message === 'viewer resize failed')).toEqual([]);
      expect((await api(port, null, '/health')).status).toBe(200);
    } finally {
      viewer.close();
    }
  });

  it('a page that proposes again on each geometry frame, as viewer.js does, asks once until the exit', async () => {
    const { daemon, port, token, logPath } = await startDaemon('resize-loop-');
    const started = await api(port, token, '/sessions', {
      body: { command: 'ping', args: ['-n', '2', '127.0.0.1'] },
    });
    const id = String(started.body['id']);
    const session = sessionOf(daemon, id);
    const viewer = await connectWs(port, id, token);
    try {
      await viewer.waitForControl((c) => c['type'] === 'geometry');
      const wanted = { cols: session.cols - 10, rows: session.rows - 4 };
      await untilRecordedEnd(session);
      // viewer.js: on a geometry frame that says the grid is this page's,
      // fit the window, and ask again while the grid is not what it holds.
      let proposals = 0;
      let geometryFrames = 0;
      let exitedFrame = false;
      viewer.ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const control = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (control['type'] === 'exited') exitedFrame = true;
        if (control['type'] !== 'geometry' || exitedFrame) return;
        geometryFrames++;
        if (control['control'] !== 'yours') return;
        if (control['cols'] === wanted.cols && control['rows'] === wanted.rows) return;
        proposals++;
        viewer.ws.send(JSON.stringify({ type: 'resize', ...wanted }));
      });
      const startedAt = Date.now();
      proposals++;
      viewer.ws.send(JSON.stringify({ type: 'resize', ...wanted }));
      while (!exitedFrame && Date.now() - startedAt < 5_000) await sleep(20);

      expect(exitedFrame).toBe(true);
      // node-pty flushes for a second between the end and the exit event.
      expect(Date.now() - startedAt).toBeGreaterThan(500);
      expect({ proposals, geometryFrames }).toEqual({ proposals: 1, geometryFrames: 0 });
      expect(logEntries(logPath).filter((entry) => entry.message === 'viewer resize failed')).toEqual([]);
      expect((await api(port, null, '/health')).status).toBe(200);
    } finally {
      viewer.close();
    }
  });
});
