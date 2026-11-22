import * as fs from 'node:fs';

const input = process.argv[2];
const screen = fs.readFileSync(process.argv[3]);
process.stdout.write(screen);
process.stdin.setRawMode?.(true);
process.stdin.resume();
let first = true;
process.stdin.on('data', bytes => {
  fs.appendFileSync(input, bytes);
  if (first) {
    first = false;
    // A status repaint leaves the person's input buffered and unpainted.
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(screen);
  }
});
