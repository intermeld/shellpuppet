import { appendFileSync } from 'node:fs';

// An 80-column OpenCode frame. Echo input in gutter rows so the test can
// observe the separate body and submit key received by the PTY.
function paint(input) {
  const rows = input.match(/.{1,72}/gu) ?? [''];
  process.stdout.write(['\x1b[H\x1b[2J  ┃', ...rows.map(row => `  ┃  ${row}`),
    '  ┃', '  ┃  Build · Example Model', '  ╹' + '▀'.repeat(75),
    '  ~/example                                           0.0K (0%)  ctrl+p commands',
  ].join('\r\n'));
}

let body = '';
process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  appendFileSync(process.argv[2], bytes);
  body = bytes.toString() === '\r' ? '' : body + bytes.toString();
  paint(body);
});
paint(body);
