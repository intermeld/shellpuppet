// A permission line clipped by the program itself at the current PTY width.
const command = 'A'.repeat(96) + ' VISIBLE-ONLY-WHEN-WIDE';
let previous = 0;
function draw() {
  process.stdout._refreshSize?.();
  const columns = process.stdout.columns ?? process.stdout.getWindowSize?.()[0] ?? 80;
  if (columns === previous) return;
  previous = columns;
  process.stdout.write(`\x1b[2J\x1b[HRun command: ${command.slice(0, Math.max(0, columns - 13))}\r\n`);
}
draw();
setInterval(draw, 40);
