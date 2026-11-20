import { appendFileSync } from 'node:fs';

const busy = process.argv[3] === 'busy';
const sidebar = process.argv[3] === 'sidebar';
let tick = 0;
// Echo input in OpenCode gutter rows so the test can
// observe the separate body and submit key received by the PTY.
function paint(input) {
  const end = sidebar ? 156 : 78;
  const rows = input.match(sidebar ? /.{1,149}/gu : /.{1,71}/gu) ?? [''];
  const progress = '■'.repeat(tick % 9) + '⬝'.repeat(8 - tick % 9);
  const footer = busy ? `   ${progress} esc interrupt` : '  ~/example';
  const firstPad = sidebar ? '  ┃'.padEnd(end + 4) + `MCP ${tick}` : '  ┃';
  process.stdout.write(['\x1b[H\x1b[2J' + (busy ? `     Thinking ${tick}` : ''), firstPad, ...rows.map(row => `  ┃  ${row}`),
    '  ┃', '  ┃  Build · Example Model', '  ╹' + '▀'.repeat(end - 3),
    footer.padEnd(end - 26).replace('esc interrupt', '\x1b[38;2;238;238;238mesc \x1b[38;2;128;128;128minterrupt\x1b[0m') +
      '0.0K (0%)  \x1b[38;2;238;238;238mctrl+p \x1b[38;2;128;128;128mcommands\x1b[0m' + (sidebar ? '    ~/project' : ''),
  ].join('\r\n') + `\x1b[${2 + rows.length};${6 + rows.at(-1).length}H`);
}

let body = '';
process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  appendFileSync(process.argv[2], bytes);
  body = bytes.toString() === '\r' ? '' : body + bytes.toString();
  paint(body);
});
paint(body);
if (busy || sidebar) setInterval(() => { tick++; paint(body); }, 110).unref();
