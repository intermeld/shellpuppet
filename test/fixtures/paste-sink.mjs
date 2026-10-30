// Test fixture: behaves like a TUI by enabling bracketed paste (DEC 2004),
// then reports whether input arrived wrapped in paste markers and whether the
// FRONT of a long message survived. Used by the pty-session integration tests.
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('\x1b[?2004h');
let buf = '';
process.stdin.on('data', (b) => {
  buf += b.toString('utf8');
  if (/[\r\n]/.test(buf)) {
    const bracketed = buf.includes('\x1b[200~') && buf.includes('\x1b[201~');
    const body = buf.replace(/\x1b\[20[01]~/g, '');
    process.stdout.write(
      `\r\nRESULT bracketed=${bracketed} front=${body.includes('FRONTMARK')} tail=${body.includes('TAILMARK')}\r\n`,
    );
    buf = '';
  }
});
process.stdout.write('SINK READY\r\n');
