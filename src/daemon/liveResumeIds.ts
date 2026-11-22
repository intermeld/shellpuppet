import type { LiveResumeIdSource, LiveResumeProcess, ProcessImage } from '../agents/types.js';
import { validResumeId } from '../core/types.js';
import { posixBirths, posixImages } from './posixProcesses.js';
import { windowsBirths, windowsImages } from '../core/windowsLiveMetadata.js';

interface SessionProcess {
  pid: number;
  liveResumeId?: LiveResumeIdSource;
  programEnded: boolean;
}

function indexProcesses(processes: ProcessImage[]) {
  const byPid = new Map<number, ProcessImage>();
  const children = new Map<number, ProcessImage[]>();
  for (const p of processes) {
    byPid.set(p.pid, p);
    const siblings = children.get(p.parent);
    if (siblings) siblings.push(p);
    else children.set(p.parent, [p]);
  }
  return { byPid, children };
}

// Root at depth zero. Stop the whole search at the first matching generation.
function launcherChain(root: number, source: LiveResumeIdSource, tree: ReturnType<typeof indexProcesses>) {
  const first = tree.byPid.get(root);
  let paths = first ? [[first]] : [];
  for (let depth = 0; paths.length; depth++) {
    const matches = paths.filter(path => source.matchesProcess(path.at(-1)!.name));
    if (matches.length) return matches.length === 1 ? matches[0]! : [];
    if (depth === 3) break;
    paths = paths.flatMap(path => (tree.children.get(path.at(-1)!.pid) ?? [])
      .filter(child => !path.includes(child)).map(child => [...path, child]));
  }
  return [];
}

function verifiedLeaf(path: ProcessImage[], processes: Map<number, LiveResumeProcess>) {
  let parent: LiveResumeProcess | undefined;
  for (const image of path) {
    const p = processes.get(image.pid);
    if (!p || !(p.startedAt > 0)) return;
    if (parent && (p.instance ?? p.startedAt) < (parent.instance ?? parent.startedAt)) return;
    parent = p;
  }
  return parent;
}

const windows = process.platform === 'win32';

/** Both process observations and all file reads share one monotonic deadline. */
export async function recordLiveResumeIds<T extends SessionProcess>(sessions: T[],
  listImages = windows ? windowsImages : posixImages, readBirths = windows ? windowsBirths : posixBirths) {
  const active = sessions.filter(s => s.liveResumeId && !s.programEnded && s.pid > 0);
  if (!active.length) return new Map<T, string>();
  const budgetMs = 450;
  const end = performance.now() + budgetMs;
  const controller = new AbortController();
  const { signal } = controller;
  const observe = async () => {
    const tree = indexProcesses(await listImages(signal));
    const paths = active.map(s => launcherChain(s.pid, s.liveResumeId!, tree));
    const images = [...new Set(paths.flat())];
    const candidates = new Map<T, LiveResumeProcess>();
    if (!images.length || signal.aborted) return candidates;
    const verified = new Map((await readBirths(images, signal)).map(p => [p.pid, p]));
    for (const [i, path] of paths.entries()) {
      const process = verifiedLeaf(path, verified);
      if (process) candidates.set(active[i]!, process);
    }
    return candidates;
  };
  const lookup = async () => {
    const before = await observe();
    const results = await Promise.all([...before].map(async ([session, process]) => {
      if (session.programEnded || signal.aborted) return;
      const id = await session.liveResumeId!.read(process, signal).catch(() => undefined);
      if (validResumeId(id)) return { session, process, id };
    }));
    const ids = new Map<T, string>();
    if (signal.aborted || !results.some(Boolean)) return ids;
    const after = await observe();
    for (const result of results) {
      if (!result || result.session.programEnded) continue;
      const current = after.get(result.session);
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
