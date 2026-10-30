/**
 * `terminal_type` verify against an input box that wraps what it is given.
 * OpenCode draws a `┃` border down the left of its input box and, on a wide
 * screen, a side panel on the same rows, so both land between the wrapped
 * pieces of a long line; and it draws a long line only once it has worked
 * through every keystroke, seconds later. Text that arrived perfectly must
 * still verify: an agent told it did not would type it again. (Text that
 * never arrives is covered in `cli.test.ts`, against a sink that discards it.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const SINK = path.join(repoRoot, 'test', 'fixtures', 'input-box-sink.mjs');
/** Draws a screen and ignores what is typed, unless it is Enter. */
const SCREEN_SINK = path.join(repoRoot, 'test', 'fixtures', 'dialog-sink.mjs');

let td: TestDaemon;
let home: string;

beforeAll(async () => {
  home = makeTempHome('shellpuppet-verify-box-');
  td = await startTestDaemon({ home });
});

afterAll(async () => {
  await td.stop();
});

describe('verify against a wrapping input box', () => {
  it('confirms a long line wrapped past the border and the side panel', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [SINK], shell: false, cols: 100, rows: 20 },
    });
    expect(started.status).toBe(200);
    const id = String((started.body as { id: string }).id);
    await api(td.port, td.token, `/sessions/${id}/wait?text=Build&timeout=15000`);

    // 100 characters into a 40-character box: the last 40, which verify looks
    // for, straddle the second wrap, where the panel's text ends one row and
    // the border starts the next. Not submitted: the sink never runs anything.
    const long = `boxcheck-${'y'.repeat(80)}-endmarker`;
    const typed = await api(td.port, td.token, `/sessions/${id}/input`, {
      body: { data: long, verify: true },
    });
    expect(typed.status).toBe(200);
    expect(typed.body['verified']).toBe(true);

    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('waits for a box that draws a long line all at once, late', async () => {
    // 10 ms a character, as OpenCode works through keystrokes before it draws:
    // the line shows about a second after it arrives.
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [SINK, '10'], shell: false, cols: 100, rows: 20 },
    });
    expect(started.status).toBe(200);
    const id = String((started.body as { id: string }).id);
    await api(td.port, td.token, `/sessions/${id}/wait?text=Build&timeout=15000`);

    const long = `latecheck-${'z'.repeat(80)}-endmarker`;
    const typed = await api(td.port, td.token, `/sessions/${id}/input`, {
      body: { data: long, verify: true },
    });
    expect(typed.status).toBe(200);
    expect(typed.body['verified']).toBe(true);

    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('does not take what was on screen before the input for its wrapped pieces', async () => {
    // A table already on screen whose cells, read row by row, spell the typed
    // text. The program ignores the input, so the text never lands.
    const table = path.join(home, 'table.txt');
    fs.writeFileSync(table, ['NAME    STATE', 'alpha   rejected', 'beta    pending', ''].join('\n'));
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [SCREEN_SINK, table, table], shell: false, cols: 100, rows: 20 },
    });
    expect(started.status).toBe(200);
    const id = String((started.body as { id: string }).id);
    await api(td.port, td.token, `/sessions/${id}/wait?text=pending&timeout=15000`);

    const typed = await api(td.port, td.token, `/sessions/${id}/input`, {
      body: { data: 'alpha beta', verify: true },
    });
    expect(typed.status).toBe(200);
    expect(typed.body['verified']).toBe(false);

    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });
});
