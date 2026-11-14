// A held permission prompt with a status row repainted at 40 frames a second.
// Split writes deliberately expose the cursor's journey between screen halves.
process.stdin.setRawMode?.(true);
process.stdin.resume();
let frame = 0;
let repaint = null;
let returnToPrompt = null;
const prompt = '\x1b[28;1HPermission Required\x1b[29;1HAllow this command to run?' +
  '\x1b[30;1H  ❯ 1. Allow once\x1b[31;1H    2. Reject';
const stop = () => { clearInterval(repaint); clearTimeout(returnToPrompt); };
const animate = () => {
  stop();
  repaint = setInterval(() => {
    process.stdout.write(`\x1b[1;1HRepainting ${String(++frame)}`);
    returnToPrompt = setTimeout(() => process.stdout.write(prompt), 8);
  }, 25);
};
process.stdout.write('\x1b[2J' + prompt);
animate();
process.stdin.on('data', (bytes) => {
  for (const key of bytes.toString('utf8')) {
    if (key === 'r') animate();
    if (key === 't' || key === 'b') {
      stop();
      // A real move reaches rows a notice on the old edge would cover.
      process.stdout.write(key === 't' ? '\x1b[5;1H' : '\x1b[49;1H');
    }
    if (key === 'j') {
      stop();
      repaint = setInterval(() => process.stdout.write(++frame % 2 ? '\x1b[24;1H' : '\x1b[26;1H'), 80);
    }
  }
});
