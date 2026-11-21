import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/** Hold a record through a write or takeover, using a native handle on Windows. */
export async function lockRecord(file: string, mode: 'read' | 'truncate' | 'exclusive' = 'read'): Promise<() => Promise<void> | void> {
  if (process.platform === 'win32') {
    const open = mode === 'truncate' ? "'Truncate', 'Write', 'ReadWrite'"
      : mode === 'exclusive' ? "'Open', 'Read', 'None'" : "'Open', 'Read', 'Read'";
    const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open($env:SP_TEST_RECORD, ${open}); [Console]::WriteLine('ready'); [void][Console]::ReadLine(); $f.Dispose()`],
    { windowsHide: true, env: { ...process.env, SP_TEST_RECORD: file }, stdio: 'pipe' });
    const exit = once(reader, 'exit');
    try {
      const ready = await Promise.race([once(reader.stdout, 'data'), exit]);
      if (String(ready[0]).trim() !== 'ready') throw new Error('Could not acquire the record read lock.');
    } catch (error) { reader.kill(); await exit; throw error; }
    return async () => { reader.stdin.end(); await exit; };
  }
  if (mode === 'exclusive') {
    // Obstruct reads and replacements in child processes too. Restore the original inode.
    const backup = file + '.locked';
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    return () => { fs.rmdirSync(file); fs.renameSync(backup, file); };
  }
  if (mode === 'truncate') fs.truncateSync(file);
  // POSIX allows replacing an open file. Inject the same errors at publication.
  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  const remove = fs.rmSync;
  const locked = () => Object.assign(new Error('Record is locked'), { code: 'EBUSY' });
  fs.renameSync = (from, to) => {
    if (String(to) === file) throw locked();
    rename(from, to);
  };
  fs.unlinkSync = target => {
    if (String(target) === file) throw locked();
    unlink(target);
  };
  fs.rmSync = (target, options) => {
    if (String(target) === file) throw locked();
    remove(target, options);
  };
  syncBuiltinESMExports();
  return () => {
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    fs.rmSync = remove;
    syncBuiltinESMExports();
  };
}
