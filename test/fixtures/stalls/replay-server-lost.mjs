import { readFileSync } from 'node:fs';

const rows = Array.from({ length: 24 }, () => '');
rows[11] = '  ┃  △ Permission required';
rows[13] = '  ┃  $ example command';
rows[20] = '  ┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter confirm';
const prompt = '\x1b[2J\x1b[H' + rows.join('\r\n');
const banner = readFileSync(new URL('./server-lost-over-permission.ansi', import.meta.url), 'utf8');
process.stdout.write(prompt);
let started = false;
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', () => {
  if (started) { process.exit(0); return; }
  started = true;
  process.stdout.write(banner);
  setTimeout(() => process.stdout.write(prompt), 5000);
});
