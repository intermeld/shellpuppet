import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const inputFile = process.argv[3];
const readSignal = process.argv[4];
const capture = mode === 'draft' ? 'claude-prompt-typed' : 'claude-answered';
process.stdout.write(fs.readFileSync(path.join(here, 'reasoning', `${capture}.ansi`)));
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (bytes) => fs.appendFileSync(inputFile, bytes));

let read = false;
setInterval(async () => {
  if (read || !fs.existsSync(readSignal)) return;
  read = true;
  const state = JSON.parse(fs.readFileSync(path.join(process.env.SHELLPUPPET_HOME, 'daemon.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${state.port}/messages/inbox`, {
    headers: {
      authorization: `Bearer ${state.token}`,
      'x-shellpuppet-session': process.env.SHELLPUPPET_SESSION,
      'x-shellpuppet-session-token': process.env.SHELLPUPPET_SESSION_TOKEN,
    },
  });
  fs.writeFileSync(`${readSignal}.result`, JSON.stringify(await response.json()));
}, 50).unref();
