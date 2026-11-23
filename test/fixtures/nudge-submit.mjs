import { appendFileSync, readFileSync } from 'node:fs';

const [input, ignoredKeys, repaint] = process.argv.slice(2);
const rows = readFileSync(new URL('reasoning/muse-7a-composer-swallowed.ansi', import.meta.url), 'utf8').split(/\r?\n/u);
let draft = '';
let submits = 0;

function paint() {
  const progress = repaint && submits ? ' ' + submits : '';
  // Replace the captured two-row draft with the single line this fixture edits.
  const inputRow = '\x1b[2K❯ \x1b[38;2;204;211;219m' + draft + '\x1b[0m';
  const screen = [...rows.slice(0, 4), inputRow, ...rows.slice(6)].join('\r\n');
  process.stdout.write('\x1b[H' + screen + '\r\n  Background task running' + progress +
    `\x1b[5;${String(3 + draft.length)}H`);
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
