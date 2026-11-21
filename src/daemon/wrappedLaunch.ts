/** A Windows wrapper can give its immediate child a console. Only this short
 * launcher runs in it. The daemon inherits the wrapper's resolved environment. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRAPPED_START_ID } from './wrappedStart.js';
import { childEnv } from '../core/environment.js';

export function launchWrappedDaemon(launcher: string, home: string, id: string, entry: string): void {
  // A wrapper can still have its input file open. The client retries removal
  // after closing the pipe, when this attempt's proof has expired.
  try { rmSync(launcher, { force: true }); } catch { /* retry on the client */ }
  const suppliedHome = process.env['SHELLPUPPET_HOME'];
  const filtered = process.env[WRAPPED_START_ID] !== id || !suppliedHome || relative(home, suppliedHome) !== '';
  // A wrapper may import the script with its own arguments still in argv.
  const override = process.argv[2] === '--daemon-entry' ? process.argv[3] : undefined;
  const supervisor = fileURLToPath(new URL('./wrappedSupervisor.js', import.meta.url));
  const child = spawn(process.execPath, [supervisor, override ?? entry, filtered ? 'filtered' : 'inherited'], {
    env: childEnv(process.platform, process.env, { [WRAPPED_START_ID]: id, SHELLPUPPET_HOME: home }),
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const failed = () => { process.exitCode = 1; };
  child.once('error', failed);
  child.once('exit', failed);
  function started(message: unknown): void {
    if (message !== 'started') return;
    child.off('message', started);
    child.off('exit', failed);
    child.disconnect();
    child.unref();
  }
  child.on('message', started);
}
