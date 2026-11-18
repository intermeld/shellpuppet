// Three separate excursions precede each prompt rest. Leave room for PTY
// transport delays; the browser test checks the measured occupancy shares.
import { phaseDriver } from './notice-phase-driver.mjs';
const phases = phaseDriver();
process.stdin.setRawMode?.(true);
process.stdin.resume();
const period = Number(process.argv[2] || 200), rows = Number(process.argv[3] || 24);
let frame = 0;
const move = row => '\x1b[' + (row + 1) + ';1H';
const prompt = () => move(rows - 5) + 'Permission Required' +
  move(rows - 4) + 'Allow this command to run?' + move(rows - 3) + '  ❯ 1. Allow once' +
  move(rows - 2) + '    2. Reject';
process.stdout.write('\x1b[2J' + prompt() + move(0));
const repaint = () => {
  const excursion = Math.min(10, period / 6);
  const panel = Math.floor(rows / 3), output = Math.floor(rows / 2);
  phases.start([[() => move(0) + 'Status ' + (++frame), excursion, 0],
    [move(panel) + 'Panel', excursion, panel], [move(output) + 'Output', excursion, output],
    [prompt(), period - 3 * excursion, rows - 2]]);
};
process.stdin.on('data', bytes => {
  for (const key of phases.read(bytes)) {
    phases.stop();
    if (key === 'r') repaint();
    if (key === 'b') process.stdout.write(prompt());
  }
});
