import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Logger } from '../core/types.js';

export const WRAPPED_START_ID = 'SHELLPUPPET_DAEMON_START_ID';
export const WRAPPED_START_IPC = 'SHELLPUPPET_DAEMON_START_IPC';

/** Called by the published daemon while its listener still refuses connections. */
export function releaseWrappedDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const disconnected = () => reject(new Error('Windows start helper disconnected before releasing the daemon.'));
    if (!process.connected || !process.send) { disconnected(); return; }
    process.once('disconnect', disconnected);
    process.once('message', message => {
      process.off('disconnect', disconnected);
      if (message === 'serve') resolve();
      else reject(new Error('Unexpected Windows start helper response.'));
    });
    process.send('published', error => { if (error) reject(error); });
  });
}

export function handoffPipe(id: string): string {
  // Named pipes are enumerable. Keep the per-start proof out of their names.
  return '\\\\.\\pipe\\shellpuppet-handoff-' + createHash('sha256').update(id).digest('hex');
}

/** Only the helper for this launch may start a process under this claim. */
export async function openWrappedStart(home: string, entry: string, logger: Logger) {
  const proof = randomUUID();
  const permission = randomUUID();
  const id = `${proof}.${permission}`;
  let helper: net.Socket | undefined;
  let published = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const authenticate = (): void => {
      const received = socket.read(proof.length + 1) as Buffer | null;
      if (received === null) return;
      if (helper !== undefined || received.toString('utf8', 0, proof.length) !== proof) { socket.destroy(); return; }
      helper = socket;
      if (received.at(-1) === 1) logger.warn('daemon.startWith wrapper filtered the startup environment. Using the private launch record.');
      socket.off('readable', authenticate);
      socket.once('data', bytes => { published = bytes[0] === 1; });
      socket.write(permission + '\n');
    };
    socket.on('readable', authenticate);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(handoffPipe(id), resolve);
  });
  // Wrappers receive the same two trailing arguments even when they rebuild
  // their environment or import the script. The private script carries a
  // fallback proof without putting it in argv or reusing a later attempt.
  const launcher = path.resolve(home, 'daemon-start-' + randomUUID() + '.mjs');
  try {
    const module = new URL('./wrappedLaunch.js', import.meta.url).href;
    fs.writeFileSync(launcher, `import { launchWrappedDaemon } from ${JSON.stringify(module)};\n` +
      `launchWrappedDaemon(import.meta.filename, ${JSON.stringify(id)}, ${JSON.stringify(entry)});\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) { server.close(); throw error; }
  return {
    id,
    launcher,
    get launched() { return helper !== undefined && (!helper.destroyed || published); },
    async finish(cleanupMs: number): Promise<boolean> {
      // Stop new admissions first. A helper delayed until after cancellation
      // cannot start a daemon. The admitted helper closes after releasing or
      // reaping its own child.
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) {
        if (socket !== helper) socket.destroy();
      }
      if (helper && !helper.destroyed) helper.end('cancel\n');
      const timer = setTimeout(() => helper?.destroy(), cleanupMs);
      try { await closed; } finally {
        clearTimeout(timer);
        try { fs.rmSync(launcher, { force: true }); }
        catch { logger.warn('Could not remove the expired private Windows daemon launcher.'); }
      }
      return published;
    },
  };
}
