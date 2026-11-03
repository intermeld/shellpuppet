import * as fs from 'node:fs';

if (process.argv[2]) process.stdout.write(fs.readFileSync(process.argv[2], 'utf8'));
let tick = 0;
setInterval(() => {
  process.stdout.write(`\x1b[s\x1b[1;1HTick ${String(++tick).padStart(8, '0')}\x1b[u`);
}, 100);
