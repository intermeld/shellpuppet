// Test fixture: draws a captured screen holding a permission dialog, and on
// Enter draws a second captured screen, the one the program showed once the
// dialog was answered. Usage: node dialog-sink.mjs <dialog-screen> <answered-screen>
import { readFileSync } from 'node:fs';

const [dialogFile, answeredFile] = process.argv.slice(2);
const screen = (file) => readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n');

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(`\x1b[2J\x1b[H${screen(dialogFile)}`);

process.stdin.on('data', (bytes) => {
  if (!bytes.toString('utf8').includes('\r')) return;
  process.stdout.write(`\x1b[2J\x1b[H${screen(answeredFile)}`);
});
