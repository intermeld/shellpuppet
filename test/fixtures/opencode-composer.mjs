import { appendFileSync } from 'node:fs';

const busy = process.argv[3] === 'busy';
let tick = 0;
// An 80-column OpenCode frame. Echo input in gutter rows so the test can
// observe the separate body and submit key received by the PTY.
function paint(input) {
  const rows = input.match(/.{1,72}/gu) ?? [''];
  const progress = '■'.repeat(tick % 9) + '⬝'.repeat(8 - tick % 9);
  const footer = busy ? `   ${progress} esc interrupt` : '  ~/example';
  process.stdout.write(['\x1b[H\x1b[2J' + (busy ? `     Thinking ${tick}` : ''), '  ┃', ...rows.map(row => `  ┃  ${row}`),
    '  ┃', '  ┃  Build · Example Model', '  ╹' + '▀'.repeat(75),
    footer.padEnd(52) + '0.0K (0%)  ctrl+p commands',
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
if (busy) setInterval(() => { tick++; paint(body); }, 110).unref();
