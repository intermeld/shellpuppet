// Controlled startup screens only. No agent CLI, credentials or external calls.
import { readFileSync } from 'node:fs';

const [mode, delay = '700', fixture] = process.argv.slice(2);
const paint = text => process.stdout.write(`\x1b[2J\x1b[H${text}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', data => {
  if (data.includes(3) || data.toString().includes('q')) process.exit(0);
  if (data.toString().includes('r')) paint('READY from stand-in');
  if (mode === 'ready-question' && data.toString().includes('p')) paint('READY from stand-in\r\nContinue? (y/n)');
});
if (mode === 'ready' || mode === 'ready-question') setTimeout(() => paint('READY from stand-in'), Number(delay));
if (mode === 'module') setTimeout(() => paint('Ask Codex'), Number(delay));
if (mode === 'question') setTimeout(() => paint('Do you trust the files in this folder?\r\n❯ 1. Yes\r\n  2. No'), Number(delay));
if (mode === 'dialog') setTimeout(() => paint(readFileSync(fixture, 'utf8')), Number(delay));
if (mode === 'exit') setTimeout(() => process.exit(7), Number(delay));
setTimeout(() => process.exit(0), 90_000);
