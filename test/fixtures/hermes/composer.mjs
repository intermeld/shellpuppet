import { appendFileSync, readFileSync } from 'node:fs';

const [input, state, afterTab] = process.argv.slice(2);
const busy = state === 'busy';
const screen = readFileSync(new URL(busy ? 'busy.ansi' : 'welcome.ansi', import.meta.url), 'utf8');
const submitted = busy && afterTab !== 'plain' ? readFileSync(new URL('queued.ansi', import.meta.url), 'utf8') : screen;
const column = busy ? 4 : 2;
let body = '';

process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  appendFileSync(input, bytes);
  if (bytes.toString() === '\t' || bytes.toString() === '\r') {
    body = '';
    // Erase the longer draft before repainting the shorter input hint.
    process.stdout.write('\x1b[2J\x1b[H' + submitted);
    return;
  }
  body += bytes.toString();
  process.stdout.write('\x1b[35;' + (column + 1) + 'H\x1b[0m\x1b[K' + body);
});
process.stdout.write('\x1b[H' + screen);
