// Test fixture: a raw-mode reader that never enables bracketed paste, so the
// chunked write path (the 4 KB canonical-mode guard) is what delivers to it.
// Reports whether paste markers were injected and whether the front and the
// tail of the message arrived.
process.stdin.setRawMode?.(true);
process.stdin.resume();
let buf = '';
process.stdin.on('data', (b) => {
  buf += b.toString('utf8');
  if (/[\r\n]/.test(buf)) {
    process.stdout.write(
      `\r\nRESULT markers=${/\x1b\[200~/.test(buf)} front=${buf.includes('FRONTMARK')} tail=${buf.includes('TAILMARK')}\r\n`,
    );
    buf = '';
  }
});
process.stdout.write('SINK READY\r\n');
