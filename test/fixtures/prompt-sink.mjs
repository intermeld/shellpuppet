// Test fixture: a program that holds a permission prompt, and on Enter behaves
// like a TUI: it takes a moment to process the key, THEN clears the prompt
// and shows a busy line, and later asks the same question again. The delay is
// the point: a wait that reads the screen in that window sees a prompt that
// has already been answered.
process.stdin.setRawMode?.(true);
process.stdin.resume();

const PROMPT =
  ' Permission Required\r\n' +
  ' Allow this command to run?\r\n' +
  '\r\n' +
  '  ❯ 1. Allow once\r\n' +
  '    2. No\r\n';

process.stdout.write(`\x1b[2J\x1b[H${PROMPT}`);

process.stdin.on('data', (b) => {
  if (!b.toString('utf8').includes('\r')) return;
  setTimeout(() => {
    process.stdout.write('\x1b[2J\x1b[H Running... (1s)\r\n');
    setTimeout(() => process.stdout.write(`\x1b[2J\x1b[H${PROMPT}`), 1500);
  }, 400);
});
