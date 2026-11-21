import type { LiveResumeIdSource, LiveResumeProcess } from '../agents/types.js';
import { validResumeId } from '../core/types.js';
import { posixProcesses } from './posixProcesses.js';
import { windowsLiveMetadata } from '../core/windowsLiveMetadata.js';

interface SessionProcess {
  pid: number;
  liveResumeId?: LiveResumeIdSource;
  programEnded: boolean;
}

async function processTree(roots: number[], signal: AbortSignal): Promise<LiveResumeProcess[]> {
  if (process.platform === 'win32') {
    const rows = await windowsLiveMetadata().request(['tree', roots.join(',')], signal);
    return rows.trim().split('\n').flatMap(line => {
      const [pid, parent, startedAt, name, latestStart, instance] = line.split('\t');
      return name && instance ? [{ pid: Number(pid), parent: Number(parent), startedAt: Number(startedAt),
        latestStart: Number(latestStart), instance: BigInt(instance), name: Buffer.from(name, 'base64').toString('utf8') }] : [];
    });
  }
  return posixProcesses(roots, signal);
}

function indexProcesses(processes: LiveResumeProcess[]) {
  const byPid = new Map<number, LiveResumeProcess>();
  const children = new Map<number, LiveResumeProcess[]>();
  for (const p of processes) {
    byPid.set(p.pid, p);
    const siblings = children.get(p.parent);
    if (siblings) siblings.push(p);
    else children.set(p.parent, [p]);
  }
  return { byPid, children };
}

// Traverse one generation at a time, independent of which metadata files exist.
function outerProcess(root: number, source: LiveResumeIdSource, tree: ReturnType<typeof indexProcesses>) {
  const first = tree.byPid.get(root);
  if (!first) return;
  const seen = new Set<number>();
  let generation = [first];
  while (generation.length) {
    const matches = generation.filter(p => source.matchesProcess(p.name));
    if (matches.length) return matches.length === 1 ? matches[0] : undefined;
    for (const p of generation) seen.add(p.pid);
    generation = generation.flatMap(p => tree.children.get(p.pid)?.filter(child =>
      !seen.has(child.pid) && (child.instance ?? child.startedAt) >= (p.instance ?? p.startedAt)) ?? []);
  }
}

/** Both process observations and all file reads share one monotonic deadline. */
export async function recordLiveResumeIds<T extends SessionProcess>(sessions: T[], processesFor = processTree) {
  const active = sessions.filter(s => s.liveResumeId && !s.programEnded && s.pid > 0);
  if (!active.length) return new Map<T, string>();
  const budgetMs = 450;
  const end = performance.now() + budgetMs;
  const controller = new AbortController();
  const { signal } = controller;
  const roots = active.map(s => s.pid);
  const lookup = async () => {
    const before = indexProcesses(await processesFor(roots, signal));
    const results = await Promise.all(active.map(async session => {
      const source = session.liveResumeId!;
      const process = outerProcess(session.pid, source, before);
      if (!process || session.programEnded || signal.aborted) return;
      const id = await source.read(process, signal).catch(() => undefined);
      if (validResumeId(id)) return { session, process, id };
    }));
    const ids = new Map<T, string>();
    if (signal.aborted || !results.some(Boolean)) return ids;
    const after = indexProcesses(await processesFor(roots, signal));
    for (const result of results) {
      if (!result || result.session.programEnded) continue;
      const current = outerProcess(result.session.pid, result.session.liveResumeId!, after);
      if (current?.pid === result.process.pid && current.startedAt === result.process.startedAt &&
          current.instance === result.process.instance) {
        ids.set(result.session, result.id);
      }
    }
    return ids;
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<Map<T, string>>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(new Map()); }, budgetMs);
    });
    const ids = await Promise.race([lookup(), expiry]);
    return performance.now() < end ? ids : new Map<T, string>();
  } catch { return new Map<T, string>(); }
  finally { clearTimeout(timer); }
}
