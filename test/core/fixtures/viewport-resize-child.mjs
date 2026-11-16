import { ScreenRenderer } from '../../../dist/core/renderer.js';
import process from 'node:process';

const scenario = process.argv[2];
const renderer = new ScreenRenderer({ cols: 80, rows: 24, scrollback: 5000 });
const term = renderer.term;
const state = () => {
  const buffer = term._core.buffer;
  return { length: buffer.lines.length, maxLength: buffer.lines.maxLength,
    ybase: buffer.ybase, rows: term.rows,
    active: term.buffer.active === term.buffer.normal ? 'normal' : 'alternate' };
};
try {
  if (scenario === 'moving' || scenario === 'saturated') {
    const buffer = term._core.buffer;
    let pushes = 0;
    const lines = { length: 24, maxLength: 24, push() {
      pushes++;
      if (scenario === 'moving') this.length++;
    } };
    buffer.lines = lines;
    if (scenario === 'moving') {
      let base = 25;
      Object.defineProperty(buffer, 'ybase', { get() { return base++; }, set(value) { base = value; } });
    } else buffer.ybase = 5000;
    try {
      renderer.repairViewport();
      throw new Error('invalid viewport was accepted');
    } catch (error) {
      if (error.message !== 'xterm viewport repair failed') throw error;
      process.stdout.write(JSON.stringify({ scenario, pushes }) + '\n');
    }
    process.exit(0);
  }
  if (scenario === 'forced') {
    const buffer = term._core.buffer;
    buffer.lines.length = buffer.lines.maxLength;
    buffer.ybase = buffer.lines.maxLength + 1;
    renderer.repairViewport();
    throw new Error('forced invalid viewport was accepted');
  }
  if (scenario === 'alternate') await renderer.write('\x1b[?1049h');
  await renderer.write(Array.from({ length: 5050 }, (_, i) => `line-${i}\r\n`).join(''));
  const before = state();
  if (scenario === 'queued') {
    void renderer.write('pending\r\n');
    renderer.resize(96, 31);
  } else if (scenario === 'double') {
    renderer.resize(96, 30);
    renderer.resize(96, 31);
  } else renderer.resize(96, 31);
  await renderer.flush();
  process.stdout.write(JSON.stringify({ scenario, before, after: state() }) + '\n');
} finally {
  await renderer.dispose();
}
