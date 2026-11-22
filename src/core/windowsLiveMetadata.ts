import type { LiveResumeProcess, ProcessImage } from '../agents/types.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

// Windows PowerShell loads the inbox .NET APIs while a Claude profile is running.
// Pipe EOF also ends the helper if the daemon exits without an orderly stop.
function startHelper() {
  const script = "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:SP_METADATA_SOURCE)); [LiveMetadata]::Run()";
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, SP_METADATA_SOURCE: fileURLToPath(new URL('./windowsLiveMetadata.cs', import.meta.url)) },
  });
  child.unref();
  (child.stdin as Socket).unref();
  (child.stdout as Socket).unref();
  const pending = new Map<number, (value: string) => void>();
  let serial = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const tab = line.indexOf('\t');
    const id = Number(line.slice(0, tab));
    pending.get(id)?.(Buffer.from(line.slice(tab + 1), 'base64').toString('utf8'));
    pending.delete(id);
  });
  const ended = () => {
    if (helper === instance) helper = undefined;
    for (const finish of pending.values()) finish('');
    pending.clear();
  };
  child.once('error', ended);
  child.once('exit', ended);
  child.stdin.on('error', ended);
  const instance = {
    request(fields: string[], signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const id = ++serial;
      const abort = () => { child.kill(); ended(); };
      return new Promise(resolve => {
        signal.addEventListener('abort', abort, { once: true });
        pending.set(id, value => { signal.removeEventListener('abort', abort); resolve(value); });
        child.stdin.write([String(id), ...fields].join('\t') + '\n');
      });
    },
  };
  return instance;
}

let helper: ReturnType<typeof startHelper> | undefined;

export function windowsLiveMetadata() {
  return helper ??= startHelper();
}

export async function windowsImages(signal: AbortSignal): Promise<ProcessImage[]> {
  const rows = await windowsLiveMetadata().request(['images'], signal);
  return rows.trim().split('\n').flatMap(line => {
    const [pid, parent, image] = line.split('\t');
    return image ? [{ pid: Number(pid), parent: Number(parent), name: Buffer.from(image, 'base64').toString('utf8') }] : [];
  });
}

export async function windowsBirths(images: ProcessImage[], signal: AbortSignal): Promise<LiveResumeProcess[]> {
  const rows = await windowsLiveMetadata().request(['births', images.map(p => p.pid).join(',')], signal);
  const byPid = new Map(images.map(row => [row.pid, row]));
  return rows.trim().split('\n').flatMap(line => {
    const [pid, ticks, name] = line.split('\t');
    const row = byPid.get(Number(pid));
    if (!row || !name || !ticks) return [];
    const stem = Buffer.from(name, 'base64').toString('utf8').toLowerCase();
    const image = row.name.toLowerCase();
    if (image !== stem && image !== stem + '.exe') return [];
    const instance = BigInt(ticks);
    return [{ ...row, startedAt: Number(instance / 10000n), instance }];
  });
}
