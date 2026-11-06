import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleFor, programName } from '../../src/agents/index.js';
import { useAgentSignatures } from '../../src/core/reasoning.js';
import { api, eventually, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let td: TestDaemon;
const starts: { id: string | undefined; agent: unknown }[] = [];
beforeAll(async () => {
  td = await startTestDaemon({
    promptScanIntervalMs: 50,
    audit: { captureContent: false, record: (_actor, action, id, meta) => {
      if (action === 'start') starts.push({ id, agent: meta?.['agent'] });
    } },
  });
});
afterAll(async () => {
  useAgentSignatures([]);
  await td.stop();
}, 180_000);

describe('resolved agent through the daemon', () => {
  it('uses a configured program match in the list, audit and reader', async () => {
    const reading = moduleFor('muse')!.reading;
    // Replay a capture with Node. No agent CLI is started.
    useAgentSignatures([{ ...reading, programs: [programName(process.execPath)] }]);
    const root = path.join(repoRoot, 'test', 'fixtures', 'reasoning', 'muse-trust');
    const size = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8')) as { cols: number; rows: number };
    try {
      const started = await api(td.port, td.token, '/sessions', { body: {
        command: process.execPath, shell: false, cols: size.cols, rows: size.rows,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(`${root}.ansi`)}, 'utf8')); setInterval(() => {}, 500)`],
      } });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const id = String(started.body['id']);
      expect(Number(started.body['pid'])).toBeGreaterThan(0);
      expect(starts).toContainEqual({ id, agent: 'muse' });
      const listed = await api(td.port, td.token, '/sessions');
      expect(listed.body['sessions']).toEqual(expect.arrayContaining([expect.objectContaining({ id, agent: 'muse' })]));
      await eventually(async () => {
        const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=true`);
        return snapshot.status === 200 && String(snapshot.body['screen']).includes('Do you trust this workspace?');
      }, 20_000);
      const read = await api(td.port, td.token, `/sessions/${id}/snapshot?hideReasoning=true`);
      expect(read.body['reasoning']).toMatchObject({ agent: 'muse' });
    } finally {
      useAgentSignatures([]);
    }
  });

  it('supervises a child process dialog forwarded through known and generic sessions', async () => {
    const fixture = path.join(repoRoot, 'test', 'fixtures');
    const childArgs = [path.join(fixture, 'dialog-sink.mjs'), path.join(fixture, 'dialogs', 'opencode-permission-dialog.txt'), path.join(fixture, 'dialogs', 'opencode-permission-answered.txt')];
    const args = ['-e', `const child = require('node:child_process').spawn(process.execPath, ${JSON.stringify(childArgs)}, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.on('exit', code => process.exit(code ?? 1));`];
    const ids: string[] = [];
    for (const agent of ['codex', undefined]) {
      const started = await api(td.port, td.token, '/sessions', { body: {
        command: process.execPath, args, shell: false, cols: 80, rows: 40,
        ...(agent === undefined ? {} : { agent }),
      } });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const id = String(started.body['id']);
      ids.push(id);
      expect(starts).toContainEqual({ id, agent: agent ?? 'generic' });
      await eventually(async () => {
        const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
        return String(snapshot.body['screen']).includes('Permission required');
      }, 20_000);
    }
    const known = await api(td.port, td.token, `/sessions/${ids[0]!}/wait?prompt=true&timeout=5000`);
    expect(known.body).toMatchObject({ matched: true, reason: 'prompt', prompt: { options: ['Allow once', 'Always allow', 'Reject'] } });
    const generic = await api(td.port, td.token, `/sessions/${ids[1]!}/wait?prompt=true&timeout=5000`);
    expect(generic.body).toMatchObject({ matched: true, reason: 'prompt' });
    // The compact list is published by the periodic prompt scan.
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions?waitingOnly=true');
      const sessions = listed.body['sessions'] as { id: string }[];
      return ids.every(id => sessions.some(session => session.id === id));
    }, 5_000);
    const waiting = await api(td.port, td.token, '/sessions?waitingOnly=true');
    expect(waiting.body['sessions']).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids[1] })]));
    expect(waiting.body['sessions']).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids[0] })]));
  });

  it('refuses filtered reads of an unmatched program when a configured reading is named generic', async () => {
    expect(useAgentSignatures([{
      name: 'generic', programs: ['plain-wrapper'],
      composer: { text: '^> ' }, answer: { start: { text: '^ANSWER:' } },
    }])).toEqual([]);
    const root = path.join(repoRoot, 'test', 'fixtures', 'reasoning', 'qoder-thinking-second-turn');
    const size = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8')) as { cols: number; rows: number };
    try {
      const started = await api(td.port, td.token, '/sessions', { body: {
        command: process.execPath, shell: false, cols: size.cols, rows: size.rows,
        args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(`${root}.ansi`)}, 'utf8')); setInterval(() => {}, 500)`],
      } });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const id = String(started.body['id']);
      expect(starts).toContainEqual({ id, agent: 'generic' });
      await eventually(async () => {
        const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
        return String(snapshot.body['screen']).includes('Thinking');
      }, 20_000);
      const statuses: Record<string, number> = {};
      for (const endpoint of [
        'snapshot?hideReasoning=true', 'snapshot?hideReasoning=true&lastLines=200',
        'find?hideReasoning=true&pattern=Thinking', 'wait?hideReasoning=true&text=Thinking&timeout=150', 'result',
      ]) {
        statuses[endpoint] = (await api(td.port, td.token, `/sessions/${id}/${endpoint}`)).status;
      }
      expect(statuses).toEqual({
        'snapshot?hideReasoning=true': 400,
        'snapshot?hideReasoning=true&lastLines=200': 400,
        'find?hideReasoning=true&pattern=Thinking': 400,
        'wait?hideReasoning=true&text=Thinking&timeout=150': 400,
        result: 400,
      });
    } finally {
      useAgentSignatures([]);
    }
  });
});
