/**
 * Hold publication rights independently of daemon.json. The listening daemon
 * keeps this non-empty directory until its last record write. A contender
 * can therefore distinguish a missing discovery file from an unowned home.
 */
import { existsSync, mkdirSync, opendirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { VerifiedHome } from './paths.js';
import { processExists } from './liveness.js';

export class AlreadyRunningError extends Error {
  constructor(readonly state: { pid: number; port: number }) {
    super(`A daemon is already running (pid ${String(state.pid)}, port ${String(state.port)}).`);
    this.name = 'AlreadyRunningError';
  }
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function removeEmpty(directory: string): void {
  try { rmdirSync(directory); }
  catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(error) ?? '')) throw error;
  }
}

/** Remove only the observed owner's marker. A new owner's directory is
 * always published non-empty, so a late rmdir cannot retire its lease. */
function retire(directory: string, marker: string): void {
  try { unlinkSync(join(directory, marker)); }
  catch (error) { if (codeOf(error) !== 'ENOENT') throw error; }
  removeEmpty(directory);
}

/** An unrelated process can inherit a dead owner's pid. Binding its old
 * port proves the listening owner is gone even when that pid exists. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer(socket => socket.destroy());
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

export interface HomeOwner {
  held: () => boolean;
  release: () => void;
}

export async function acquireHomeOwner(home: VerifiedHome, port: number, instanceId: string): Promise<HomeOwner> {
  const base = home.verifiedHome();
  const directory = join(base, 'daemon-owner');
  const staging = join(base, 'daemon-owner.' + instanceId);
  const marker = [process.pid, port, instanceId].join('.');
  mkdirSync(staging, { mode: 0o700 });
  try {
    writeFileSync(join(staging, marker), '', { flag: 'wx', mode: 0o600 });
    for (;;) {
      home.verifiedHome();
      try {
        renameSync(staging, directory);
        return {
          held: () => {
            try {
              home.verifiedHome();
              const held = existsSync(join(directory, marker));
              home.verifiedHome();
              return held;
            } catch { return false; }
          },
          release: () => { home.verifiedHome(); retire(directory, marker); },
        };
      } catch (error) {
        // On Windows rename can return EPERM when the target already exists.
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(codeOf(error) ?? '')) throw error;
        home.verifiedHome();
        const markers: string[] = [];
        try {
          const dir = opendirSync(directory);
          try {
            home.verifiedHome();
            for (let entry = dir.readSync(); entry; entry = dir.readSync()) markers.push(entry.name);
          } finally { dir.closeSync(); }
        } catch (readError) {
          if (codeOf(readError) === 'ENOENT' && codeOf(error) !== 'EACCES') {
            // Avoid looping if rename itself was denied, independent of a contender.
            if (codeOf(error) === 'EPERM') throw error;
            continue;
          }
          throw readError;
        }
        home.verifiedHome();
        const incumbent = markers[0];
        if (incumbent === undefined) {
          // Another process may have died between unlink and rmdir.
          removeEmpty(directory);
          continue;
        }
        const fields = /^(\d+)\.(\d+)\.([a-f0-9-]{36})$/.exec(incumbent);
        if (markers.length !== 1 || !fields) throw new Error('Unrecognised daemon-owner record.', { cause: error });
        const oldPort = Number(fields[2]);
        // Our own successful bind may already prove this old port was free.
        const live = port !== oldPort && processExists(Number(fields[1])) && !(await portIsFree(oldPort));
        home.verifiedHome();
        if (live) {
          throw new AlreadyRunningError({ pid: Number(fields[1]), port: oldPort });
        }
        retire(directory, incumbent);
      }
    }
  } finally {
    // On success the staging directory was renamed.
    home.verifiedHome();
    retire(staging, marker);
  }
}
