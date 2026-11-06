import * as http from 'node:http';
import { channel } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';
import type { TestDaemon } from './helpers.js';
import type { Logger } from '../../src/core/types.js';
import type { SessionManager } from '../../src/core/manager.js';

/** Keep transport and daemon facts for a failed short-lived Windows start. */
export function startDiagnostics(): {
  logger: Logger; attach: (td: TestDaemon) => void; report: () => string; close: () => void;
} {
  const began = performance.now();
  const events: unknown[] = [];
  const record = (event: string, facts: unknown): void => {
    events.push({ ms: Math.round(performance.now() - began), event, facts });
  };
  const logger: Logger = {
    debug: (message, meta) => record(message, meta), info: (message, meta) => record(message, meta),
    warn: (message, meta) => record(message, meta), error: (message, meta) => record(message, meta),
  };
  const subscriptions: (() => void)[] = [];
  let lastTick = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    if (now - lastTick > 1000) record('event loop delayed', { gapMs: Math.round(now - lastTick) });
    lastTick = now;
  }, 100);
  heartbeat.unref();
  let daemon: TestDaemon | undefined;
  const sockets = new Map<Socket, number>();
  const attach = (td: TestDaemon): void => {
    daemon = td;
    const server = (td.daemon as unknown as { server: http.Server }).server;
    record('transport settings', { node: process.version, undici: process.versions['undici'],
      keepAliveTimeout: server.keepAliveTimeout, timeout: server.timeout,
      requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout,
      keepAliveTimeoutBuffer: (server as http.Server & { keepAliveTimeoutBuffer?: number }).keepAliveTimeoutBuffer,
      client: 'global fetch, default dispatcher, api requests Connection: close, no explicit timeout or abort' });
    server.on('connection', (socket) => {
      const id = sockets.size + 1;
      sockets.set(socket, id);
      record('server connection', { id, localPort: socket.localPort, remotePort: socket.remotePort });
      const destroy = socket.destroy.bind(socket);
      socket.destroy = (error) => {
        record('server destroy', { id, error: String(error), stack: new Error().stack });
        return destroy(error);
      };
      socket.on('end', () => record('server end', { id }));
      socket.on('close', (error) => record('server close', { id, error }));
      socket.on('error', (error) => record('server error', { id, error: String(error) }));
    });
    server.prependListener('request', (req, res) => {
      const id = sockets.get(req.socket);
      record('server request', { id, method: req.method, path: req.url?.split('?')[0], connection: req.headers.connection });
      res.on('finish', () => record('server response', { id, status: res.statusCode }));
      res.on('close', () => record('response close', { id, ended: res.writableEnded }));
    });
    for (const name of ['undici:request:create', 'undici:client:sendHeaders', 'undici:request:headers', 'undici:request:error']) {
      const source = channel(name);
      const listener = (message: unknown): void => {
        const data = message as { request?: { origin?: string; path?: string }; socket?: Socket;
          response?: { statusCode: number; headers: Buffer[] }; error?: Error & { code?: string } };
        if (String(data.request?.origin) !== `http://127.0.0.1:${String(td.port)}`) return;
        record(name, { path: data.request?.path?.split('?')[0], localPort: data.socket?.localPort,
          remotePort: data.socket?.remotePort, status: data.response?.statusCode,
          headers: data.response?.headers?.map((header) => String(header)),
          error: data.error === undefined ? undefined : { message: data.error.message, code: data.error.code } });
      };
      source.subscribe(listener);
      subscriptions.push(() => source.unsubscribe(listener));
    }
  };
  return { logger, attach, report: () => {
    const manager = (daemon?.daemon as unknown as { manager?: SessionManager } | undefined)?.manager;
    const sessions = manager?.list().map((summary) => {
      const session = manager.get(summary.id);
      return { ...summary, programEnded: session?.programEnded, killed: session?.isKilled };
    });
    return JSON.stringify({ events, waitsPolling: daemon?.daemon.waitsPolling, sessions }, null, 2);
  }, close: () => { clearInterval(heartbeat); subscriptions.forEach((stop) => stop()); } };
}
