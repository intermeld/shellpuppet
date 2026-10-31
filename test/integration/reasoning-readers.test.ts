/**
 * The readers that leave an agent's reasoning out (`reasoning.ts`), end to
 * end through the daemon: a session replays a screen captured from a real
 * agent CLI through a real PTY, and `hideReasoning` and `terminal_result` read
 * it. Both fail closed, so the refusals are pinned as carefully as the reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
async function replay(name: string, agent?: string): Promise<string> {
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
  // The replay is drawn once it is on screen: wait for its composer.
  await eventually(async () => {
    const snap = await api(td.port, td.token, `/sessions/${id}/snapshot`);
    return /Type your message|\? for shortcuts|Ask Codex/.test(String(snap.body['screen']));
  }, 30_000);
  return id;
}

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

    // Supply a waiter result that carries a question from the raw screen.
    // The HTTP route must derive what it reports from the filtered screen.
    const daemon = td.daemon as unknown as { manager: { get(id: string): { waitFor: (condition: unknown, options: unknown) => Promise<unknown> } } };
    const session = daemon.manager.get(id);
    const originalWait = session.waitFor;
    session.waitFor = () => Promise.resolve({ matched: true, reason: 'prompt', waitedMs: 0, screen: question, prompt: { question, options: ['1. Reveal secret'], signature: question } });
    try {
      const waited = await api(td.port, td.token, `/sessions/${id}/wait?prompt=1&hideReasoning=1`);
      expect(waited.status).toBe(200);
      expect(String(waited.body['screen'])).not.toContain(question);
      expect(waited.body['prompt']).toBeUndefined();
    } finally {
      session.waitFor = originalWait;
    }
  });

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
