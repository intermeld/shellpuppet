/** Long Muse approval screens based on the masked captured menus. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScreenRenderer } from '../../src/core/renderer.js';

export async function museWrappedAnsi(capture: string, extraRows: number): Promise<string> {
  const root = path.join(__dirname, 'reasoning', capture);
  const size = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8')) as { cols: number; rows: number };
  const renderer = new ScreenRenderer({ cols: size.cols, rows: size.rows });
  try {
    await renderer.write(fs.readFileSync(`${root}.ansi`, 'utf8'));
    const lines = renderer.snapshot().screen.split('\n');
    const question = lines.findIndex((line) => /^Would .+ like to run the following command\?$/.test(line));
    const firstOption = lines.findIndex((line) => /^⟩ 1\. /.test(line));
    if (question < 0 || firstOption < 0) throw new Error(`Incomplete Muse capture: ${capture}`);
    const command = lines.findIndex((line, index) => index > question && /^  \$ /.test(line));
    if (command < 0) throw new Error(`Missing command in Muse capture: ${capture}`);
    const menu = lines.slice(question, firstOption + 3);
    const commandInMenu = menu.findIndex((line) => /^  \$ /.test(line));
    // The inserted rows use the captured command's blue foreground colour.
    const wrapped = Array.from({ length: extraRows }, () => '\x1b[38;2;129;162;190m  xxxxxxxxxxxxxxxxxxxx\x1b[0m');
    menu.splice(commandInMenu + 1, 0, ...wrapped);
    return `\x1b[2J\x1b[H${menu.join('\r\n')}`;
  } finally {
    renderer.dispose();
  }
}

export async function museWrappedScreen(capture: string, extraRows: number, cols: number, rows: number): Promise<string> {
  const renderer = new ScreenRenderer({ cols, rows });
  try {
    await renderer.write(await museWrappedAnsi(capture, extraRows));
    return renderer.snapshot().screen;
  } finally {
    renderer.dispose();
  }
}
