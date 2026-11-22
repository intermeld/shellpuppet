import { constants, watch, type FSWatcher } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { validResumeId } from '../../core/types.js';

const MAX_METADATA_BYTES = 64 * 1024;
const POLL_MS = 30_000;

/** Claude Code's direct child knows its parent's PID without inspecting processes. */
export function claudeSessionFile(env: NodeJS.ProcessEnv, cwd: string, parentPid = process.ppid): string {
  const home = (process.platform === 'win32' ? env['USERPROFILE'] : env['HOME']) || homedir();
  return join(resolve(cwd, env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')), 'sessions', `${String(parentPid)}.json`);
}

/** Read only sessionId from one bounded, ordinary Claude session file. */
export async function readClaudeResumeId(file: string): Promise<string | undefined> {
  try {
    const sessions = resolve(file, '..');
    const config = resolve(sessions, '..');
    for (const directory of [config, sessions]) {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    }
    const entry = await lstat(file, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n ||
        entry.size <= 0n || entry.size > BigInt(MAX_METADATA_BYTES)) return;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.dev !== entry.dev || before.ino !== entry.ino ||
          before.size !== entry.size || before.ctimeNs !== entry.ctimeNs) return;
      const buffer = Buffer.alloc(Number(before.size) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat({ bigint: true });
      if (bytesRead !== Number(before.size) || after.size !== before.size ||
          after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) return;
      const data: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
      const id = (data as Record<string, unknown>)['sessionId'];
      return validResumeId(id) ? id : undefined;
    } finally { await handle.close(); }
  } catch { return; }
}

/** Report each changed valid id once; the poll also recovers a replaced or missing file. */
export function watchClaudeResumeId(file: string, report: (id: string) => Promise<void>, pollMs = POLL_MS): () => void {
  let watcher: FSWatcher | undefined;
  let closed = false;
  let checking = false;
  let pending = false;
  let reported: string | undefined;
  const attach = () => {
    watcher?.close();
    watcher = undefined;
    try {
      watcher = watch(file, () => { void check(); });
      watcher.on('error', () => { watcher?.close(); watcher = undefined; });
      watcher.unref();
    } catch { /* A missing file is retried by the poll. */ }
  };
  const check = async () => {
    if (closed) return;
    if (checking) { pending = true; return; }
    checking = true;
    try {
      do {
        pending = false;
        const id = await readClaudeResumeId(file);
        if (id !== undefined && id !== reported) {
          try { await report(id); reported = id; } catch { /* Retry at the next observation. */ }
        }
      } while (pending && !closed);
    } finally { checking = false; }
  };
  attach();
  void check();
  const timer = setInterval(() => { attach(); void check(); }, pollMs);
  timer.unref();
  return () => { closed = true; clearInterval(timer); watcher?.close(); };
}
