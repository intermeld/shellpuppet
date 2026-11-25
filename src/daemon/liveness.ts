/**
 * Whether a recorded daemon is still running, as opposed to whether it
 * answers (design §2.3). Under load a daemon can take seconds to answer
 * `/health`, and its state file must never be cleared, nor a second daemon
 * started, on that account: the first daemon would keep running with every
 * session in it, and no new client could reach it again.
 *
 * Running means both:
 * - its process exists, which a signal-0 probe tells; and
 * - its port accepts a TCP connection. The operating system completes the
 *   handshake from the listening socket's accept queue even while the
 *   daemon's event loop is busy, and refuses it at once when nothing listens.
 *
 * Together they guard against a reused pid after a crash or a reboot: an
 * unrelated process may then own the recorded pid, but not also listen on the
 * recorded port. They also read a stopping daemon as gone, since it stops
 * listening before it ends its sessions.
 *
 * The limit is the accept queue, which is finite. A daemon stuck for so long
 * that its queue fills (232 waiting connections on Windows with Node 22, as
 * measured) refuses further connections, as if it had gone, and is then taken
 * for gone.
 */

import * as net from 'node:net';
import { readFileSync } from 'node:fs';

/** Linux start tick is field 22; state is field 3 after the final command bracket. */
export function linuxProcessIdentity(stat: string): { state: string; startTick: string } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTick = fields[19];
  return state !== undefined && /^[A-Z]$/.test(state) && startTick !== undefined && /^\d+$/.test(startTick)
    ? { state, startTick } : null;
}

export function readLinuxProcessIdentity(pid: number): { state: string; startTick: string } | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try { return linuxProcessIdentity(readFileSync(`/proc/${String(pid)}/stat`, 'utf8')); }
  catch { return null; }
}

/** Only observations that prove the original PID has ended count as exit. */
export function observedProcessExit(pid: number, originalTick: string | null): boolean {
  if (process.platform === 'linux') {
    const current = readLinuxProcessIdentity(pid);
    if (current !== null) {
      return current.state === 'Z' || current.state === 'X' ||
        (originalTick !== null && current.startTick !== originalTick);
    }
  }
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** A refusal arrives within milliseconds; this only bounds a probe that hangs. */
const PORT_PROBE_TIMEOUT_MS = 5_000;

/** Whether a process with this pid exists. */
export function processExists(pid: number): boolean {
  // Signal 0 to pid 0 or a negative pid addresses a process group, not one
  // process.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether something accepts a TCP connection on this loopback port. A probe
 * that is neither accepted nor refused within the bound counts as accepted:
 * something is there, and taking a daemon for gone is the mistake to avoid.
 */
export function portAccepts(port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('error', () => {
      settle(false);
    });
    socket.setTimeout(timeoutMs, () => {
      settle(true);
    });
  });
}

/** Whether the daemon a state record names is still running. */
export async function daemonRunning(record: { pid: number; port: number }, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return processExists(record.pid) && (await portAccepts(record.port, timeoutMs));
}
