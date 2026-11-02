import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [marker, delay, ...rest] = process.argv.slice(2);
const [program, ...args] = rest.slice(-2);
appendFileSync(marker, `${process.pid}\n`);
setTimeout(() => {
  const child = spawn(program, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.on('error', () => process.exitCode = 1);
  child.unref();
}, Number(delay));
