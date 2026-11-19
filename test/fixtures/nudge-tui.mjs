import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const inputFile = process.argv[3];
const readSignal = process.argv[4];
const capture = mode === 'draft' ? 'claude-prompt-typed' : 'claude-answered';
const initialScreen = fs.readFileSync(path.join(here, 'reasoning', `${capture}.ansi`));
let lateBody = '';
process.stdout.write(initialScreen);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (bytes) => {
  fs.appendFileSync(inputFile, bytes);
  fs.appendFileSync(`${inputFile}.events`, `${JSON.stringify({ data: bytes.toString(), at: Date.now() })}\n`);
  if (mode === 'queued-paste' && bytes.toString() === '\x15') {
    // The programme repaints an empty composer while its queued paste remains buffered.
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(initialScreen);
    return;
  }
  if (mode === 'late-person' && bytes.toString() === 'x') return;
  if (mode === 'late' || mode === 'late-person' || mode === 'queued-paste') {
    // The PTY accepted the bytes, but this program has not painted them yet.
    lateBody += bytes.toString();
    return;
  }
  if (mode === 'clearable' && bytes.toString() === '\x15') {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(initialScreen);
    return;
  }
  if (mode === 'dim-extra' || mode === 'clearable') {
    process.stdout.write('\x1b[31;1H\x1b[J\x1b[2m❯\u00a0' + bytes.toString() +
      ' extra\x1b[0m\r\n' + '\x1b[0;38;2;136;136;136m' + '─'.repeat(120) + '\x1b[0m');
    return;
  }
  if (mode !== 'ready') return;
  const data = bytes.toString();
  if (data === '\r' || data === '\x15') {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(initialScreen);
  } else {
    process.stdout.write('\x1b[31;1H\x1b[J❯\u00a0' + data + '\r\n' +
      '\x1b[0;38;2;136;136;136m' + '─'.repeat(120) + '\x1b[0m');
  }
});

setInterval(() => {
  if ((mode !== 'late' && mode !== 'late-person' && mode !== 'queued-paste') ||
    lateBody === '' || !fs.existsSync(`${inputFile}.paint`)) return;
  fs.unlinkSync(`${inputFile}.paint`);
  process.stdout.write('\x1b[31;1H\x1b[J❯\u00a0' + lateBody +
    '\r\n' + '\x1b[0;38;2;136;136;136m' + '─'.repeat(120) + '\x1b[0m');
  lateBody = '';
}, 25).unref();

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
