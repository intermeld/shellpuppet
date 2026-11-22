// A composer that paints a paste late and needs more time for longer bodies.
process.stdin.setRawMode?.(true);
process.stdin.resume();
// The cursor rests after the last row's text, where Codex keeps its insertion point.
const redraw = (rows) => process.stdout.write(`\x1b[2J\x1b[H${rows.join('\r\n')}`);
const empty = '› \x1b[2mAsk Codex to do anything\x1b[0m';
redraw(['BURST READY', empty]);
let draft = '';
let lastBodyAt = 0;
let paintTimer;
let painted = false;
const paint = () => {
  painted = true;
  redraw(['BURST READY', `› ${draft.length >= 300 ? `[Pasted Content ${draft.length} chars]` : draft}`]);
};
process.stdin.on('data', (chunk) => {
  const receivedAt = Date.now();
  const data = chunk.toString('utf8').replace(/\x1b\[20[01]~/g, '');
  for (const character of data) {
    if (character === '\r') {
      if (draft.length === 0) continue;
      const neededMs = Math.max(100, Math.ceil(draft.length * 2.2));
      const submitted = painted && receivedAt - lastBodyAt >= neededMs;
      redraw(['BURST READY', `RESULT ${submitted ? 'submitted' : 'pasted'}`,
        submitted ? empty : `› [Pasted Content ${draft.length} chars]`]);
      draft = '';
      clearTimeout(paintTimer);
      painted = false;
    } else {
      draft += character;
      lastBodyAt = receivedAt;
      clearTimeout(paintTimer);
      paintTimer = setTimeout(paint, Math.max(220, Math.ceil(draft.length * 0.7)));
    }
  }
});
