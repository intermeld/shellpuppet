import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connectWs, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon, WsClient } from './helpers.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../../src/mcp/tools.js';
import type { SessionManager } from '../../src/core/manager.js';
import { stallDiagnostics } from './stall-diagnostics.js';

const run = promisify(execFile);
let td: TestDaemon;
let id: string;
let viewer: WsClient;
let events: WebSocket;
const messages: Record<string, unknown>[] = [];
const warnings: unknown[] = [];
const stall = { reason: 'provider-refused', description: 'The model provider refused the turn.' };
async function listed(): Promise<Record<string, unknown>> {
  const result = await api(td.port, td.token, '/sessions?hideReasoning=true');
  return (result.body['sessions'] as Record<string, unknown>[]).find(session => session['id'] === id)!;
}
async function cli(args: string[]) {
  return run(process.execPath, [path.join(repoRoot, 'dist/cli/index.js'), ...args], {
    env: { ...process.env, SHELLPUPPET_HOME: td.home }, windowsHide: true,
  });
}
beforeAll(async () => {
  const home = makeTempHome('stalled-sessions-');
  td = await startTestDaemon({ home, audit: createAuditor(home), promptScanIntervalMs: 50, logger: { ...NULL_LOGGER, warn: (message, meta) => warnings.push({ message, meta }) } });
  events = new WebSocket(`ws://127.0.0.1:${td.port}/events?token=${td.token}`);
  events.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
  const started = await api(td.port, td.token, '/sessions', {
    body: { command: process.execPath, args: [path.join(repoRoot, 'test/fixtures/stalled-screen.mjs')], shell: false, agent: 'mimo', cols: 120, rows: 30 },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  id = String(started.body['id']);
  // Record exactly the program this test owns, for cleanup diagnostics.
  fs.writeFileSync(path.join(td.home, 'fixture-pid.json'), JSON.stringify({ pid: started.body['pid'], id }));
  viewer = await connectWs(td.port, id, td.token);
  await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('✗ Error'));
  await new Promise(resolve => setTimeout(resolve, 1500));
});
afterAll(async () => { viewer?.close(); events?.close(); await td?.stop(); }, 180_000);

describe('provider stall supervision', () => {
  it('lists a settled stall with fixed metadata and a since time', async () => {
    const session = await listed();
    expect(session['stalled']).toMatchObject(stall);
    expect((session['stalled'] as { since: string }).since).toMatch(/^\d{4}-/);
    const output = await cli(['list']);
    expect(output.stdout).toContain('STALLED provider-refused since ');
    expect(JSON.stringify(session['stalled'])).not.toContain('content safety filter');
  });
  it('returns wait --stalled and the combined wait with the condition named', async () => {
    const output = await cli(['wait', id, '--stalled', '--timeout', '2000', '--json']);
    expect(JSON.parse(output.stdout)).toMatchObject({ matched: true, reason: 'stalled', stalled: stall });
    const combined = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&stalled=true&hideReasoning=true&timeout=1000`);
    expect(combined.body).toMatchObject({ matched: true, reason: 'stalled', stalled: stall, screen: '' });
  });
  it('keeps bare prompt waits restricted to prompts', async () => {
    expect((await listed())['stalled']).toMatchObject(stall);
    const result = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=150`);
    expect(result.body).toMatchObject({ matched: false, reason: 'timeout' });
    const multi = await api(td.port, td.token, `/sessions/wait?prompt=true&session=${id}&now=true`);
    expect(multi.body).toMatchObject({ matched: false, reason: 'timeout', sessions: [] });
  });
  it('supports a multi-session stall condition without returning screen text', async () => {
    const result = await cli(['wait', '--prompt', '--stalled', id, '--now', '--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({ matched: true, reason: 'stalled', sessions: [{ id, reason: 'stalled', stalled: stall }] });
    expect(result.stdout).not.toContain('content safety filter');
  });
  it('exposes the stall condition and fixed metadata through the MCP tools', async () => {
    const server = new McpServer({ name: 'stall-test', version: '0.0.0' });
    registerTools(server, { home: td.home });
    const client = new Client({ name: 'stall-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const args of [{ session: id, stalled: true }, { session: [id], stalled: true, prompt: true, now: true }]) {
        const result = await client.callTool({ name: 'terminal_wait', arguments: { ...args, hideReasoning: true, timeout: 1500 } });
        expect(result.isError).not.toBe(true);
        const text = JSON.stringify(result.content);
        expect(text).toContain('Matched (stalled)');
        expect(text).toContain('STALLED provider-refused since ');
        expect(text).not.toContain('content safety filter');
      }
      const result = await client.callTool({ name: 'terminal_list', arguments: { hideReasoning: true } });
      expect(JSON.stringify(result.content)).toContain('STALLED provider-refused since ');
    } finally { await client.close(); await server.close(); }
  });
  it('emits one event, audit record and warning and informs a late viewer', async () => {
    expect((await listed())['stalled']).toMatchObject(stall);
    expect(messages.filter(message => message['type'] === 'session-stalled')).toHaveLength(1);
    expect(messages.find(message => message['type'] === 'session-stalled')).toMatchObject({ session: id, stalled: stall });
    expect(warnings.filter(value => JSON.stringify(value).includes('session stalled'))).toHaveLength(1);
    const late = await connectWs(td.port, id, td.token);
    try {
      expect(await late.waitForControl(control => control['type'] === 'session-stalled')).toMatchObject({ stalled: stall });
    } finally { late.close(); }
    const audit = fs.readFileSync(path.join(td.home, 'audit.log'), 'utf8');
    expect(audit.split('\n').filter(line => line.includes('"session-stalled"'))).toHaveLength(1);
    expect(audit).not.toContain('content safety filter');
  });
  it('keeps the stall when a viewer sends an automatic terminal report', async () => {
    expect((await listed())['stalled']).toMatchObject(stall);
    viewer.ws.send('\x1b[I');
    await eventually(() => fs.readFileSync(path.join(td.home, 'audit.log'), 'utf8').includes('"report"'));
    expect((await listed())['stalled']).toMatchObject(stall);
  });
  it('preserves the stall, waits and event count after a zero-byte input', async () => {
    const before = (await listed())['stalled'];
    expect(before).toMatchObject(stall);
    const result = await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: '' } });
    expect(result.body).toMatchObject({ ok: true, bytes: 0 });
    expect((await listed())['stalled']).toEqual(before);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?stalled=true&timeout=0`);
    expect(waited.body).toMatchObject({ matched: true, reason: 'stalled', stalled: before });
    expect(messages.filter(message => message['type'] === 'session-stalled')).toHaveLength(1);
  });
  it('preserves the stall and event count through resize reflow at the 80x24 floor', async () => {
    const before = (await listed())['stalled'];
    expect(before).toMatchObject(stall);
    for (const [cols, rows] of [[80, 24], [120, 30]]) {
      const result = await api(td.port, td.token, `/sessions/${id}/resize`, { body: { cols, rows } });
      expect(result.status).toBe(200);
      expect((await listed())['stalled']).toEqual(before);
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect((await listed())['stalled']).toEqual(before);
    }
    expect(messages.filter(message => message['type'] === 'session-stalled')).toHaveLength(1);
  });
  it('clears immediately on input, stays clear while busy and can notice a new stall', async () => {
    expect((await listed())['stalled']).toMatchObject(stall);
    await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'b' } });
    expect((await listed())['stalled']).toBeUndefined();
    await eventually(async () => String((await api(td.port, td.token, `/sessions/${id}/snapshot`)).body['screen']).includes('Thinking'));
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect((await listed())['stalled']).toBeUndefined();
    for (const hide of ['false', 'true']) {
      const timed = await api(td.port, td.token, `/sessions/${id}/wait?stalled=true&hideReasoning=${hide}&timeout=0`);
      expect(timed.body).toMatchObject({ matched: false, reason: 'timeout', screen: '' });
    }
    expect(messages.filter(message => message['type'] === 'session-stall-clear')).toHaveLength(1);
    await viewer.waitForControl(control => control['type'] === 'session-stall-clear');
    await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'r' } });
    await eventually(async () => (await listed())['stalled'] !== undefined);
    expect(messages.filter(message => message['type'] === 'session-stalled')).toHaveLength(2);
  });
  it('announces a native refusal once through recovery repaints and suppresses it after input', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [path.join(repoRoot, 'test/fixtures/stalled-screen.mjs'), '--toggle-recovery'],
        shell: false, agent: 'mimo', cols: 120, rows: 30 },
    });
    expect(started.status).toBe(200);
    const toggleId = String(started.body['id']);
    fs.writeFileSync(path.join(td.home, 'toggle-fixture-pid.json'), JSON.stringify({ pid: started.body['pid'], id: toggleId }));
    const state = async () => {
      const result = await api(td.port, td.token, '/sessions');
      return (result.body['sessions'] as Record<string, unknown>[]).find(session => session['id'] === toggleId)?.['stalled'];
    };
    await eventually(async () => await state() !== undefined);
    const before = await state();
    await new Promise(resolve => setTimeout(resolve, 3400));
    expect(await state()).toEqual(before);
    expect(messages.filter(message => message['type'] === 'session-stalled' && message['session'] === toggleId)).toHaveLength(1);
    await api(td.port, td.token, `/sessions/${toggleId}/input`, { body: { data: 'x' } });
    await new Promise(resolve => setTimeout(resolve, 3400));
    expect(await state()).toBeUndefined();
    expect(messages.filter(message => message['type'] === 'session-stalled' && message['session'] === toggleId)).toHaveLength(1);
  });
  it.each(['neutral', 'colon'])('keeps one native %s notice and its since through clipped context, repaints and growth', async (prompt) => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [path.join(repoRoot, 'test/fixtures/clipped-stalled-screen.mjs'), ...(prompt === 'colon' ? ['--colon'] : []),
        ...(process.env['SP_STALL_CHUNK_DELAYS'] === '1' ? ['--chunk-delays'] : [])],
        shell: false, agent: 'mimo', cols: 120, rows: 30 },
    });
    expect(started.status).toBe(200);
    const clippedId = String(started.body['id']);
    const manager = (td.daemon as unknown as { manager: SessionManager }).manager;
    const diagnostics = stallDiagnostics(manager.get(clippedId)!);
    fs.writeFileSync(path.join(td.home, `clipped-${prompt}-fixture-pid.json`), JSON.stringify({ pid: started.body['pid'], id: clippedId }));
    const state = async () => {
      const result = await api(td.port, td.token, '/sessions');
      return (result.body['sessions'] as Record<string, unknown>[]).find(session => session['id'] === clippedId)?.['stalled'];
    };
    let live: WsClient | undefined;
    try {
      await eventually(async () => await state() !== undefined);
      const before = await state();
      live = await connectWs(td.port, clippedId, td.token);
      for (const [cols, rows] of [[80, 24], [120, 30]]) {
        diagnostics.resize(cols!, rows!, 'requested');
        await api(td.port, td.token, `/sessions/${clippedId}/resize`, { body: { cols, rows } });
        diagnostics.resize(cols!, rows!, 'returned');
        await new Promise(resolve => setTimeout(resolve, 2400));
        diagnostics.resize(cols!, rows!, 'settled');
        expect(await state()).toEqual(before);
      }
      expect(messages.filter(message => message['type'] === 'session-stalled' && message['session'] === clippedId)).toHaveLength(1);
      expect(messages.filter(message => message['type'] === 'session-stall-clear' && message['session'] === clippedId)).toHaveLength(0);
      expect(warnings.filter(value => JSON.stringify(value).includes(clippedId) && JSON.stringify(value).includes('session stalled'))).toHaveLength(1);
      const audit = fs.readFileSync(path.join(td.home, 'audit.log'), 'utf8');
      expect(audit.split('\n').filter(line => line.includes('"session-stalled"') && line.includes(clippedId))).toHaveLength(1);
      expect(live.controls().filter(control => control['type'] === 'session-stall-clear')).toHaveLength(0);
    } catch (error) { diagnostics.print(); throw error; }
    finally { diagnostics.stop(); live?.close(); }
  });
  it('announces a responsive native composer once across resize and grey suggestions', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [path.join(repoRoot, 'test/fixtures/stalled-screen.mjs'), '--responsive', '--toggle-suggestion'],
        shell: false, agent: 'mimo', cols: 120, rows: 30 },
    });
    expect(started.status).toBe(200);
    const responsiveId = String(started.body['id']);
    fs.writeFileSync(path.join(td.home, 'responsive-fixture-pid.json'), JSON.stringify({ pid: started.body['pid'], id: responsiveId }));
    const state = async () => {
      const result = await api(td.port, td.token, '/sessions');
      return (result.body['sessions'] as Record<string, unknown>[]).find(session => session['id'] === responsiveId)?.['stalled'];
    };
    await eventually(async () => await state() !== undefined);
    const before = await state();
    const live = await connectWs(td.port, responsiveId, td.token);
    try {
      for (const [cols, rows] of [[80, 24], [180, 45], [240, 60], [120, 30]]) {
        await api(td.port, td.token, `/sessions/${responsiveId}/resize`, { body: { cols, rows } });
        await eventually(async () => String((await api(td.port, td.token, `/sessions/${responsiveId}/snapshot`)).body['screen'])
          .includes('╹' + '▀'.repeat(cols! - 5)));
        expect(await state()).toEqual(before);
        await new Promise(resolve => setTimeout(resolve, 2200));
        expect(await state()).toEqual(before);
      }
      expect(messages.filter(message => message['type'] === 'session-stalled' && message['session'] === responsiveId)).toHaveLength(1);
      expect(messages.filter(message => message['type'] === 'session-stall-clear' && message['session'] === responsiveId)).toHaveLength(0);
      expect(warnings.filter(value => JSON.stringify(value).includes(responsiveId) && JSON.stringify(value).includes('session stalled'))).toHaveLength(1);
      const audit = fs.readFileSync(path.join(td.home, 'audit.log'), 'utf8');
      expect(audit.split('\n').filter(line => line.includes('"session-stalled"') && line.includes(responsiveId))).toHaveLength(1);
      expect(live.controls().filter(control => control['type'] === 'session-stall-clear')).toHaveLength(0);
    } finally { live.close(); }
  });
});
