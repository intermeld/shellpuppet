import { execFile } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IPty } from 'node-pty';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';
import { api, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const exec = promisify(execFile);
let td: TestDaemon;
let client: Client;
let session: Session;
const writes: string[] = [];
const requestSizes: number[] = [];
// The same wire tests can drive separately built clients against an older daemon.
const clientDist = process.env['SHELLPUPPET_TEST_CLIENT_DIST'] ?? join(repoRoot, 'dist');
const legacy = process.env['SHELLPUPPET_TEST_LEGACY_SUBMIT'] === '1';
const env = (): Record<string, string> => ({ ...process.env, SHELLPUPPET_HOME: td.home });

beforeAll(async () => {
  td = await startTestDaemon();
  td.daemon['server'].on('request', (req: IncomingMessage) => {
    if (req.method === 'POST' && req.url === '/sessions/s1/input') requestSizes.push(Number(req.headers['content-length']));
  });
  let output!: (data: string) => void;
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'fixture', handleFlowControl: false,
    onData(listener) { output = listener; return { dispose() {} }; }, onExit() { return { dispose() {} }; },
    write(data: string) { writes.push(data); }, resize() {}, kill() {}, clear() {}, pause() {}, resume() {},
  } satisfies IPty;
  session = new Session('s1', { command: process.execPath, agent: 'generic', shell: false },
    { platform: 'linux', spawn: () => pty });
  output('\x1b[?2004h');
  await session['renderer'].flush();
  vi.spyOn(td.daemon['manager'], 'get').mockImplementation(id => id === 's1' ? session : undefined);
  client = new Client({ name: 'input-test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(clientDist, 'mcp/index.js')], env: env(), stderr: 'pipe',
  }));
});

afterAll(async () => {
  await client?.close();
  vi.restoreAllMocks();
  await session?.['renderer'].dispose();
  await td?.stop();
});

it('preserves CLI and MCP PTY writes and the fields supported by the daemon', async () => {
  for (const body of ['sample', 'sample\r']) {
    const expected = body === 'sample' ? [body, '\r'] : ['sample\r\r'];
    writes.length = 0;
    const cli = await exec(process.execPath, [join(clientDist, 'cli/index.js'), 'type', 's1', body, '--enter', '--json'], { env: env() });
    const cliResult: unknown = JSON.parse(cli.stdout);
    expect(writes).toEqual(expected);
    const fields = { ok: true, bytes: body.length + 1,
      ...(body === 'sample' ? { message: 'Submit key sent; this programme has no readable composer.' } : {}) };
    expect(cliResult).toEqual(legacy ? fields : { ...fields, outcome: 'unconfirmed' });

    writes.length = 0;
    const result = await client.callTool({ name: 'terminal_type', arguments: { session: 's1', text: body, submit: true } });
    expect(writes).toEqual(expected);
    expect(result.isError).not.toBe(true);
    const previous = `Typed ${String(body.length + 1)} bytes.` + (fields.message ? ' ' + fields.message : '');
    expect(result.content).toEqual([{ type: 'text', text: previous + (legacy ? '' : ' Submit outcome: unconfirmed.') }]);
    expect(result.structuredContent).toEqual(legacy ? undefined : cliResult);
  }
});

// Windows process arguments cannot carry a megabyte. Supply the fixture through
// the child's stdin and build argv before importing the compiled CLI entry point.
function largeCli(body: string, verify: boolean) {
  const bootstrap = [
    "import { readFileSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    "process.argv.splice(2, 0, 'type', 's1', readFileSync(0, 'utf8'))",
    "await import(pathToFileURL(process.argv[1]).href)",
  ].join('\n');
  const child = exec(process.execPath, ['--input-type=module', '-e', bootstrap, join(clientDist, 'cli/index.js'),
    '--enter', '--json', ...(verify ? ['--verify'] : [])], { env: env() });
  child.child.stdin!.end(body);
  return child;
}

describe.each(['CLI', 'MCP'])('%s request boundary', adapter => {
  it.each([
    [999_986, false, true], [999_986, true, true], [999_987, true, false], [1_000_000, false, false],
  ] as const)('delivers a %i-byte legacy JSON body, verify %s, marker fits %s', async (size, verify, fits) => {
    const prefix = '\t\u3000\n';
    const fixed = Buffer.byteLength(JSON.stringify({ data: prefix + '\r', ...(verify ? { verify: true } : {}) }));
    const body = prefix + ' '.repeat(size - fixed);
    const fields = { ok: true, bytes: body.length + 1, ...(verify ? { verified: true } : {}) };
    const reported = fits && !legacy;
    const expected = { ...fields, ...(reported ? { outcome: 'unconfirmed' } : {}) };
    requestSizes.length = 0;
    writes.length = 0;
    if (adapter === 'CLI') {
      expect(JSON.parse((await largeCli(body, verify)).stdout)).toEqual(expected);
    } else {
      const mcp = await client.callTool({ name: 'terminal_type', arguments: { session: 's1', text: body, submit: true, verify } });
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toEqual(reported ? expected : undefined);
      const message = `Typed ${String(fields.bytes)} bytes` + (verify ? ' (verified on screen).' : '.');
      expect(mcp.content).toEqual([{ type: 'text', text: message + (reported ? ' Submit outcome: unconfirmed.' : '') }]);
    }
    expect(requestSizes).toEqual([fits ? size + Buffer.byteLength(',"submit":true') : size]);
    expect(writes).toHaveLength(1);
    expect(writes[0] === '\x1b[200~' + body + '\x1b[201~\r').toBe(true);
  });
});

it('retains the refusal for a legacy body one byte above the limit', async () => {
  const text = 'a'.repeat(1_000_001 - Buffer.byteLength(JSON.stringify({ data: '\r' })));
  writes.length = 0;
  await expect(largeCli(text, false)).rejects.toThrow(/Request body too large/i);
  const mcp = await client.callTool({ name: 'terminal_type', arguments: { session: 's1', text, submit: true } });
  expect(mcp.isError).toBe(true);
  expect(mcp.content).toEqual([{ type: 'text', text: 'Request body too large: the limit is 1000000 bytes.' }]);
  expect(writes).toEqual([]);
});

it('handles an older wire request containing Enter with the old response fields', async () => {
  writes.length = 0;
  const result = await api(td.port, td.token, '/sessions/s1/input', { body: { data: 'sample\r' } });
  expect(writes).toEqual(['sample', '\r']);
  expect(result.body).toEqual({ ok: true, bytes: 7, message: 'Submit key sent; this programme has no readable composer.' });
});

it.each([{}, { submit: false }])('sends ordinary input through the original route with %j', async fields => {
  const write = vi.spyOn(session, 'writeWithResult');
  try {
    writes.length = 0;
    const result = await api(td.port, td.token, '/sessions/s1/input', { body: { data: 'x', ...fields } });
    expect(write.mock.calls).toEqual([['x']]);
    expect(writes).toEqual(['x']);
    expect(result.body).toEqual({ ok: true, bytes: 1 });
  } finally { write.mockRestore(); }
});

it.each([
  [true, false, undefined, { outcome: 'submitted' }],
  [undefined, false, undefined, { outcome: 'unconfirmed' }],
  [false, true, 'The typed text is still in the composer after one submit retry.', { outcome: 'unconfirmed' }],
  [false, false, 'The typed text was not seen in the composer; Enter was not sent.', { outcome: 'withheld', reason: 'line-not-seen' }],
  [false, false, 'Other input arrived after the typed text; Enter was not sent.', { outcome: 'withheld', reason: 'other-input-arrived' }],
] as const)('derives an outcome from submitted %s, retried %s, message %s', async (submitted, submitRetried, message, report) => {
  const write = vi.spyOn(session, 'writeWithResult').mockResolvedValue({ before: '', submitted, submitRetried, message });
  try {
    const result = await api(td.port, td.token, '/sessions/s1/input', { body: { data: '\r', submit: true, verify: true } });
    expect(write.mock.calls).toEqual([['\r']]);
    expect(result.body).toEqual({ ok: true, bytes: 1, verified: true, ...report,
      ...(submitted !== undefined ? { submitted } : {}), ...(submitRetried ? { submitRetried } : {}),
      ...(message ? { message } : {}) });
  } finally { write.mockRestore(); }
});
