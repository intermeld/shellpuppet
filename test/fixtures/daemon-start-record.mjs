import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [marker, literal, program, entry] = process.argv.slice(2);
writeFileSync(marker, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));
const child = spawn(program, [entry], {
  detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
});
child.on('error', () => process.exitCode = 1);
child.unref();
