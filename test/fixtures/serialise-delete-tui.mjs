// A live inline screen whose wrapped row is deleted while output is synchronised.
const out = process.stdout;
let tick = 0;

function frame() {
  out.write('\x1b[5;20H\x1b[?2026h' + ' a'.repeat(140) +
    '\x1b[5;20H\x1b[1M');
}

frame();
setInterval(() => {
  tick++;
  out.write(`\x1b[2;1H\x1b[2KWorking (${tick}) › • ─ └ 😀`);
}, 200);
out.on('resize', frame);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
