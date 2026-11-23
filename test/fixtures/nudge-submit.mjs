import { appendFileSync, readFileSync } from 'node:fs';

const [input, ignoredKeys, repaint] = process.argv.slice(2);
const screen = readFileSync(new URL('reasoning/muse-7a-composer-swallowed.ansi', import.meta.url), 'utf8');
let draft = '';
let submits = 0;

function paint() {
  const progress = repaint && submits ? ' ' + submits : '';
  process.stdout.write('\x1b[H' + screen + '\x1b[9;1H  Background task running' + progress +
    '\x1b[5;1H\x1b[2K❯ \x1b[38;2;204;211;219m' + draft + '\x1b[0m');
}

process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  appendFileSync(input, bytes);
  let changed = false;
  for (const key of bytes.toString()) {
    if (key === '\r') {
      if (++submits <= Number(ignoredKeys)) continue;
      draft = '';
    } else {
      draft += key;
    }
    changed = true;
  }
  if (changed || repaint) paint();
});
paint();
