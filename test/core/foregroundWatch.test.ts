import { expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';

it.each([
  ['RGB', '\x1b[38;2;251;113;133m', '#fb7185'],
  ['colon RGB', '\x1b[38:2::251:113:133m', '#fb7185'],
  ['palette', '\x1b[31m', 'p1'],
  ['indexed palette', '\x1b[38;5;1m', 'p1'],
])('keeps possible %s ink across split colour commands and delayed printing', async (_name, colour, expected) => {
  const renderer = new ScreenRenderer({ cols: 80, rows: 24 });
  const watch = renderer.watchForeground([expected]);
  try {
    await renderer.write(colour.slice(0, -2));
    watch.checkAbsent();
    expect(watch.possible).toBe(false);
    await renderer.write(colour.slice(-2));
    watch.checkAbsent();
    // A colour can remain active without having printed any cells yet.
    expect(watch.possible).toBe(true);
    await renderer.write('X\x1b[0m');
    watch.checkAbsent();
    expect(renderer.hasForeground([0], [expected])).toBe(true);
    expect(watch.possible).toBe(true);
    await renderer.write('\x1b[2J');
    watch.checkAbsent();
    expect(watch.possible).toBe(false);
  } finally { renderer.dispose(); }
});

it('does not treat a matching background colour as foreground ink', async () => {
  const renderer = new ScreenRenderer();
  const watch = renderer.watchForeground(['#fb7185']);
  try {
    await renderer.write('\x1b[48;2;251;113;133mX\x1b[0m');
    expect(watch.possible).toBe(false);
  } finally { renderer.dispose(); }
});

it('rechecks restored attributes and a restored buffer without new colour commands', async () => {
  const renderer = new ScreenRenderer();
  const watch = renderer.watchForeground(['#fb7185']);
  try {
    await renderer.write('\x1b[38;2;251;113;133m\x1b7\x1b[0m');
    watch.checkAbsent();
    expect(watch.possible).toBe(false);
    await renderer.write('\x1b8');
    watch.checkAbsent();
    expect(watch.possible).toBe(true);
    await renderer.write('X\x1b[0m');
    expect(renderer.hasForeground([0], ['#fb7185'])).toBe(true);
    await renderer.write('\x1b[?1049h\x1b[0m');
    watch.checkAbsent();
    expect(watch.possible).toBe(false);
    await renderer.write('\x1b[?1049l');
    watch.checkAbsent();
    expect(watch.possible).toBe(true);
    expect(renderer.hasForeground([0], ['#fb7185'])).toBe(true);
  } finally { renderer.dispose(); }
});
