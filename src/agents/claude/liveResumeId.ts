import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { LiveResumeIdSource } from '../types.js';
import { windowsLiveMetadata } from '../../core/windowsLiveMetadata.js';

const MAX_METADATA_BYTES = 64 * 1024;

async function posixMetadata(config: string, pid: number, earliestMtime: number, signal: AbortSignal) {
  const directories: FileHandle[] = [];
  let file: FileHandle | undefined;
  try {
    // Linux resolves each child relative to the directory we actually opened.
    // Darwin's O_NOFOLLOW_ANY makes the kernel reject links in the whole path.
    const darwin = process.platform === 'darwin';
    const noLinks = darwin ? 0x20000000 : constants.O_NOFOLLOW;
    let path = darwin ? join(await realpath(dirname(config)), basename(config)) : config;
    for (const next of ['sessions', String(pid) + '.json']) {
      signal.throwIfAborted();
      const dir = await open(path, constants.O_DIRECTORY | noLinks);
      directories.push(dir);
      path = join(darwin ? path : '/proc/self/fd/' + String(dir.fd), next);
    }
    const entry = await lstat(path, { bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n) return;
    signal.throwIfAborted();
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noLinks);
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== entry.dev || stat.ino !== entry.ino ||
      stat.size <= 0n || stat.size > MAX_METADATA_BYTES || stat.mtimeMs < earliestMtime) return;
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await file.read(buffer);
    const end = await file.stat({ bigint: true });
    if (bytesRead !== Number(stat.size) || end.nlink !== 1n || end.ctimeNs !== stat.ctimeNs) return;
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await Promise.all([...directories, ...(file ? [file] : [])].map(handle => handle.close()));
  }
}

export function liveResumeId(env: NodeJS.ProcessEnv, cwd: string): LiveResumeIdSource {
  const windows = process.platform === 'win32';
  const home = (windows ? env['USERPROFILE'] : env['HOME']) || homedir();
  const config = resolve(cwd, env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'));
  if (windows) {
    // A host that cannot start the optional helper can still launch the profile.
    void Promise.resolve().then(windowsLiveMetadata).catch(() => {});
  }
  return {
    matchesProcess(name) {
      const program = windows ? name.toLowerCase().replaceAll('\\', '/') : name;
      return program === 'claude' || (windows && program === 'claude.exe') ||
        /(?:^|\/)@anthropic-ai\/claude-code\/cli\.js$/.test(program);
    },
    async read({ pid, startedAt, latestStart = startedAt }, signal) {
      const raw = windows ? await windowsLiveMetadata().request(['read', Buffer.from(config).toString('base64'),
        String(pid), String(latestStart)], signal) : await posixMetadata(config, pid, latestStart, signal);
      if (!raw || signal.aborted) return;
      const data = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; startTime?: unknown; sessionId?: unknown } | null;
      if (!data || (data.pid !== undefined && data.pid !== pid)) return;
      for (const stamp of [data.startedAt, data.startTime]) {
        if (stamp !== undefined && (typeof stamp === 'string' ? Date.parse(stamp) : stamp) !== startedAt) return;
      }
      return data.sessionId;
    },
  };
}
