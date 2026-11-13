process.stdin.setRawMode?.(true);
process.stdin.resume();
const rows = Number(process.argv[2] || 24);
const bottom = rows - 2;
const middle = Math.floor(rows / 3);
const word = [[0, 850], [bottom, 450], [0, 850], [bottom, 450], [rows - 1, 900], [bottom, 900], [rows - 1, 100], [0, 400],
  ...Array.from({ length: 5 }, (_, i) => [middle + i, 820])];
const longWord = [[0, 900], [1, 900], [2, 900], ...Array.from({ length: 8 }, (_, i) => [middle + i, 800]),
  ...Array.from({ length: 6 }, (_, i) => [i % 2 ? rows - 1 : bottom, 900])];
const cadence = process.argv[3] === 'long' ? longWord : word;
const changedWord = [[0, 250], [bottom, 850], [0, 250], [bottom, 850], [rows - 1, 900], [bottom, 900],
  [rows - 1, 100], [0, 200], ...Array.from({ length: 5 }, (_, i) => [middle + i, 820])];
const move = row => '\x1b[' + (row + 1) + ';1H';
const prompt = () => move(rows - 5) + 'Permission Required' + move(rows - 4) + 'Allow this command to run?' +
  move(rows - 3) + '  ❯ 1. Allow once' + move(rows - 2) + '    2. Reject';
let timer, index = 0;
process.stdout.write('\x1b[2J' + prompt() + move(bottom));
const step = () => {
  if (process.argv[3] === 'rest' && index === word.length * 2) {
    index = word.length * 3;
    process.stdout.write(prompt() + move(bottom));
    timer = setTimeout(step, 1500);
    return;
  }
  const active = process.argv[3] === 'change' && index >= word.length ? changedWord : cadence;
  const [row, duration] = active[index++ % active.length];
  process.stdout.write(row >= bottom ? prompt() + move(row) : move(row) + 'Panel ' + index);
  timer = setTimeout(step, duration);
};
process.stdin.on('data', data => {
  for (const key of data.toString()) {
    if (key === 'r') { clearTimeout(timer); index = 0; step(); }
    if (key === 'q') process.exit(0);
  }
});
