/** A Windows wrapper can give its immediate child a console. Only this short
 * launcher runs in it. The daemon inherits the wrapper's resolved environment. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A wrapper may import the start script with its own arguments still in argv.
const override = process.argv[2] === '--daemon-entry' ? process.argv[3] : undefined;
const entry = override ?? fileURLToPath(new URL('./index.js', import.meta.url));
const daemon = spawn(process.execPath, [entry], { detached: true, windowsHide: true, stdio: 'ignore' });
daemon.once('error', () => { process.exitCode = 1; });
daemon.once('spawn', () => daemon.unref());
