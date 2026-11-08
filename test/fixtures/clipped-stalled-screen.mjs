// Neutral long prompt with the evidenced MiMo refusal and native reflow.
import { readFileSync } from 'node:fs';
const screen = readFileSync(new URL('./stalls/mimo-refusal.ansi', import.meta.url), 'utf8')
  .replace('Summarise the sample.', 'Neutral sample text '.repeat(670) + (process.argv.includes('--colon') ? ':' : ''));
process.stdout.write(screen);
// Test-only transport variation: let the native preliminary growth redraw
// persist beyond one validation interval, then split application and composer
// writes at different boundaries. Queue writes so ANSI byte order is unchanged.
const delayed = process.argv.includes('--chunk-delays');
let writes = Promise.resolve();
let frame = 0;
const write = (text, growth = false) => {
  if (!delayed) { process.stdout.write(text); return; }
  const tail = [22, 83, 147][frame++ % 3];
  writes = writes.then(async () => {
    if (growth) await new Promise(resolve => setTimeout(resolve, 450));
    const split = Math.max(1, text.length - tail);
    process.stdout.write(text.slice(0, split));
    await new Promise(resolve => setTimeout(resolve, 35));
    process.stdout.write(text.slice(split));
  });
};
process.stdout.on('resize', () => {
  if (process.stdout.columns >= 120) {
    write(screen.replace('╹' + '▀'.repeat(20), '╹' + '▀'.repeat(process.stdout.columns - 5)), true);
  } else {
    write(`\x1b[${process.stdout.rows - 1};1H  \x1b[38;2;255;128;64m╹` +
      '▀'.repeat(process.stdout.columns - 5) + '\x1b[0m\x1b[K');
  }
});
let suggested = false;
setInterval(() => {
  if (process.stdout.columns >= 120) return;
  suggested = !suggested;
  write(`\x1b[${process.stdout.rows - 3};1H  \x1b[38;2;255;128;64m┃\x1b[0m` +
    (suggested ? '  \x1b[38;2;128;128;128mReview the sample. (Tab to accept)\x1b[0m' : '') + '\x1b[K');
}, 600);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => { if (data.toString().includes('q')) process.exit(0); });
