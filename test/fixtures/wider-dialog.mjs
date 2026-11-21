// Enter the alternate screen at 80x24 and clip the permission line to the PTY.
const command = 'A'.repeat(96) + ' VISIBLE-ONLY-WHEN-WIDE';
let previous = 0;
function draw() {
  process.stdout._refreshSize?.();
  const columns = process.stdout.columns ?? process.stdout.getWindowSize?.()[0] ?? 80;
  if (previous === 0) {
    if (columns !== 80) return;
    process.stdout.write('\x1b[?1049h\x1b[24;1H' + 'loading\r\n'.repeat(10));
  }
  if (columns === previous) return;
  previous = columns;
  process.stdout.write(`\x1b[2J\x1b[HRun command: ${command.slice(0, Math.max(0, columns - 13))}\x1b[24;1HAllow once?\x1b[12;1H`);
}
draw();
setInterval(draw, 40);
