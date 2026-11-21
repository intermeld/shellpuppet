/** Hold the actual child handle while a Windows wrapper and its launcher exit. */
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { createInterface } from 'node:readline';
import { handoffPipe, WRAPPED_START_ID } from './wrappedStart.js';

const id = process.env[WRAPPED_START_ID];
delete process.env[WRAPPED_START_ID];
const entry = process.argv[2];
if (id && entry) {
  const [proof, permission] = id.split('.');
  const socket = net.createConnection({ path: handoffPipe(id), allowHalfOpen: true });
  let daemon: ChildProcess | undefined;
  function cancel(): void {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    else socket.end();
  }
  socket.once('connect', () => socket.write(proof!));
  socket.on('error', cancel);
  socket.once('end', cancel);
  const control = createInterface({ input: socket });
  control.on('error', cancel);
  control.on('line', (line: string) => {
    if (line === permission && !daemon) {
      daemon = spawn(process.execPath, [entry], { detached: true, windowsHide: true, stdio: 'ignore' });
      daemon.once('spawn', () => process.send?.('started', () => undefined));
      daemon.once('error', () => socket.end());
      daemon.once('exit', () => socket.end());
    } else if (line === 'keep' && daemon) {
      daemon.unref();
      daemon = undefined;
      socket.end();
    } else {
      cancel();
    }
  });
}
