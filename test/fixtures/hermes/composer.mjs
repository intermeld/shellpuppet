import { appendFileSync, readFileSync } from 'node:fs';

const [input, state] = process.argv.slice(2);
const busy = state === 'busy';
const longWelcome = state === 'welcome-long';
const postTurn = state === 'post-turn-clipped';
const fixture = busy ? 'busy.ansi' : longWelcome ? 'welcome-long-129.ansi' :
  postTurn ? 'post-turn-clipped-99.ansi' : 'welcome.ansi';
const screen = readFileSync(new URL(fixture, import.meta.url), 'utf8');
const column = busy ? 4 : 2;
const inputRow = postTurn ? 33 : longWelcome ? 23 : 35;
let body = '';

process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  appendFileSync(input, bytes);
  if (bytes.toString() === '\t' || bytes.toString() === '\r') {
    body = '';
    process.stdout.write('\x1b[H' + screen);
    return;
  }
  body += bytes.toString();
  process.stdout.write('\x1b[' + inputRow + ';' + (column + 1) + 'H\x1b[0m\x1b[K' + body);
});
process.stdout.write('\x1b[H' + screen);
