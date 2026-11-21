/** Hold the actual child handle while a Windows wrapper and its launcher exit. */
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { createInterface } from 'node:readline';
import { handoffPipe, WRAPPED_START_ID, WRAPPED_START_IPC } from './wrappedStart.js';

const id = process.env[WRAPPED_START_ID];
delete process.env[WRAPPED_START_ID];
const entry = process.argv[2];
if (id && entry) {
  const [proof, permission] = id.split('.');
  const socket = net.createConnection({ path: handoffPipe(id), allowHalfOpen: true });
  let daemon: ChildProcess | undefined;
  let cancelled = false;
  function cancel(): void {
    cancelled = true;
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    else if (!socket.writableEnded) socket.end();
  }
  socket.once('connect', () => socket.write(Buffer.concat([
    Buffer.from(proof!), Buffer.from([process.argv[3] === 'filtered' ? 1 : 0]),
  ])));
  socket.on('error', cancel);
  socket.once('end', cancel);
  const control = createInterface({ input: socket });
  control.on('error', cancel);
  control.on('line', (line: string) => {
    if (line === permission && !daemon && !cancelled) {
      process.env[WRAPPED_START_IPC] = '1';
      daemon = spawn(process.execPath, [entry], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      daemon.once('spawn', () => process.send?.('started', () => undefined));
      daemon.once('error', () => socket.end());
      daemon.once('exit', () => socket.end());
      const pending = daemon;
      function published(message: unknown): void {
        if (message !== 'published' || cancelled) return;
        pending.off('message', published);
        // Drop cancellation authority before this daemon may serve its first
        // request. The client can disappear at either side of this decision.
        daemon = undefined;
        pending.send('serve', () => { if (pending.connected) pending.disconnect(); });
        pending.unref();
        socket.end(Buffer.from([1]));
      }
      pending.on('message', published);
    } else {
      cancel();
    }
  });
}
