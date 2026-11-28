import * as fs from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { api, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { dashboardCookie } from '../../src/daemon/auth.js';

it('reports malformed expressions to CLI, MCP and the authenticated dashboard without their source', async () => {
  const home = makeTempHome();
  const pattern = '[private-pattern-marker';
  const config = { launcher: { profiles: [{ name: 'sample', command: 'sample', policy: { deny: [pattern] } }] },
    agents: { signatures: [{ name: 'sample', composer: { text: pattern }, answer: { start: { text: 'yes' } } },
      { name: 'desk', programs: 1 }] } };
  fs.writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const td = await startTestDaemon({ home, launchProfiles: parseDaemonConfig(config).config.launcher });
  const env = { ...process.env, SHELLPUPPET_HOME: home } as Record<string, string>;
  const client = new Client({ name: 'sample', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'dist/mcp/index.js')], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  try {
    await client.connect(transport);
    await client.listTools();
    const cli = await promisify(execFile)(process.execPath, [join(repoRoot, 'dist/cli/index.js'), 'start', '--agent', 'codex',
      '--no-viewer', '--no-shell', process.execPath, '-v'], { env });
    const tokens = td.daemon['tokens'];
    const cookie = dashboardCookie(tokens.redeemDashboardGrant(tokens.mintDashboardGrant())!.token).split(';')[0]!;
    const list = await api(td.port, null, '/dashboard/profiles', { headers: { cookie,
      'x-shellpuppet-csrf': tokens.issueDashboardProof()!, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } });
    expect(list.status).toBe(200);
    for (const output of [cli.stderr, stderr]) {
      expect.soft(output).toContain('agents.signatures[1] (desk).programs must be a list of command names: ignored');
    }
    for (const [boundary, diagnostics] of [['CLI', cli.stderr], ['MCP', stderr], ['dashboard', JSON.stringify(list.body.problems)]]) {
      expect.soft(diagnostics, boundary).not.toContain(pattern);
      expect.soft(diagnostics, boundary).toMatch(/(?:signatures|profiles)\[0\]/);
      expect.soft(diagnostics, boundary).toMatch(/(?:does not compile|invalid regular expression)/);
    }
  } finally { await client.close(); await td.stop(); }
}, 50_000);

it.each(['allow', 'deny'] as const)('redacts a malformed global policy.%s in start refusals', async list => {
  const home = makeTempHome();
  const pattern = '[private-policy-marker';
  const policy = { mode: list === 'allow' ? 'allowlist' as const : 'denylist' as const, [list]: ['valid', pattern] };
  fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ policy }));
  const td = await startTestDaemon({ home, policy });
  const env = { ...process.env, SHELLPUPPET_HOME: home } as Record<string, string>;
  const client = new Client({ name: 'refusal-test', version: '1' });
  try {
    const args = { command: process.execPath, args: ['-v'], shell: false };
    const refused = await api(td.port, td.token, '/sessions', { body: { ...args, openViewer: false } });
    const reason = 'policy.' + list + '[1] does not compile.';
    expect.soft(refused).toEqual({ status: 403, body: { error: reason } });
    await expect.soft(promisify(execFile)(process.execPath, [join(repoRoot, 'dist/cli/index.js'), 'start',
      '--no-shell', '--no-viewer', process.execPath, '-v'], { env })).rejects.toMatchObject({
      code: 1, stderr: 'error (403): ' + reason + '\n',
    });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'dist/mcp/index.js')], env, stderr: 'pipe' }));
    expect.soft(await client.callTool({ name: 'terminal_start', arguments: args })).toMatchObject({
      isError: true, content: [{ type: 'text', text: reason }],
    });
    expect(td.daemon.liveSessions).toBe(0);
  } finally { await client.close(); await td.stop(); }
}, 50_000);
