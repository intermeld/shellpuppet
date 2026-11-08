// Neutral long prompt with the evidenced MiMo refusal and native reflow.
import { readFileSync } from 'node:fs';
const screen = readFileSync(new URL('./stalls/mimo-refusal.ansi', import.meta.url), 'utf8')
  .replace('Summarise the sample.', 'Neutral sample text '.repeat(670) + (process.argv.includes('--colon') ? ':' : ''));
process.stdout.write(screen);
process.stdout.on('resize', () => {
  if (process.stdout.columns >= 120) {
    process.stdout.write(screen.replace('╹' + '▀'.repeat(20), '╹' + '▀'.repeat(process.stdout.columns - 5)));
  } else {
    process.stdout.write(`\x1b[${process.stdout.rows - 1};1H  \x1b[38;2;255;128;64m╹` +
      '▀'.repeat(process.stdout.columns - 5) + '\x1b[0m\x1b[K');
  }
});
let suggested = false;
setInterval(() => {
  if (process.stdout.columns >= 120) return;
  suggested = !suggested;
  process.stdout.write(`\x1b[${process.stdout.rows - 3};1H  \x1b[38;2;255;128;64m┃\x1b[0m` +
    (suggested ? '  \x1b[38;2;128;128;128mReview the sample. (Tab to accept)\x1b[0m' : '') + '\x1b[K');
}, 600);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => { if (data.toString().includes('q')) process.exit(0); });
