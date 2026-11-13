// Start above the prompt, then repaint with brief header visits or long pauses.
import { phaseDriver } from './notice-phase-driver.mjs';
process.stdin.setRawMode?.(true);
process.stdin.resume();
const period = Number(process.argv[2] || 33);
let interval = null, returnTimer = null, frame = 0;
const prompt = '\x1b[20;1HPermission Required\x1b[21;1HAllow this command to run?' +
  '\x1b[22;1H  ❯ 1. Allow once\x1b[23;1H    2. Reject';
const phases = phaseDriver();
const stop = () => { phases.stop(); clearInterval(interval); clearTimeout(returnTimer); };
process.stdout.write('\x1b[2J' + prompt + '\x1b[2;1H');
process.stdin.on('data', bytes => {
  for (const key of phases.read(bytes)) {
    stop();
    if (key === 'r') interval = setInterval(() => {
      frame++;
      // ConPTY can stretch an 8 ms split into an entire repaint frame.
      // Repaint the prompt every frame, visiting the header every third
      // frame so the browser still measures a clear resting-time lead.
      if (frame % 3 !== 0) { process.stdout.write(prompt); return; }
      process.stdout.write('\x1b[1;1HStatus ' + frame);
      returnTimer = setTimeout(() => process.stdout.write(prompt), 8);
    }, period);
    if (key === 's' || key === 'l') {
      const duration = key === 's' ? 350 : 400;
      // Establish the acknowledgement round trip on the already clear prompt.
      phases.start([[prompt, duration, 22], ['\x1b[1;1HStatus', duration, 0]]);
    }
    if (key === 't') process.stdout.write('\x1b[2;1H');
    if (key === 'b') process.stdout.write('\x1b[23;1H');
    if (key === 'c') process.stdout.write('\x1b[13;1H');
  }
});
