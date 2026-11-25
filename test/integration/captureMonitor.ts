import { lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Observe the private browser independently of the page and its CDP connection. */
export function monitorCapture(root: string) {
  mkdirSync(root, { recursive: true });
  const profiles = () => readdirSync(root).filter(name => /^shellpuppet-capture-[a-zA-Z0-9]{6}$/.test(name));
  const before = profiles();
  const started = Date.now();
  let lastReplyMs: number | null = null;
  let status = 'awaiting first sample';
  let active: Promise<void> | undefined;
  const sample = async () => {
    const profile = profiles().find(name => !before.includes(name));
    if (!profile) { status = 'no new profile'; return; }
    const [port, target] = readFileSync(join(root, profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    if (!port || !/^\d{1,5}$/.test(port) || !target?.startsWith('/devtools/browser/')) {
      status = 'incomplete port file';
      return;
    }
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000),
      redirect: 'error' });
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    if (version.webSocketDebuggerUrl && new URL(version.webSocketDebuggerUrl).pathname === target) {
      lastReplyMs = Date.now() - started;
      status = 'browser answered';
    } else status = 'different browser endpoint';
  };
  const timer = setInterval(() => {
    active ??= sample().catch((error: NodeJS.ErrnoException) => {
      status = error.code === 'ENOENT' ? 'no port file' : error.code ?? error.name;
    }).finally(() => { active = undefined; });
  }, 5_000);
  timer.unref();
  return {
    async stop() { clearInterval(timer); await active; },
    details() {
      const leftovers = profiles().map(name => ({ name, lockFile: ['SingletonLock', 'lockfile'].some(file =>
        lstatSync(join(root, name, file), { throwIfNoEntry: false }) !== undefined) }));
      return { profilesBefore: before, profilesAfterCleanup: leftovers, lastReplyMs, status };
    },
  };
}
