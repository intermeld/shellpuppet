// A header is revisited within one repaint before the lower prompt rests.
import { phaseDriver } from './notice-phase-driver.mjs';
process.stdin.setRawMode?.(true);
process.stdin.resume();
const rows = Number(process.argv[2] || 24);
const extended = process.argv[3] === 'extended';
const long = process.argv[3] === 'long';
const staged = process.argv[3] === 'staged';
const equal = process.argv[3] === 'equal';
const spinner = process.argv[3] === 'spinner';
const timing = extended ? [160, 450, 480, 930] : [30, 320, 350, 650];
const move = row => '\x1b[' + (row + 1) + ';1H';
const prompt = () => move(rows - 5) + 'Permission Required' +
  move(rows - 4) + 'Allow this command to run?' +
  move(rows - 3) + '  ❯ 1. Allow once' + move(rows - 2) + '    2. Reject';
let interval, returns = [], frame = 0;
const phases = phaseDriver();
const stop = () => { phases.stop(); clearInterval(interval); returns.forEach(clearTimeout); };
const repaint = () => {
  process.stdout.write(move(0) + 'Status ' + (++frame));
  returns = long ? [
    setTimeout(() => process.stdout.write(move(Math.floor(rows / 3)) + 'Panel A ' + frame), 100),
    setTimeout(() => process.stdout.write(move(Math.floor(rows / 2)) + 'Panel B ' + frame), 450),
    setTimeout(() => process.stdout.write(prompt()), 800),
  ] : [
    setTimeout(() => process.stdout.write(move(Math.floor(rows / 2)) + 'Rendering ' + frame), timing[0]),
    setTimeout(() => process.stdout.write(move(0) + 'Status ready ' + frame), timing[1]),
    setTimeout(() => process.stdout.write(prompt()), timing[2]),
  ];
};
// A staged pattern starts with an observable row change, ending preparation.
process.stdout.write('\x1b[2J' + prompt() + (staged || equal || long || spinner ? move(Math.floor(rows / 3)) : ''));
process.stdin.on('data', data => {
  for (const key of phases.read(data)) {
    stop();
    if (key === 'r') {
      if (extended) {
        phases.start([[move(0) + 'Status', 160, 0], [move(Math.floor(rows / 2)) + 'Rendering', 290, Math.floor(rows / 2)],
          [move(0) + 'Status ready', 30, 0], [prompt(), 700, rows - 2]]);
      } else if (equal) {
        phases.start([0, Math.floor(rows / 3), Math.floor(rows / 2), Math.floor(rows * 2 / 3), rows - 2]
          .map(row => [row === rows - 2 ? prompt() : move(row) + 'Panel', 900, row]));
      } else if (staged) {
        // Leave room for PTY delivery below the one-second quiet deadline.
        // The old event-only decision still misses the 2.5-second bound.
        phases.start([[move(0) + 'Status', 300, 0], [move(Math.floor(rows / 3)) + 'Panel A', 650, Math.floor(rows / 3)],
          [move(Math.floor(rows / 2)) + 'Panel B', 650, Math.floor(rows / 2)], [prompt(), 650, rows - 2]]);
      } else if (spinner) {
        let row = 0;
        phases.start([[() => { row = 0; return move(row) + 'Status'; }, 650, 0],
          [() => { row = rows - 2; return prompt(); }, 650, rows - 2]]);
        const draw = () => {
          process.stdout.write('\x1b[' + (row + 1) + ';' + (70 + frame++ % 2) + 'H*');
        };
        draw(); interval = setInterval(draw, 50);
      } else { repaint(); interval = setInterval(repaint, long ? 1300 : timing[3]); }
    }
    if (key === 'b') process.stdout.write(prompt());
    if (key === 'q') process.exit(0);
  }
});
