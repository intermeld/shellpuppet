// A composer that treats Enter in the same burst as the text as pasted text.
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('BURST READY\r\n');
let draft = '';
let lastBodyAt = 0;
process.stdin.on('data', (chunk) => {
  const receivedAt = Date.now();
  const data = chunk.toString('utf8').replace(/\x1b\[20[01]~/g, '');
  for (const character of data) {
    if (character === '\r') {
      if (draft.length === 0) continue;
      const submitted = receivedAt - lastBodyAt >= 100;
      process.stdout.write(`\r\nRESULT ${submitted ? 'submitted' : 'pasted'}\r\n`);
      draft = '';
    } else {
      draft += character;
      lastBodyAt = receivedAt;
    }
  }
});
