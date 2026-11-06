import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as http from 'node:http';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseLauncher } from '../../src/daemon/launchProfiles.js';
import { Session } from '../../src/core/session.js';
import { api, eventually, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const fixture = path.join(repoRoot, 'test', 'fixtures', 'start-ready.mjs');
const exec = promisify(execFile);
let td: TestDaemon;
let client: Client;
let dashboardUrl = '';
let duringViewerOpening: (() => Promise<void>) | undefined;

function start(mode: string, extra: Record<string, unknown> = {}) {
  return api(td.port, td.token, '/sessions', { body: {
    command: process.execPath, args: [fixture, mode], cwd: repoRoot,
    shell: false, openViewer: false, waitReady: true, readyText: 'READY from stand-in', readyTimeout: 8000, ...extra,
  } });
}

function toolText(result: unknown): string {
  return ((result as { content: { text?: string }[] }).content).map(item => item.text ?? '').join('\n');
}

function navigate(url: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

async function cli(mode: string, ...args: string[]) {
  return exec(process.execPath, [path.join(repoRoot, 'dist', 'cli', 'index.js'), 'start', '--no-viewer', '--no-shell', ...args, process.execPath, fixture, mode],
    { cwd: repoRoot, env: { ...process.env, SHELLPUPPET_HOME: td.home }, timeout: 20_000, windowsHide: true });
}

beforeAll(async () => {
  const parsed = parseLauncher({ profiles: [{ name: 'delegate', command: process.execPath,
    args: [fixture, 'never'], cwd: repoRoot, shell: false, agent: 'codex', readyText: 'READY from stand-in' }] }, new Set(['codex']));
  expect(parsed.problems).toEqual([]);
  td = await startTestDaemon({ launchProfiles: parsed.launcher, launcher: async url => {
    dashboardUrl = url;
    await duringViewerOpening?.();
    return { launched: true, mode: 'isolated-app' };
  } });
  client = new Client({ name: 'startup-tests', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(repoRoot, 'dist', 'mcp', 'index.js')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SHELLPUPPET_HOME: td.home },
    stderr: 'pipe',
  }));
});

afterEach(async () => {
  duringViewerOpening = undefined;
  vi.restoreAllMocks();
  const listed = await api(td.port, td.token, '/sessions');
  for (const session of listed.body['sessions'] as { id: string; exited: boolean }[]) {
    if (!session.exited) {
      await api(td.port, td.token, `/sessions/${session.id}/key`, { body: { key: 'ctrl+c' } });
      await eventually(async () => (await api(td.port, td.token, `/sessions/${session.id}/snapshot`)).body['exited'] === true, 10_000);
    }
    await api(td.port, td.token, `/sessions/${session.id}`, { method: 'DELETE' });
  }
});

afterAll(async () => { await client?.close(); await td?.stop(); });

describe('opt-in startup readiness', () => {
  it('returns the session id before the default MCP client timeout for a never-ready programme', async () => {
    // No SDK request options: exercise its bundled default call budget.
    const result = await client.callTool({ name: 'terminal_start', arguments: {
      command: process.execPath, args: [fixture, 'never'], shell: false, cwd: repoRoot,
      waitReady: true, readyText: 'READY from stand-in', label: 'slow startup',
    } });
    expect(result.isError).not.toBe(true);
    const text = toolText(result);
    expect(text).toContain('Started, not ready yet:');
    const id = /Session (\S+) started/.exec(text)?.[1];
    expect(id).toBeDefined();
    const listed = toolText(await client.callTool({ name: 'terminal_list' }));
    expect(listed).toContain(id!);
    expect((await api(td.port, td.token, '/sessions')).body['sessions']).toEqual([
      expect.objectContaining({ id, ready: false, readyReason: 'pending', exited: false }),
    ]);
  }, 75_000);

  it('cancels only its MCP start polling and leaves both sessions running and tracked', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the session as this below.
    const original = Session.prototype.waitUntilReady;
    const finished = new Map<string, string>();
    const begun = new Map<string, string>();
    vi.spyOn(Session.prototype, 'waitUntilReady').mockImplementation(async function (this: Session, timeout, signal) {
      begun.set(this.label, this.id);
      const result = await original.call(this, timeout, signal);
      finished.set(this.label, result.reason);
      return result;
    });
    const abort = new AbortController();
    const cancelled = client.callTool({ name: 'terminal_start', arguments: {
      command: process.execPath, args: [fixture, 'never'], shell: false, cwd: repoRoot,
      waitReady: true, readyText: 'READY from stand-in', readyTimeout: 10_000, label: 'cancelled startup',
    } }, undefined, { signal: abort.signal }).then(() => 'answered', () => 'cancelled');
    const other = start('never', { label: 'other startup' });
    await eventually(() => begun.size === 2, 5000);
    abort.abort();
    expect(await cancelled).toBe('cancelled');
    try {
      await eventually(() => finished.get('cancelled startup') === 'aborted', 3000);
      expect(finished.has('other startup')).toBe(false);
      const listed = (await api(td.port, td.token, '/sessions')).body['sessions'] as { exited: boolean; readyReason: string }[];
      expect(listed).toHaveLength(2);
      expect(listed.every(s => !s.exited && s.readyReason === 'pending')).toBe(true);
    } finally {
      // Finish the other call even when a cancellation assertion fails.
      for (const id of begun.values()) await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'r' } });
      await other;
    }
    expect(finished.get('other startup')).toBe('condition-met');
    await eventually(async () => {
      const listed = (await api(td.port, td.token, '/sessions')).body['sessions'] as { readyReason: string }[];
      return listed.every(s => s.readyReason === 'condition-met');
    }, 5000);
  });

  it('returns pending when a question replaces latched readiness during viewer opening', async () => {
    duringViewerOpening = async () => {
      let id = '';
      await eventually(async () => {
        const sessions = (await api(td.port, td.token, '/sessions')).body['sessions'] as { id: string; ready: boolean }[];
        id = sessions[0]?.id ?? '';
        return sessions[0]?.ready === true;
      }, 5000);
      await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'p' } });
      await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('Continue?'), 5000);
    };
    const result = await start('ready-question', { openViewer: true });
    expect(result.body).toMatchObject({ ready: false, readyReason: 'pending', readyWait: {
      reason: 'prompt', prompt: { question: 'Continue? (y/n)' },
    } });
    const id = String(result.body['id']);
    expect((await api(td.port, td.token, '/sessions')).body['sessions']).toEqual([
      expect.objectContaining({ id, ready: false, readyReason: 'pending' }),
    ]);
    await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'r' } });
    await eventually(async () => {
      const listed = (await api(td.port, td.token, '/sessions')).body['sessions'] as { readyReason: string }[];
      return listed[0]?.readyReason === 'condition-met';
    }, 5000);
  });

  it('reports ended readiness tracking in MCP and CLI timeout messages', async () => {
    // Supply the daemon response state at the tracking deadline without a
    // five-minute wall-clock wait; the core test exercises that deadline.
    vi.spyOn(Session.prototype, 'readyReason', 'get').mockReturnValue('never-held');
    const result = await client.callTool({ name: 'terminal_start', arguments: {
      command: process.execPath, args: [fixture, 'never'], shell: false, cwd: repoRoot,
      waitReady: true, readyText: 'READY from stand-in', readyTimeout: 0,
    } });
    const output = await cli('never', '--wait-ready', '--ready-text', 'READY from stand-in', '--ready-timeout', '0');
    for (const text of [toolText(result), output.stdout]) {
      expect(text).toContain('Started, not ready yet:');
      expect(text).toContain('Readiness tracking has ended');
      expect(text).not.toContain('still tracked');
    }
  });

  it('waits for a delayed line and uses the resolved module when no override is given', async () => {
    const explicit = await start('ready');
    expect(explicit.status).toBe(200);
    expect(explicit.body).toMatchObject({ ready: true, readyReason: 'condition-met', exited: false, readyWait: { reason: 'condition-met' } });
    expect((await api(td.port, td.token, `/sessions/${String(explicit.body['id'])}/snapshot`)).body['screen']).toContain('READY from stand-in');
    const module = await start('module', { agent: 'codex', readyText: undefined });
    expect(module.body).toMatchObject({ readyReason: 'condition-met', readyWait: { reason: 'condition-met' } });
  });

  it('uses caller text and quiet instead of module defaults', async () => {
    for (const override of [{ readyText: 'READY from stand-in' }, { readyText: undefined, readyQuiet: 160 }]) {
      const result = await start('ready', { agent: 'codex', ...override });
      expect(result.body).toMatchObject({ readyReason: 'condition-met', readyWait: { reason: 'condition-met' } });
    }
  });

  it.each(['question', 'dialog'])('returns the recognised %s before the limit, naming what needs an answer', async mode => {
    const result = await start(mode, { args: [fixture, mode, '200', path.join(repoRoot, 'test', 'fixtures', 'dialogs', 'opencode-permission-dialog.txt')], cols: 80, rows: 40 });
    expect(result.body).toMatchObject({ ready: false, readyReason: 'pending', readyWait: { reason: 'prompt' } });
    const wait = result.body['readyWait'] as { waitedMs: number; prompt: { question: string; options: string[] } };
    expect(wait.waitedMs).toBeLessThan(8000);
    expect(wait.prompt.question).toContain(mode === 'question' ? 'trust the files' : 'Permission required');
    expect(wait.prompt.options.length).toBeGreaterThan(0);
  });

  it('reports a programme that exits while readiness is pending', async () => {
    const result = await start('exit');
    expect(result.body).toMatchObject({ ready: false, exited: true, exitCode: 7, readyWait: { reason: 'exited' } });
  });

  it('times out with a running session, then tracks readiness when it arrives later', async () => {
    const result = await start('never', { readyTimeout: 160 });
    expect(result.body).toMatchObject({ ready: false, readyReason: 'pending', exited: false, readyWait: { reason: 'timeout' } });
    const id = String(result.body['id']);
    expect((await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'r' } })).status).toBe(200);
    await eventually(async () => {
      const listed = await api(td.port, td.token, '/sessions');
      return (listed.body['sessions'] as { id: string; readyReason: string }[]).some(s => s.id === id && s.readyReason === 'condition-met');
    }, 5000);
  });

  it('refuses a missing condition and invalid wait fields before creating a session', async () => {
    for (const extra of [{ readyText: undefined }, { waitReady: 'true' }, { readyTimeout: -1 }, { readyTimeout: 'slow' }]) {
      const result = await start('never', extra);
      expect(result.status).toBe(400);
      expect(result.body['error']).toMatch(/readyText or readyQuiet|waitReady|readyTimeout/);
    }
    expect((await api(td.port, td.token, '/sessions')).body['sessions']).toEqual([]);
  });

  it('returns without the switch, preserving both untracked and explicit tracking behaviour', async () => {
    const wait = vi.spyOn(Session.prototype, 'waitUntilReady');
    const untracked = await start('never', { waitReady: undefined, agent: 'codex', readyText: undefined });
    expect(untracked.body).toMatchObject({ ready: true, readyReason: 'not-tracked' });
    expect(untracked.body['readyWait']).toBeUndefined();
    const tracked = await start('never', { waitReady: false, agent: 'codex' });
    expect(tracked.body).toMatchObject({ ready: false, readyReason: 'pending' });
    expect(tracked.body['readyWait']).toBeUndefined();
    expect(wait).not.toHaveBeenCalled();
  });

  it('keeps profile launches immediate and refuses readiness switches on the human route', async () => {
    const wait = vi.spyOn(Session.prototype, 'waitUntilReady');
    for (const field of ['waitReady', 'readyTimeout']) {
      expect(parseLauncher({ profiles: [{ name: 'bad', command: 'node', [field]: true }] }, new Set()).launcher.profiles).toEqual([]);
    }
    await api(td.port, td.token, '/dashboard/open', { body: {} });
    const navigation = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
    const redeemed = await navigate(dashboardUrl, navigation);
    const cookie = redeemed.headers['set-cookie']![0]!.split(';')[0]!;
    const origin = `http://127.0.0.1:${String(td.port)}`;
    const page = await navigate(`${origin}/dashboard`, { ...navigation, cookie });
    const proof = /name="sp-csrf" content="([^"]+)"/.exec(page.body)![1]!;
    const headers = { cookie, origin, 'x-shellpuppet-csrf': proof, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };
    const refused = await api(td.port, null, '/dashboard/launch', { headers, body: { profile: 'delegate', waitReady: true } });
    expect(refused.status).toBe(400);
    const launched = await api(td.port, null, '/dashboard/launch', { headers, body: { profile: 'delegate' } });
    expect(launched.status).toBe(200);
    const listed = await api(td.port, td.token, '/sessions');
    expect(listed.body['sessions']).toEqual([expect.objectContaining({ agent: 'codex', ready: false, readyReason: 'pending' })]);
    expect(launched.body['readyWait']).toBeUndefined();
    expect(wait).not.toHaveBeenCalled();
  });

  it('carries the CLI switch and limit and prints ready and timeout outcomes', async () => {
    const ready = await cli('ready', '--wait-ready', '--ready-text', 'READY from stand-in', '--ready-timeout', '8000');
    expect(ready.stdout).toContain('Started and ready:');
    const timeout = await cli('never', '--wait-ready', '--ready-text', 'missing', '--ready-timeout', '0', '--json');
    expect(JSON.parse(timeout.stdout)).toMatchObject({ readyReason: 'pending', readyWait: { reason: 'timeout' }, exited: false });
    const text = await cli('never', '--wait-ready', '--ready-text', 'missing', '--ready-timeout', '0');
    expect(text.stdout).toContain('Started, not ready yet:');
    for (const [mode, expected] of [['question', 'Do you trust the files'], ['exit', 'then exited (code 7)']] as const) {
      expect((await cli(mode, '--wait-ready', '--ready-text', 'missing', '--ready-timeout', '8000')).stdout).toContain(expected);
    }
    await expect(cli('never', '--wait-ready')).rejects.toMatchObject({ code: 2 });
  });

  it('describes the MCP switch and returns all outcomes with questions framed as untrusted data', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(item => item.name === 'terminal_start')!;
    expect(tool.description).toContain('waitReady:true when starting an agent CLI to delegate work to');
    expect((tool.inputSchema.properties!['waitReady'] as { description: string }).description).toContain('delegate work');
    for (const [mode, expected, timeout] of [['ready', 'Started and ready:', 8000], ['question', 'waiting for an answer', 8000], ['exit', 'then exited (code 7)', 8000], ['never', 'Started, not ready yet:', 0]] as const) {
      const result = await client.callTool({ name: 'terminal_start', arguments: {
        command: process.execPath, args: [fixture, mode], shell: false, cwd: repoRoot,
        waitReady: true, readyText: 'READY from stand-in', readyTimeout: timeout,
      } });
      const text = toolText(result);
      expect(text).toContain(expected);
      if (mode === 'question') {
        expect(text).toMatch(/UNTRUSTED DATA[\s\S]*Do you trust the files[\s\S]*end of screen content/);
        expect(text.match(/--- screen content below:/g)).toHaveLength(1);
      }
    }
    const refused = await client.callTool({ name: 'terminal_start', arguments: {
      command: process.execPath, args: [fixture, 'never'], shell: false, cwd: repoRoot, waitReady: true,
    } });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain('readyText or readyQuiet');
  });
});
