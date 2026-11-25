import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Observe the private browser independently of the page and its CDP connection. */
export function monitorCapture(root: string) {
  // Capture creates the root on first use. A filesystem error from this
  // observer can contain the entire private path.
  const profiles = () => {
    try { return readdirSync(root).filter(name => /^shellpuppet-capture-[a-zA-Z0-9]{6}$/.test(name)); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined; }
  };
  const before = profiles();
  const started = Date.now();
  let lastReplyMs: number | null = null;
  let status = 'awaiting first sample';
  let active: Promise<void> | undefined;
  const sample = async () => {
    const current = profiles();
    if (!before || !current) { status = 'profiles unreadable'; return; }
    const profile = current.find(name => !before.includes(name));
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
      status = error.code === 'ENOENT' ? 'no port file' : error.name === 'TimeoutError' ? 'probe timed out' : 'probe failed';
    }).finally(() => { active = undefined; });
  }, 5_000);
  timer.unref();
  return {
    async stop() { clearInterval(timer); await active; },
    details() {
      const leftovers = profiles();
      let lockedProfiles: number | undefined;
      try {
        lockedProfiles = leftovers?.filter(name => ['SingletonLock', 'lockfile'].some(file =>
          lstatSync(join(root, name, file), { throwIfNoEntry: false }) !== undefined)).length;
      } catch { /* A lock that could not be inspected has no count. */ }
      return { profilesBefore: before?.length, profilesAfterCleanup: leftovers?.length, lockedProfiles, lastReplyMs, status };
    },
  };
}
