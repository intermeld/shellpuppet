import { readFileSync } from 'node:fs';

const screen = readFileSync(new URL('./stalls/mimo-refusal.ansi', import.meta.url), 'utf8')
  .replace('Summarise the sample.', 'Explain the ✗ Error message shown by the sample.');
process.stdout.write(screen);
process.stdout.on('resize', () => {
  const first = screen.indexOf('\r\n');
  process.stdout.write(screen.slice(0, first));
  setTimeout(() => process.stdout.write(screen.slice(first)), 35);
});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => { if (data.toString().includes('q')) process.exit(0); });
