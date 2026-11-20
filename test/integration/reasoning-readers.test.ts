/**
 * The readers that leave an agent's reasoning out (`reasoning.ts`), end to
 * end through the daemon: a session replays a screen captured from a real
 * agent CLI through a real PTY, and `hideReasoning` and `terminal_result` read
 * it. Both fail closed, so the refusals are pinned as carefully as the reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import type { ScreenRenderer } from '../../src/core/renderer.js';
import { api, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'reasoning');

let td: TestDaemon;

beforeAll(async () => {
  td = await startTestDaemon({ policy: { mode: 'allow-all' } });
});
afterAll(async () => {
  await td.stop();
}, 120_000);

/** Start a session that draws a captured screen and then sits still. */
async function replay(name: string, agent?: string, ready = /Type your message|\? for shortcuts|Ask Codex/): Promise<string> {
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as {
    cols: number;
    rows: number;
  };
  const file = path.join(FIXTURES, `${name}.ansi`);
  const started = await api(td.port, td.token, '/sessions', {
    body: {
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8')); setInterval(() => {}, 500)`,
      ],
      shell: false,
      cols: meta.cols,
      rows: meta.rows,
      hold: true,
      ...(agent !== undefined ? { agent } : {}),
    },
  });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  let screen = '';
  await eventually(async () => {
    const snap = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    screen = String(snap.body['screen']);
    return ready.test(screen);
  }, 30_000, 100, 'the replay controls', () => screen.slice(-500));
  return id;
}

async function longWrappedLine(name: string, line: string): Promise<string> {
  const file = path.join(td.home, `${name}.ansi`);
  fs.writeFileSync(file, ` > ask\r\n${line}\r\n\x1b[38;2;149;149;143m >  Type\x1b[0m`);
  const started = await api(td.port, td.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', `const value = require('fs').readFileSync(${JSON.stringify(file)}, 'utf8'); if (${JSON.stringify(name === 'long-answer')}) { const end = value.lastIndexOf('\\x1b[38;2;149;149;143m'); process.stdout.write(value.slice(0, end)); setTimeout(() => process.stdout.write(value.slice(end)), 1500); } else process.stdout.write(value); setInterval(() => {}, 500)`],
      shell: false, agent: 'qoder', cols: 30, rows: 10, hold: true,
    },
  });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  let visibleScreen = '';
  await eventually(async () => {
    visibleScreen = String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']);
    return visibleScreen.includes(line[3]!.repeat(4));
  }, 30_000, 100, 'the wrapped line in the snapshot', () => visibleScreen.slice(-500));
  return id;
}

describe('Grok permission box with an edit pattern action', () => {
  let id: string;
  beforeAll(async () => {
    id = await replay('grok-permission-edit-pattern', 'grok', /1\/5:select/);
  });

  it('keeps the selected option in the filtered snapshot and at its original find row', async () => {
    const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1`);
    expect(snapshot.status).toBe(200);
    expect(String(snapshot.body['screen'])).toContain('3 (•) Yes, proceed');
    const find = `/sessions/${id}/find?pattern=Yes%2C%20proceed`;
    const plain = await api(td.port, td.token, find);
    expect(plain.body['matches']).toHaveLength(1);
    const filtered = await api(td.port, td.token, find + '&hideReasoning=1');
    expect(filtered.status).toBe(200);
    expect(filtered.body['matches']).toEqual(plain.body['matches']);
  });

  it('matches the listed prompt in a filtered single-session wait and returns every radio', async () => {
    let listed: { question: string; options: string[] } | undefined;
    await eventually(async () => {
      const reply = await api(td.port, td.token, '/sessions?waitingOnly=1');
      const sessions = reply.body['sessions'] as { id: string; question: string; options: string[] }[];
      listed = sessions.find((session) => session.id === id);
      return listed !== undefined;
    }, 15_000);
    const wait = await api(td.port, td.token, `/sessions/${id}/wait?prompt=1&hideReasoning=1&timeout=10000`);
    expect(wait.status).toBe(200);
    expect(wait.body).toMatchObject({ matched: true, reason: 'prompt', reasoning: { agent: 'grok' } });
    const prompt = wait.body['prompt'] as { question: string; options: string[]; selectedOption: number };
    expect(prompt.question).toBe(listed!.question);
    expect(prompt.selectedOption).toBe(1);
    expect(prompt.options).toEqual([
      expect.stringMatching(/^1 \(○\) Always allow:/u),
      '3 (•) Yes, proceed',
      '4 (○) No, reject (type to add feedback)',
      expect.stringMatching(/^5 \(○\) Never allow:/u),
      "(○) Yes, and don't ask again for anything (always-approve mode)",
    ]);
    expect(prompt.options).toEqual(listed!.options);
    const screen = String(wait.body['screen']);
    expect(screen).toContain('  │  >  ' + prompt.question);
    for (const option of prompt.options) expect(screen).toContain(option);
  });

  it('leaves the radio choices uncovered in a filtered screenshot', async (context) => {
    if (await findBrowser() === null) { context.skip(); return; }
    const shot = await api(td.port, td.token, `/sessions/${id}/screenshot`, { body: { hideReasoning: true } });
    expect(shot.status, JSON.stringify(shot.body['diagnostics'] ?? shot.body['error'])).toBe(200);
    const rows = (shot.body['lines'] as string[]).join('\n');
    expect(rows).toContain('Always allow:');
    expect(rows).toContain('3 (•) Yes, proceed');
    expect(rows).toContain('always-approve mode');
  }, 120_000);

  describe.each([196, 80])('at %i columns', (cols) => {
    it.each(['command', 'question'] as const)('reads the full prompt when the %s wraps', async (part) => {
      // Insert room in the captured frame, then let xterm wrap the extra text.
      // Replaying a redraw through ConPTY can change its physical wrap flags.
      const manager = (td.daemon as unknown as { manager: {
        get(id: string): { renderer: ScreenRenderer };
      } }).manager;
      const renderer = manager.get(id).renderer;
      const capture = fs.readFileSync(path.join(FIXTURES, 'grok-permission-edit-pattern.ansi'), 'utf8');
      try {
        await renderer.write('\x1bc' + capture);
        const captured = renderer.styledLines().lines;
        const row = part === 'command' ? 85 : 81;
        const original = captured[row]!.text;
        const ink = part === 'command' ? '137;221;255' : '200;200;200';
        // At 80 a real space ends the first row. A double-width character
        // moves to the third row, leaving an unused cell at the right edge.
        const extended = part === 'question' && cols === 80
          ? ((original.padEnd(79, 'x') + ' second').padEnd(159, 'x') + '界').padEnd(206, 'x')
          : original.padEnd(207, 'x');
        const question = (part === 'question' ? extended : captured[81]!.text).slice(7).trim();
        const extraRows = Math.ceil(extended.length / cols) - 1;
        renderer.resize(cols, 99 + extraRows);
        // Collapsing two earlier rows changes the box's filtered row numbers.
        if (cols === 80) await renderer.write('\x1b[H\x1b[0m\x1b[2K  │  ♦ Thinking…\r\n\x1b[2K  │  earlier detail\r\n\x1b[2K');
        const column = Math.min(original.length, cols - 1);
        await renderer.write(`\x1b[${row + 2};1H\x1b[${extraRows}L\x1b[${row + 1};${column + 1}H` +
          `\x1b[38;2;${ink};48;2;64;64;64m${extended.slice(column)}\x1b[0m`);
        const lines = renderer.styledLines().lines;
        const physical = lines.slice(row, row + extraRows + 1);
        expect(physical[0]!.text).toBe(extended.slice(0, cols).trimEnd());
        expect(extended.endsWith(physical.at(-1)!.text)).toBe(true);
        for (let i = 1; i <= extraRows; i++) expect(lines[row + i]!.wrapped).toBe(true);
        const options = lines.filter(line => /^ {2}│ {2}(?:\d+| ) \([○•]\)/u.test(line.text))
          .map(line => line.text.slice(5).trim());
        expect(options).toHaveLength(5);
        for (const hide of [true, false]) {
          const wait = await api(td.port, td.token, `/sessions/${id}/wait?prompt=1&hideReasoning=${hide}&timeout=500`);
          expect(wait.body['reason']).toBe('prompt');
          expect(wait.body['prompt']).toMatchObject({ question, options, selectedOption: 1 });
          if (hide && cols === 80) expect(wait.body['screen']).not.toContain('earlier detail');
          for (const line of lines.slice(row, row + extraRows + 1)) expect(wait.body['screen']).toContain(line.text);
        }
        const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1`);
        for (const option of options) expect(snapshot.body['screen']).toContain(option);
      } finally {
        renderer.resize(196, 99);
        await renderer.write('\x1bc' + capture);
      }
    });
  });
});

describe('wrapped lines longer than the reasoning context', () => {
  it('keeps a visible answer in snapshot, lastLines, find and result', async () => {
    const id = await longWrappedLine('long-answer', ` ▪ ${'M'.repeat(30 * 410)}`);
    const plain = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(String(plain.body['screen'])).toContain('MMMM');
    const hidden = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1&lastLines=3`);
    expect(hidden.status).toBe(200);
    expect(String(hidden.body['screen'])).toContain('MMMM');
    expect((hidden.body['lastLines'] as string[]).join('\n')).toContain('MMMM');
    const found = await api(td.port, td.token, `/sessions/${id}/find?pattern=MMMM&hideReasoning=1`);
    expect((found.body['matches'] as unknown[]).length).toBeGreaterThan(0);
    // The answer can span many PTY writes. Its first visible row does not mean
    // the trailing composer has arrived, and the prompt echo is still on screen.
    let trailingScreen = '';
    await eventually(async () => {
      trailingScreen = String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']);
      return trailingScreen.includes('>  Type');
    }, 30_000, 100, 'the trailing composer', () => trailingScreen.slice(-500));
    const result = await api(td.port, td.token, `/sessions/${id}/result`);
    expect(result.body['found'], `result after trailing composer: ${String(result.body['reason'])}`).toBe(true);
    expect((result.body['answer'] as string[]).join('')).toContain('MMMM');
  }, 60_000);

  it('hides visible reasoning whose parent lies beyond the context', async () => {
    const id = await longWrappedLine('long-reasoning', ` │ ${'S'.repeat(30 * 410)}`);
    const plain = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(String(plain.body['screen'])).toContain('SSSS');
    const hidden = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1&lastLines=2`);
    expect(hidden.status).toBe(200);
    expect(String(hidden.body['screen'])).not.toContain('SSSS');
    expect((hidden.body['lastLines'] as string[]).join('\n')).not.toContain('SSSS');
    const found = await api(td.port, td.token, `/sessions/${id}/find?pattern=SSSS&hideReasoning=1`);
    expect(found.body['matches']).toEqual([]);
  }, 60_000);
});

describe('starting a session as an agent', () => {
  it('refuses an agent it has no signature for, and names the ones it has', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], shell: false, agent: 'nobody' },
    });
    expect(started.status).toBe(400);
    expect(String(started.body['error'])).toMatch(/agent must be one of: .*claude.*qoder/);
  });

  it('refuses an agent that is not a string', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, shell: false, agent: 7 },
    });
    expect(started.status).toBe(400);
    expect(String(started.body['error'])).toContain('agent must be a string');
  });

  it('shows the agent in the session list', async () => {
    const id = await replay('qoder-answered-after-reasoning', 'qoder');
    const list = await api(td.port, td.token, '/sessions');
    const sessions = list.body['sessions'] as { id: string; agent: string | null }[];
    expect(sessions.find((s) => s.id === id)?.agent).toBe('qoder');
  });
});

describe('Muse captured turn replay', () => {
  it('reports the swallowed composer and recognises the approval after submission', async () => {
    const names = ['muse-7a-composer-swallowed', 'muse-7b-after-second-enter', 'muse-8a-stage1of3'];
    const files = names.map((name) => path.join(FIXTURES, `${name}.ansi`));
    const script = `const fs = require('fs'); const files = ${JSON.stringify(files)}; const draw = (i) => process.stdout.write('\\x1b[2J\\x1b[H' + fs.readFileSync(files[i], 'utf8')); draw(0); setTimeout(() => draw(1), 5000); setTimeout(() => draw(2), 10000); setInterval(() => {}, 500);`;
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', script], shell: false, agent: 'muse', cols: 120, rows: 34, hold: true },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('Voice input'), 5000);
    const result = await api(td.port, td.token, `/sessions/${id}/result`);
    expect(result.body).toMatchObject({ found: false, reason: 'prompt-typed' });
    const pending = await api(td.port, td.token, `/sessions/${id}/wait?prompt=1&timeout=5000`);
    expect(pending.body).toMatchObject({ matched: false, reason: 'prompt-typed' });
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('Stage 1/3'), 12000);
    const waits = await Promise.all([
      api(td.port, td.token, `/sessions/${id}/wait?regex=Stage%201%2F3&timeout=5000&matchAfterInput=1`),
      api(td.port, td.token, `/sessions/${id}/wait?regex=Stage%201%2F3&timeout=5000&matchAfterInput=1&hideReasoning=1`),
      api(td.port, td.token, `/sessions/${id}/wait?prompt=1&timeout=5000`),
    ]);
    for (const response of waits) expect(response.body).toMatchObject({ matched: true });
  }, 25_000);
});

describe('fail closed', () => {
  it('refuses hideReasoning, a filtered find and a result for a program with no signature', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', "console.log('plain'); setInterval(() => {}, 500)"], shell: false },
    });
    const id = String(started.body['id']);
    for (const route of [
      `/sessions/${id}/snapshot?hideReasoning=1`,
      `/sessions/${id}/snapshot?hideReasoning=1&lastLines=20`,
      `/sessions/${id}/find?pattern=plain&hideReasoning=1`,
      `/sessions/${id}/screenshot`,
      `/sessions/${id}/result`,
    ]) {
      const response = await api(td.port, td.token, route, route.endsWith('/screenshot') ? { method: 'POST', body: { hideReasoning: true } } : {});
      expect(response.status, route).toBe(400);
      expect(String(response.body['error']), route).toMatch(/no agent signature/);
      // Refused, never answered unfiltered.
      expect(response.body['screen'], route).toBeUndefined();
      expect(response.body['matches'], route).toBeUndefined();
    }
  });
});

describe('reading a Qoder screen', () => {
  let id: string;
  beforeAll(async () => {
    id = await replay('qoder-answered-after-reasoning', 'qoder');
  }, 60_000);

  it('hides its Thinking blocks from the snapshot and keeps the rest', async () => {
    const plain = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    expect(String(plain.body['screen'])).toMatch(/^ │ /m);
    const hidden = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1`);
    expect(hidden.status).toBe(200);
    const screen = String(hidden.body['screen']);
    expect(screen).not.toMatch(/^ │ /m);
    expect(screen).not.toMatch(/^ Thinking\s*$/m);
    expect(screen).toMatch(/^\[reasoning hidden: \d+ lines?\]$/m);
    expect(screen).toMatch(/^ ▪ MANGO$/m);
    expect(hidden.body['reasoning']).toMatchObject({ agent: 'qoder', hiddenBlocks: 4 });
  });

  it('hides them from lastLines too', async () => {
    const hidden = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1&lastLines=200`);
    const lines = hidden.body['lastLines'] as string[];
    expect(lines.some((line) => /^ │ /.test(line))).toBe(false);
    expect(lines).toContain(' ▪ MANGO');
  });

  it('searches only what is kept, with the screen own row numbers', async () => {
    const all = await api(td.port, td.token, `/sessions/${id}/find?pattern=${encodeURIComponent('^ │ ')}`);
    expect((all.body['matches'] as unknown[]).length).toBeGreaterThan(0);
    const kept = await api(td.port, td.token, `/sessions/${id}/find?pattern=${encodeURIComponent('^ │ ')}&hideReasoning=1`);
    expect(kept.status).toBe(200);
    expect(kept.body['matches']).toEqual([]);
    const answer = await api(td.port, td.token, `/sessions/${id}/find?pattern=MANGO&hideReasoning=1`);
    const plainAnswer = await api(td.port, td.token, `/sessions/${id}/find?pattern=MANGO`);
    const lastRow = (body: Record<string, unknown>): number => {
      const matches = body['matches'] as { line: number }[];
      return matches[matches.length - 1]!.line;
    };
    expect(lastRow(answer.body)).toBe(lastRow(plainAnswer.body));
  });

  it('returns the answer that ends the latest turn, and nothing else', async () => {
    const result = await api(td.port, td.token, `/sessions/${id}/result`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ found: true, agent: 'qoder', answer: [' ▪ MANGO'] });
  });
});

describe('the hideReasoning flag', () => {
  it('refuses any value but true, false, 1 or 0, on every route that takes it', async () => {
    const id = await replay('qoder-answered-after-reasoning', 'qoder');
    for (const value of ['yes', 'True', 'TRUE', 'on', '', '2']) {
      const flag = `hideReasoning=${encodeURIComponent(value)}`;
      for (const route of [
        `/sessions?${flag}`,
        `/sessions/${id}/snapshot?${flag}`,
        `/sessions/${id}/snapshot?${flag}&lastLines=50`,
        `/sessions/${id}/find?pattern=MANGO&${flag}`,
        `/sessions/${id}/wait?quiet=200&timeout=5000&${flag}`,
      ]) {
        const response = await api(td.port, td.token, route);
        expect(response.status, route).toBe(400);
        expect(String(response.body['error']), route).toContain('hideReasoning must be true or false');
        expect(response.body['screen'], route).toBeUndefined();
      }
      const screenshot = await api(td.port, td.token, `/sessions/${id}/screenshot`, {
        method: 'POST', body: { hideReasoning: value },
      });
      expect(screenshot.status).toBe(400);
      expect(String(screenshot.body['error'])).toContain('hideReasoning must be true or false');
    }
    for (const value of ['true', '1']) {
      const response = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=${value}`);
      expect(response.status).toBe(200);
      expect(String(response.body['screen'])).not.toMatch(/^ │ /m);
    }
    for (const value of ['false', '0']) {
      const response = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=${value}`);
      expect(String(response.body['screen'])).toMatch(/^ │ /m);
    }
  });
});

describe('waiting without the reasoning', () => {
  it('debounces a visible Muse menu while its busy timer keeps painting', async () => {
    const program = [
      "let seconds = 0;",
      "process.stdout.write('  Muse Code 1.4.14\\n\\x1b[38;2;103;108;116m◆ hidden reasoning\\x1b[0m\\n  Stage 1/3\\n◇ Calling tools (0s)\\n');",
      "setInterval(() => { seconds++; process.stdout.write('\\x1b[1A\\r\\x1b[2K◇ Calling tools (' + seconds + 's)\\n'); }, 300);",
    ].join(' ');
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', program], shell: false, agent: 'muse', cols: 100, rows: 20, hold: true },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('Stage 1/3'), 30_000);

    const waited = await api(td.port, td.token, `/sessions/${id}/wait?regex=Stage%201%2F3&debounce=1500&timeout=2600&hideReasoning=1`);
    expect(waited.status).toBe(200);
    expect(waited.body).toMatchObject({ matched: true, reason: 'regex' });
    expect(Number(waited.body['waitedMs'])).toBeGreaterThanOrEqual(1_500);
    expect(Number(waited.body['waitedMs'])).toBeLessThanOrEqual(2_500);
    expect(String(waited.body['screen'])).toContain('Stage 1/3');
    expect(String(waited.body['screen'])).not.toContain('hidden reasoning');
  }, 60_000);

  it('matches text and regex only on the filtered screen', async () => {
    const id = await replay('qoder-answered-after-reasoning', 'qoder');
    const raw = await api(td.port, td.token, `/sessions/${id}/wait?text=Thinking&timeout=0`);
    expect(raw.body).toMatchObject({ matched: true, reason: 'text' });
    for (const condition of ['text=Thinking', 'regex=%5E%20Thinking']) {
      const hidden = await api(td.port, td.token, `/sessions/${id}/wait?${condition}&timeout=250&hideReasoning=1`);
      expect(hidden.status).toBe(200);
      expect(hidden.body).toMatchObject({ matched: false, reason: 'timeout' });
      expect(String(hidden.body['screen'])).not.toContain('Thinking');
    }
    const answer = await api(td.port, td.token, `/sessions/${id}/wait?text=MANGO&timeout=1000&hideReasoning=1`);
    expect(answer.body).toMatchObject({ matched: true, reason: 'text' });
    expect(String(answer.body['screen'])).toContain('MANGO');
  });

  it('does not match a wrapped reasoning continuation', async () => {
    const id = await longWrappedLine('wait-wrapped-reasoning', ` │ ${'S'.repeat(30 * 410)}`);
    const raw = await api(td.port, td.token, `/sessions/${id}/wait?text=SSSS&timeout=0`);
    expect(raw.body['matched']).toBe(true);
    const hidden = await api(td.port, td.token, `/sessions/${id}/wait?regex=SSSS&timeout=250&hideReasoning=1`);
    expect(hidden.body).toMatchObject({ matched: false, reason: 'timeout' });
    expect(String(hidden.body['screen'])).not.toContain('SSSS');
  }, 60_000);

  it('refuses text and regex conditions on a multi-session wait', async () => {
    const id = await replay('qoder-answered-after-reasoning', 'qoder');
    for (const condition of ['text=Thinking', 'regex=MANGO']) {
      const response = await api(td.port, td.token, `/sessions/wait?session=${id}&${condition}&timeout=0&hideReasoning=1`);
      expect(response.status).toBe(400);
      expect(String(response.body['error'])).toContain('A multi-session wait needs prompt=true');
      expect(response.body['screen']).toBeUndefined();
    }
  });

  it('returns the screen it waited for with the reasoning left out', async () => {
    const id = await replay('qoder-answered-after-reasoning', 'qoder');
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?quiet=300&timeout=20000&hideReasoning=1`);
    expect(waited.status).toBe(200);
    expect(waited.body['matched']).toBe(true);
    expect(String(waited.body['screen'])).not.toMatch(/^ │ /m);
    expect(String(waited.body['screen'])).toMatch(/^ ▪ MANGO$/m);
    expect(waited.body['reasoning']).toMatchObject({ agent: 'qoder' });
  });

  it('does not report a question that the filtered screen hid', async () => {
    const question = 'Could I reveal the velvet zeppelin secret?';
    const original = fs.readFileSync(path.join(FIXTURES, 'qoder-answered-after-reasoning.ansi'), 'utf8');
    const fixture = path.join(td.home, 'hidden-question.ansi');
    fs.writeFileSync(fixture, original.replace('The xxxx xxxxx xx to reason', question));
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8')); setInterval(() => {}, 500)`],
        shell: false, agent: 'qoder', cols: 194, rows: 101, hold: true,
      },
    });
    const id = String(started.body['id']);
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes(question), 30_000);
    const hidden = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1`);
    expect(String(hidden.body['screen'])).not.toContain(question);

    // Exercise the screen callback passed by the HTTP route to the waiter.
    // The question hidden by that callback cannot satisfy a prompt wait.
    const daemon = td.daemon as unknown as { manager: { get(id: string): { waitFor: (condition: unknown, options: { screenForMatch?: () => string }) => Promise<unknown> } } };
    const session = daemon.manager.get(id);
    const originalWait = session.waitFor;
    session.waitFor = (_condition, options) => {
      const screen = options.screenForMatch?.();
      if (screen === undefined) return Promise.resolve({ matched: true, reason: 'prompt', waitedMs: 0, screen: question });
      return Promise.resolve({ matched: false, reason: 'timeout', waitedMs: 0, screen });
    };
    try {
      const waited = await api(td.port, td.token, `/sessions/${id}/wait?prompt=1&hideReasoning=1`);
      expect(waited.status).toBe(200);
      expect(waited.body['matched']).toBe(false);
      expect(String(waited.body['screen'])).not.toContain(question);
      expect(waited.body['prompt']).toBeUndefined();
    } finally {
      session.waitFor = originalWait;
    }
  });

  it('returns a visible filtered prompt on the screen that satisfied the wait', async () => {
    const file = path.join(__dirname, '..', 'fixtures', 'dialogs', 'mimo-question-menu.txt');
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8')); setInterval(() => {}, 500)`],
        shell: false, agent: 'mimo', cols: 100, rows: 30, hold: true,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?prompt=1&debounce=200&timeout=15000&hideReasoning=1`);
    expect(waited.status).toBe(200);
    expect(waited.body).toMatchObject({ matched: true, reason: 'prompt' });
    expect(String(waited.body['screen'])).toContain('Which of these should the build use for the');
    expect((waited.body['prompt'] as { question: string }).question).toContain('Which of these should the build use for the');
  }, 30_000);

  it('refuses before waiting when the program has no signature', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], shell: false },
    });
    const id = String(started.body['id']);
    const begun = Date.now();
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?quiet=60000&timeout=60000&hideReasoning=1`);
    expect(waited.status).toBe(400);
    expect(Date.now() - begun).toBeLessThan(10_000);
  });
});

describe('a filtered screen stays self-consistent', () => {
  it('puts the cursor on a row of the screen it returns', async () => {
    const id = await replay('qoder-answered-after-reasoning', 'qoder');
    const hidden = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=1`);
    const rows = String(hidden.body['screen']).split('\n').length;
    const cursor = hidden.body['cursor'] as { x: number; y: number };
    expect(cursor.y).toBeLessThan(Math.max(rows, 1) + 1);
  });

  it('never reports a hidden row from find, whatever the pattern matches', async () => {
    const id = await replay('qoder-answered-after-reasoning', 'qoder');
    const bars = await api(td.port, td.token, `/sessions/${id}/find?pattern=${encodeURIComponent('^ │ ')}`);
    const hiddenRows = new Set((bars.body['matches'] as { line: number }[]).map((m) => m.line));
    expect(hiddenRows.size).toBeGreaterThan(0);
    const any = await api(td.port, td.token, `/sessions/${id}/find?pattern=${encodeURIComponent('.?')}&hideReasoning=1`);
    const rows = (any.body['matches'] as { line: number }[]).map((m) => m.line);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => hiddenRows.has(row))).toBe(false);
  });
});

describe('reading a busy screen', () => {
  it('says the agent is still working and returns no answer', async () => {
    const id = await replay('codex-working', 'codex');
    const result = await api(td.port, td.token, `/sessions/${id}/result`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ found: false, reason: 'busy' });
    expect(result.body['answer']).toBeUndefined();
  });
});
