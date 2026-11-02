// Test fixture: draws a captured screen holding a permission dialog, and on
// Enter draws a second captured screen, the one the program showed once the
// dialog was answered. Usage: node dialog-sink.mjs <dialog-screen> <answered-screen>
// [paint-delay-ms] [exit-after-ms].
import { readFileSync } from 'node:fs';

const [dialogFile, answeredFile, delay, exitAfter] = process.argv.slice(2);
const screen = (file) => readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n');

process.stdin.setRawMode?.(true);
process.stdin.resume();
setTimeout(() => process.stdout.write(`\x1b[2J\x1b[H${screen(dialogFile)}`), Number(delay ?? 0));
if (exitAfter !== undefined) setTimeout(() => process.exit(0), Number(exitAfter));

process.stdin.on('data', (bytes) => {
  if (!bytes.toString('utf8').includes('\r')) return;
  process.stdout.write(`\x1b[2J\x1b[H${screen(answeredFile)}`);
});
