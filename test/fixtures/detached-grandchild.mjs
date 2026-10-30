// Test fixture: start a grandchild detached from this console, print its pid
// and stay alive. Closing the console does not reach a detached process, so
// only a tree kill (`taskkill /T`) can end the grandchild: a test that sees it
// die knows the tree was walked.
import { spawn } from 'node:child_process';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
grandchild.unref();
process.stdout.write(`grandchild ${String(grandchild.pid)}\r\n`);
setInterval(() => {}, 1000);
