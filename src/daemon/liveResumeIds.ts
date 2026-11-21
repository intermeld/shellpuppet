import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { LiveResumeIdSource } from '../agents/types.js';
import { validResumeId } from '../core/types.js';

interface SessionProcess {
  pid: number;
  liveResumeId?: LiveResumeIdSource;
  programEnded: boolean;
}

async function processParents(roots: number[], candidates: number[], signal: AbortSignal): Promise<Map<number, number>> {
  const windows = process.platform === 'win32';
  // Old PID files can outlive the process. Avoid a WMI request for each one.
  if (windows) {
    candidates = candidates.filter(pid => {
      try { process.kill(pid, 0); return true; }
      catch { return false; }
    });
    if (!candidates.length) return new Map();
  }
  const command = windows ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32/cscript.exe') : '/bin/ps';
  const args = windows
    ? ['//nologo', fileURLToPath(new URL('./windowsProcessParents.wsf', import.meta.url)), roots.join(','), candidates.join(',')]
    : ['-A', '-o', 'pid=,ppid='];
  const { stdout } = await promisify(execFile)(command, args, { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
  const parents = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** The closest candidate belongs to the outer agent. Siblings are ambiguous. */
function closest(root: number, candidates: number[], parents: Map<number, number>): number | undefined {
  let distance = Infinity;
  let result: number | undefined;
  for (const candidate of candidates) {
    let pid: number | undefined = candidate;
    const seen = new Set<number>();
    while (pid && !seen.has(pid) && seen.size <= distance) {
      if (pid === root) {
        result = seen.size === distance ? undefined : candidate;
        distance = seen.size;
        break;
      }
      seen.add(pid);
      pid = parents.get(pid);
    }
  }
  return result;
}

/** One deadline for all metadata I/O and at most one ancestry query per record. */
export async function recordLiveResumeIds<T extends SessionProcess>(sessions: T[], parentsFor = processParents,
  budgetMs = 4000): Promise<Map<T, string>> {
  const ids = new Map<T, string>();
  const controller = new AbortController();
  const { signal } = controller;
  const read = async (session: T, pid: number) => {
    if (signal.aborted || session.programEnded) return;
    const id = await session.liveResumeId?.read(pid).catch(() => undefined);
    if (!signal.aborted && !session.programEnded && validResumeId(id)) ids.set(session, id);
  };
  const lookup = async () => {
    const pending = await Promise.all(sessions.map(async session => {
      if (!session.liveResumeId || session.programEnded || session.pid <= 0) return;
      const candidates = await session.liveResumeId.candidatePids(session.pid, signal).catch((): number[] => []);
      if (candidates.includes(session.pid)) await read(session, session.pid);
      else if (candidates.length) return { session, candidates };
    }));
    const wrapped = pending.filter(row => row !== undefined);
    if (!wrapped.length || signal.aborted) return;
    const candidates = [...new Set(wrapped.flatMap(row => row.candidates))];
    if (candidates.length > 2048) return;
    const parents = await parentsFor(wrapped.map(row => row.session.pid), candidates, signal);
    await Promise.all(wrapped.map(async ({ session, candidates }) => {
      const pid = closest(session.pid, candidates, parents);
      if (pid !== undefined) await read(session, pid);
    }));
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, budgetMs);
    });
    await Promise.race([lookup().catch(() => {}), deadline]);
  } finally { clearTimeout(timer); }
  return ids;
}
