// Ordinary multiline prompt and wide file contents, behind unchanged TUI chrome.
import { readFileSync } from 'node:fs';
const fixture = readFileSync(new URL('./stalls/mimo-refusal.ansi', import.meta.url), 'utf8');
const multiline = process.argv.includes('--multiline');
const prompt = 'First paragraph.\r\n  \x1b[38;2;255;128;64m┃\x1b[38;2;238;238;238m     Explain the ✗ Error message shown by the sample.';
const wide = 'File content'.padEnd(65) + '█ first';
const screen = multiline ? fixture.replace('Summarise the sample.', prompt) : fixture.replace('Reading the sample.', wide);
process.stdout.write(screen);
process.stdout.on('resize', () => {
  if (!multiline) return;
  process.stdout.write(screen.replace('message shown by the sample.', 'message.'));
  setTimeout(() => process.stdout.write(screen), 35);
});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  if (data.toString().includes('q')) process.exit(0);
  // A file change is autonomous output, not user input to ShellPuppet.
});
if (!multiline) setTimeout(() => process.stdout.write(screen.replace('█ first', '█ second')), 5000);
