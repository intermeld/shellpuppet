/**
 * `terminal_start`'s `envNames` (design §4.6): the MCP server copies only the
 * variables the human listed in `mcp.passEnv` from its own environment into a
 * session's. The real stdio server, a real daemon and real PTYs. The home sets
 * `sessionEnv: "clean"`, so a variable that reached the session by the
 * daemon's own inheritance cannot pass for one this feature carried.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { auditLogPath } from '../../src/daemon/audit.js';
import { daemonLogPath, readDaemonState } from '../../src/daemon/paths.js';
import { api, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const mcpEntry = path.join(repoRoot, 'dist', 'mcp', 'index.js');
const home = makeTempHome('shellpuppet-mcp-env-');

const PASSED_VALUE = 'passed-value-c41d';
const UNNAMED_VALUE = 'unnamed-value-9b2e';
const AGENT_VALUE = 'agent-value-5a07';

let client: Client;

interface TextResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

function resultText(result: unknown): string {
  return ((result as TextResult).content ?? []).map((c) => c.text ?? '').join('\n');
}

/** Start a session that prints what it can see of the two variables, and return its id and the start result. */
async function startReporter(envNames?: string[], agent?: string): Promise<{ id: string; started: unknown }> {
  const started = await client.callTool({
    name: 'terminal_start',
    arguments: {
      command: process.execPath,
      args: [
        '-e',
        "console.log('REPORT listed:' + (process.env.SP_TEST_PASSED ?? 'none') + ' other:' + (process.env.SP_TEST_UNNAMED ?? 'none') + ' agent:' + (process.env.SP_TEST_AGENT ?? 'none')); setInterval(() => {}, 200)",
      ],
      shell: false,
      ...(envNames !== undefined ? { envNames } : {}),
      ...(agent !== undefined ? { agent } : {}),
    },
  });
  const id = /Session (s\d+) started/.exec(resultText(started))?.[1] ?? '';
  return { id, started };
}

async function screenOf(id: string): Promise<string> {
  const waited = await client.callTool({
    name: 'terminal_wait',
    arguments: { session: id, text: 'REPORT', timeout: 20_000, debounce: 300 },
  });
  return resultText(waited);
}

const AGENT_LISTS = { qoder: ['SP_TEST_AGENT', 'SP_TEST_AGENT_UNSET'], codex: [] as string[] };

function writeConfig(agentLists: Record<string, string[]> = AGENT_LISTS): void {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      viewer: { launchMode: 'none' },
      sessionEnv: 'clean',
      mcp: { passEnv: ['SP_TEST_PASSED', 'SP_TEST_LISTED_UNSET'] },
      agents: { passEnv: agentLists },
    }),
  );
}

beforeAll(async () => {
  writeConfig();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env['SHELLPUPPET_HOME'] = home;
  env['SP_TEST_PASSED'] = PASSED_VALUE;
  env['SP_TEST_UNNAMED'] = UNNAMED_VALUE;
  env['SP_TEST_AGENT'] = AGENT_VALUE;
  delete env['SP_TEST_LISTED_UNSET'];
  delete env['SP_TEST_AGENT_UNSET'];

  client = new Client({ name: 'shellpuppet-tests', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [mcpEntry], env, stderr: 'pipe' }),
  );
}, 60_000);

afterAll(async () => {
  await client.close();
  const state = readDaemonState(home);
  if (state !== null) {
    try {
      await api(state.port, state.token, '/daemon/shutdown', { body: { force: true } });
    } catch {
      // Daemon already gone.
    }
  }
  removeTempHome(home);
});

describe('the variables each agent receives (agents.passEnv)', () => {
  it('passes an agent\'s listed variables with no envNames, reports one not set, and passes nothing else', async () => {
    const { id, started } = await startReporter(undefined, 'qoder');
    const text = resultText(started);
    expect(text).toContain("Passed for qoder from this MCP server's environment: SP_TEST_AGENT.");
    expect(text).toContain("Listed for qoder but not set in this MCP server's environment, so not passed: SP_TEST_AGENT_UNSET.");
    expect(text).not.toContain(AGENT_VALUE);
    const screen = await screenOf(id);
    expect(screen).toContain(`agent:${AGENT_VALUE}`);
    expect(screen).toContain('listed:none');
    expect(screen).toContain('other:none');
  }, 60_000);

  it('gives an agent with an empty list nothing', async () => {
    const { id, started } = await startReporter(undefined, 'codex');
    expect(resultText(started)).not.toContain('Passed');
    const screen = await screenOf(id);
    expect(screen).toContain('agent:none');
    expect(screen).toContain('listed:none');
  }, 60_000);

  it('gives a session that runs as no agent nothing from the agent lists', async () => {
    const { id } = await startReporter();
    expect(await screenOf(id)).toContain('agent:none');
  }, 60_000);

  it('refuses envNames off the agent\'s list for an agent session, even a name on mcp.passEnv, and starts nothing', async () => {
    const before = await client.callTool({ name: 'terminal_list', arguments: {} });
    const { started } = await startReporter(['SP_TEST_PASSED'], 'qoder');
    expect((started as TextResult).isError).toBe(true);
    const text = resultText(started);
    expect(text).toContain('agents.passEnv.qoder');
    expect(text).toContain('SP_TEST_PASSED');
    expect(text).not.toContain(PASSED_VALUE);
    const after = await client.callTool({ name: 'terminal_list', arguments: {} });
    const count = (listed: unknown): number => resultText(listed).match(/^s\d+ {2}/gm)?.length ?? 0;
    expect(count(after)).toBe(count(before));
  });

  it('reads the lists at every start: a name added to an agent\'s list passes on the next start, with no restart', async () => {
    writeConfig({ ...AGENT_LISTS, codex: ['SP_TEST_AGENT'] });
    try {
      const { id, started } = await startReporter(undefined, 'codex');
      expect(resultText(started)).toContain("Passed for codex from this MCP server's environment: SP_TEST_AGENT.");
      expect(await screenOf(id)).toContain(`agent:${AGENT_VALUE}`);
    } finally {
      writeConfig();
    }
  }, 60_000);

  it('accepts envNames already on the agent\'s list', async () => {
    const { id, started } = await startReporter(['SP_TEST_AGENT'], 'qoder');
    expect((started as TextResult).isError).not.toBe(true);
    expect(await screenOf(id)).toContain(`agent:${AGENT_VALUE}`);
  }, 60_000);
});

describe('terminal_start envNames', () => {
  it('is in the tool schema', async () => {
    const { tools } = await client.listTools();
    const start = tools.find((tool) => tool.name === 'terminal_start');
    const properties = (start?.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(properties).toHaveProperty('envNames');
  });

  it('passes a listed variable and nothing it was not asked for, and shows neither value', async () => {
    const { id, started } = await startReporter(['SP_TEST_PASSED']);
    const text = resultText(started);
    expect(text).toContain("Passed from this MCP server's environment: SP_TEST_PASSED.");
    expect(text).not.toContain(PASSED_VALUE);

    const screen = await screenOf(id);
    expect(screen).toContain(`listed:${PASSED_VALUE}`);
    expect(screen).toContain('other:none');
  }, 60_000);

  it('passes nothing when no names are given', async () => {
    const { id } = await startReporter();
    const screen = await screenOf(id);
    expect(screen).toContain('listed:none');
    expect(screen).toContain('other:none');
  }, 60_000);

  it('refuses a name the human did not list, naming it, and starts nothing', async () => {
    const before = await client.callTool({ name: 'terminal_list', arguments: {} });
    const { started } = await startReporter(['SP_TEST_UNNAMED']);
    expect((started as TextResult).isError).toBe(true);
    const text = resultText(started);
    expect(text).toContain('SP_TEST_UNNAMED');
    expect(text).toContain('mcp.passEnv');
    expect(text).not.toContain(UNNAMED_VALUE);
    const after = await client.callTool({ name: 'terminal_list', arguments: {} });
    const count = (listed: unknown): number => resultText(listed).match(/^s\d+ {2}/gm)?.length ?? 0;
    expect(count(after)).toBe(count(before));
  });

  it('reports a listed name that is not set here, by name, and still starts', async () => {
    const { id, started } = await startReporter(['SP_TEST_LISTED_UNSET', 'SP_TEST_PASSED']);
    const text = resultText(started);
    expect(text).toContain("Not set in this MCP server's environment, so not passed: SP_TEST_LISTED_UNSET.");
    expect(text).toContain("Passed from this MCP server's environment: SP_TEST_PASSED.");
    expect(await screenOf(id)).toContain(`listed:${PASSED_VALUE}`);
  }, 60_000);

  it('audits the names and writes no value to the audit trail or the daemon log', () => {
    const audit = fs.readFileSync(auditLogPath(home), 'utf8');
    const starts = audit
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { action: string; meta?: { envNames?: string[] } })
      .filter((line) => line.action === 'start');
    expect(starts.some((line) => line.meta?.envNames?.includes('SP_TEST_PASSED'))).toBe(true);
    for (const value of [PASSED_VALUE, UNNAMED_VALUE, AGENT_VALUE]) {
      expect(audit).not.toContain(value);
      expect(fs.readFileSync(daemonLogPath(home), 'utf8')).not.toContain(value);
    }
  });
});
