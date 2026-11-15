import { readFileSync } from 'node:fs';
import type { IPty } from 'node-pty';
import { expect, it } from 'vitest';
import { Session } from '../../src/core/session.js';
import { detectPrompt } from '../../src/core/promptDetector.js';

const fixture = readFileSync(new URL('../fixtures/stalls/server-lost-over-permission.ansi', import.meta.url), 'utf8');
const rows = Array.from({ length: 24 }, () => '');
rows[11] = '  ┃  △ Permission required';
rows[13] = '  ┃  $ example command';
rows[20] = '  ┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter confirm';
const prompt = '\x1b[2J\x1b[H' + rows.join('\r\n');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it('keeps a settled server-lost stall over a detected prompt and restores that prompt on reconnection', async () => {
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), resize() {}, write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  const session = new Session('server-lost-over-prompt',
    { command: process.execPath, agent: 'opencode', cols: 80, rows: 24 },
    { platform: 'linux', spawn: () => pty, pidWaitMs: 0 });
  const draw = async (data: string) => { output(data); await session.viewportLines(); };
  try {
    await draw(prompt);
    expect(session.answerablePrompt((await session.snapshot()).screen)).not.toBeNull();
    await draw(fixture + '\x1b[16;1H  ┃  △ Permission required\x1b[K');
    const obscured = await session.snapshot();
    expect(detectPrompt(obscured.screen, 'opencode', 24)).not.toBeNull();
    await sleep(1400);
    expect(session.getStalled()?.reason).toBe('server-lost');
    expect(session.answerablePrompt(obscured.screen)).toBeNull();
    await draw('\x1b[17;1H  ┃  $ another example command\x1b[K');
    await sleep(500);
    expect(session.getStalled()?.reason).toBe('server-lost');
    await draw(prompt);
    await sleep(500);
    expect(session.getStalled()).toBeUndefined();
    expect(session.answerablePrompt((await session.snapshot()).screen)).not.toBeNull();
  } finally { await session.kill(); }
}, 8000);
