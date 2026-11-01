// A dialog that repaints, changes question, briefly vanishes and finally closes.
process.stdin.setRawMode?.(true);
process.stdin.resume();
let side = 'first sidebar';
const paint = (question = 'Permission required') => {
  process.stdout.write(`\x1b[2J\x1b[H  ┃  △ ${question}\r\n  ┃  $ run the same command                 ${side}\r\n  ┃   Allow once   Reject\r\n`);
};
paint();
process.stdin.on('data', (bytes) => {
  for (const key of bytes.toString('utf8')) {
    if (key === 'r') { side = 'repainted sidebar'; paint(); }
    if (key === 'g') { process.stdout.write('\x1b[2J\x1b[H'); setTimeout(() => paint(), 250); }
    if (key === 'q') {
      process.stdout.write('\x1b[2J\x1b[H A different question?\r\n  ❯ 1. Allow once\r\n    2. Reject\r\n');
    }
    if (key === 'x') process.stdout.write('\x1b[2J\x1b[H Working...\r\n');
  }
});
