// Synthetic MiMo structure, with neutral transcript and no agent CLI.
import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
const refusal = readFileSync(new URL('./stalls/mimo-refusal.ansi', import.meta.url), 'utf8');
const responsive = process.argv.includes('--responsive');
const frame = () => responsive ? refusal.replace('╹' + '▀'.repeat(20), '╹' + '▀'.repeat(process.stdout.columns - 5)) : refusal;
process.stdout.write(frame());
if (responsive) process.stdout.on('resize', () => {
  // Repaint each row at the new width without an intermediate empty screen.
  process.stdout.write(frame().replace('\x1b[2J', '').split('\r\n').map(line => {
    const length = stripVTControlCharacters(line).length;
    // Erasing at a pending right-edge wrap would erase the last character.
    return line + (length > 0 && length % process.stdout.columns === 0 ? '' : '\x1b[K');
  }).join('\r\n') + '\x1b[J');
});
if (process.argv.includes('--toggle-suggestion')) {
  let suggested = false;
  setInterval(() => {
    suggested = !suggested;
    const row = 1 + frame().split('\r\n').slice(0, 15).reduce((rows, line) =>
      rows + Math.max(1, Math.ceil(stripVTControlCharacters(line).length / process.stdout.columns)), 0);
    process.stdout.write(`\x1b[${row};1H  \x1b[38;2;255;128;64m┃\x1b[0m` +
      (suggested ? '  \x1b[38;2;128;128;128mReview the sample. (Tab to accept)\x1b[0m' : '') + '\x1b[K');
  }, 1800);
}
if (process.argv.includes('--toggle-recovery')) {
  let recover = true;
  const footer = refusal.split('\r\n')[12];
  setInterval(() => {
    recover = !recover;
    // Change only the control. Clearing the entire screen can produce an
    // intermediate empty frame in ConPTY, which really does end the notice.
    process.stdout.write('\x1b[13;1H' + (recover ? footer : footer.replace('          ↻ /recover', '')) + '\x1b[K');
  }, 1500);
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  const key = data.toString();
  if (key.includes('q')) process.exit(0);
  if (key.includes('r')) process.stdout.write(refusal);
  if (key.includes('b')) process.stdout.write('\x1b[2J\x1b[H  ┃  Continue the task.\r\n     ⠇ Thinking\r\n\r\n  ┃\r\n  ┃\r\n  ┃  Build · Example Model\r\n  ╹▀▀▀▀▀▀▀▀▀▀\r\n   esc to interrupt');
});
