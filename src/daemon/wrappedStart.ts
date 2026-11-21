import { createHash, randomUUID } from 'node:crypto';
import * as net from 'node:net';

export const WRAPPED_START_ID = 'SHELLPUPPET_DAEMON_START_ID';

export function handoffPipe(id: string): string {
  // Named pipes are enumerable. Keep the per-start proof out of their names.
  return '\\\\.\\pipe\\shellpuppet-handoff-' + createHash('sha256').update(id).digest('hex');
}

/** Only the helper for this launch may start a process under this claim. */
export async function openWrappedStart() {
  const proof = randomUUID();
  const permission = randomUUID();
  const id = `${proof}.${permission}`;
  let helper: net.Socket | undefined;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.on('readable', () => {
      const received = socket.read(proof.length) as Buffer | null;
      if (received === null) return;
      if (helper !== undefined || received.toString() !== proof) { socket.destroy(); return; }
      helper = socket;
      socket.write(permission + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(handoffPipe(id), resolve);
  });
  return {
    id,
    get launched() { return helper !== undefined && !helper.destroyed; },
    async finish(healthy: boolean, cleanupMs: number): Promise<void> {
      // Stop new admissions first. A helper delayed until after cancellation
      // cannot start a daemon. The admitted helper closes after releasing or
      // reaping its own child.
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) {
        if (socket !== helper) socket.destroy();
      }
      helper?.end(healthy ? 'keep\n' : 'cancel\n');
      const timer = setTimeout(() => helper?.destroy(), cleanupMs);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}
