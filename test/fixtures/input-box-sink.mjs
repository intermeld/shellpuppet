// Test fixture: an input box drawn the way OpenCode draws its own on a wide
// screen, a `┃` border down its left and a side panel on the same rows to its
// right. Typed text is echoed into the box, wrapped at the box's width and
// never run. With a per-character delay it also draws as OpenCode does: it
// works through what it was given first, so a long line shows up all at once,
// later the longer it is. Usage: node input-box-sink.mjs [msPerChar]
const WIDTH = 40;
const PANEL_COLUMN = 52;
const PANEL = ['Getting started', 'Free models are included', 'so you can start now.', '', 'Connect provider'];
const MS_PER_CHAR = Number(process.argv[2] ?? '0');

let typed = '';
let busyUntil = 0;

function draw() {
  const lines = [];
  for (let at = 0; at < typed.length; at += WIDTH) lines.push(typed.slice(at, at + WIDTH));
  while (lines.length < PANEL.length) lines.push('');
  const rows = lines.map((line, row) => `  ┃  ${line}`.padEnd(PANEL_COLUMN) + (PANEL[row] ?? ''));
  rows.push('  ┃', '  ┃  Build · a model');
  process.stdout.write(`\x1b[2J\x1b[H${rows.join('\r\n')}`);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
draw();
process.stdin.on('data', (bytes) => {
  // eslint-disable-next-line no-control-regex
  const text = bytes.toString('utf8').replace(/[\x00-\x1f\x7f]/g, '');
  busyUntil = Math.max(Date.now(), busyUntil) + text.length * MS_PER_CHAR;
  setTimeout(() => {
    typed += text;
    draw();
  }, busyUntil - Date.now());
});
