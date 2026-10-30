// Test fixture: switches focus reporting on (DECSET 1004), as agent CLIs do,
// then prints every chunk it reads with ESC spelled out, so a test can see
// exactly which bytes reached the program.
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('\x1b[?1004h');
process.stdin.on('data', (b) => {
  process.stdout.write(`GOT[${b.toString('utf8').replace(/\x1b/g, 'ESC')}]\r\n`);
});
process.stdout.write('SINK READY\r\n');
