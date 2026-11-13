// Three separate excursions precede each prompt rest. Leave room for PTY
// transport delays; the browser test checks the measured occupancy shares.
process.stdin.setRawMode?.(true);
process.stdin.resume();
const period = Number(process.argv[2] || 200), rows = Number(process.argv[3] || 24);
let interval = null, returns = [], frame = 0;
const move = row => '\x1b[' + (row + 1) + ';1H';
const prompt = () => move(rows - 5) + 'Permission Required' +
  move(rows - 4) + 'Allow this command to run?' + move(rows - 3) + '  ❯ 1. Allow once' +
  move(rows - 2) + '    2. Reject';
process.stdout.write('\x1b[2J' + prompt() + move(0));
const stop = () => { clearInterval(interval); for (const timer of returns) clearTimeout(timer); returns = []; };
const repaint = () => {
  process.stdout.write(move(0) + 'Status ' + (++frame));
  returns = [
    setTimeout(() => process.stdout.write(move(Math.floor(rows / 3)) + 'Panel ' + frame), period / 6),
    setTimeout(() => process.stdout.write(move(Math.floor(rows / 2)) + 'Output ' + frame), period / 3),
    setTimeout(() => process.stdout.write(prompt()), period / 2),
  ];
};
process.stdin.on('data', bytes => {
  for (const key of bytes.toString()) {
    stop();
    if (key === 'r') { repaint(); interval = setInterval(repaint, period); }
    if (key === 'b') process.stdout.write(prompt());
  }
});
