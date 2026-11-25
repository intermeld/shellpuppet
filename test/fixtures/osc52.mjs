// Each input byte selects one synthetic terminal response. The visible marker
// lets the browser wait until xterm has parsed the whole response.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const text = Buffer.from('pane copy ✓').toString('base64');
const other = Buffer.from('unexpected copy').toString('base64');
const payloads = {
  a: 'c;' + text,
  b: ';' + text,
  c: 'c;' + other,
  d: 'c;?',
  e: 'c;YW Jj',
  f: 'c;' + Buffer.alloc(1024 * 1024 + 1, 65).toString('base64'),
  g: 'p;' + other,
};
let count = 0;
process.stdin.on('data', data => {
  for (const command of data) {
    if (command === 'h') {
      process.stdout.write('\x1b[?1000h\x1b[Hselect this line\r\n');
    }
    if (Object.hasOwn(payloads, command)) {
      process.stdout.write('\x1b]52;' + payloads[command] + '\x07');
      process.stdout.write('\r\nparsed-' + ++count + '\r\n');
    }
  }
});
process.stdout.write('fixture ready\r\n');
