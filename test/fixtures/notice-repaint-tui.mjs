// A synthetic permission prompt can repaint, move to either edge or be replaced.
process.stdin.setRawMode?.(true);
process.stdin.resume();
const rows = Number(process.argv[2] ?? 24);
let lower = false;
let question = 'Allow this command to run?';
function draw() {
  const start = lower ? rows - 3 : 1;
  const lines = ['Permission Required', question, '  ❯ 1. Allow once', '    2. Reject'];
  const at = row => '\x1b[' + row + ';1H';
  process.stdout.write('\x1b[2J' + lines.map((line, i) => at(start + i) + line).join('') + at(lower ? rows : 1) + (lower ? ' ' : 'P'));
}
// A pointer event leaking through the heading would produce a terminal mouse report.
process.stdout.write('\x1b[?1000h\x1b[?1006h');
draw();
process.stdin.on('data', data => {
  for (const key of data.toString()) {
    if (key === 'q') process.exit(0);
    if (key === 'c') process.stdout.write('\x1b[2J\x1b[HReady');
    if (key === 't' || key === 'b' || key === 'n') {
      lower = key === 'b';
      if (key === 'n') question = 'Replace this file?';
      draw();
    }
  }
});
