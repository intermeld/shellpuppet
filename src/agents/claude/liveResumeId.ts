import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LiveResumeIdSource } from '../types.js';

const MAX_METADATA_BYTES = 64 * 1024;

export function liveResumeId(env: NodeJS.ProcessEnv, cwd: string): LiveResumeIdSource {
  const home = (process.platform === 'win32' ? env['USERPROFILE'] : env['HOME']) || homedir();
  const directory = resolve(cwd, env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'), 'sessions');
  return {
    async candidatePids(root, signal) {
      if ((await lstat(join(directory, String(root) + '.json')).catch(() => undefined))?.isFile()) return [root];
      const pids: number[] = [];
      for await (const entry of await opendir(directory)) {
        if (signal.aborted) break;
        if (entry.isFile() && /^[1-9]\d{0,9}\.json$/.test(entry.name)) {
          pids.push(Number(entry.name.slice(0, -5)));
        }
      }
      return pids;
    },
    async read(pid) {
      const file = join(directory, String(pid) + '.json');
      const entry = await lstat(file);
      if (!entry.isFile()) return;
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino ||
          !stat.size || stat.size > MAX_METADATA_BYTES) return;
        const buffer = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(buffer);
        if (bytesRead !== stat.size) return;
        const metadata = JSON.parse(buffer.toString('utf8', 0, bytesRead)) as { sessionId?: unknown } | null;
        return metadata?.sessionId;
      } finally { await handle.close(); }
    },
  };
}
