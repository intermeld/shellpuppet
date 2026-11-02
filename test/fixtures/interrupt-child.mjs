import * as fs from 'node:fs';

const signalFile = process.argv[2];

// Model a child that takes time to start. A shell echo of the command is not
// evidence that the child can receive Ctrl+C yet.
setTimeout(() => {
  process.on('SIGINT', () => {
    fs.writeFileSync(signalFile, String(process.pid));
    process.exit(130);
  });
  process.stdout.write('INTERRUPT_CHILD_READY\n');
  setInterval(() => {}, 100);
}, 500);
