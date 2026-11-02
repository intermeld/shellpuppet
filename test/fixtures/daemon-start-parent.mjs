import { spawn } from 'node:child_process';

const [program, ...args] = process.argv.slice(2);
const env = { ...process.env };
delete env.SHELLPUPPET_DAEMON_STARTED_WRAPPED;
const child = spawn(program, args, { stdio: 'ignore', windowsHide: true, env });
child.on('exit', () => { process.exitCode = 0; });
