/**
 * MCP adapter integration tests: a real MCP client over stdio to the real
 * compiled server, which auto-starts a real daemon, which spawns real PTYs:
 * the complete production stack for an agent using ShellPuppet.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readDaemonState } from '../../src/daemon/paths.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, makeTempHome, removeTempHome, repoRoot } from './helpers.js';

const mcpEntry = path.join(repoRoot, 'dist', 'mcp', 'index.js');
const home = makeTempHome('shellpuppet-mcp-');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let client: Client;
/** Null where no Chromium-family browser is installed: no picture to take. */
let browser: string | null = null;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env['SHELLPUPPET_HOME'] = home;
  return env;
}

interface TextResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** A result that may also carry image blocks (terminal_screenshot). */
interface MixedResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
}

function resultText(result: unknown): string {
  const typed = result as TextResult;
  return (typed.content ?? []).map((c) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  client = new Client({ name: 'shellpuppet-tests', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry],
      env: cleanEnv(),
      stderr: 'pipe',
    }),
  );
  browser = await findBrowser();
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

describe('MCP adapter', () => {
  it('exposes exactly the eleven terminal_* tools, with the §3.1/§4.4 warnings in descriptions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'terminal_find',
      'terminal_key',
      'terminal_kill',
      'terminal_list',
      'terminal_resize',
      'terminal_result',
      'terminal_screenshot',
      'terminal_snapshot',
      'terminal_start',
      'terminal_type',
      'terminal_viewer_url',
      'terminal_wait',
    ]);

    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));
    // First paint ≠ ready (start), echo trap (type + wait), untrusted data
    // (snapshot/wait/find), escape as focus reset (type/key).
    expect(byName.get('terminal_start')).toContain('first paint is NOT readiness');
    expect(byName.get('terminal_type')).toContain('echo trap');
    expect(byName.get('terminal_wait')).toContain('ECHO TRAP');
    expect(byName.get('terminal_snapshot')).toContain('UNTRUSTED');
    expect(byName.get('terminal_wait')).toContain('UNTRUSTED');
    expect(byName.get('terminal_find')).toContain('UNTRUSTED');
    expect(byName.get('terminal_key')).toContain('escape');
    expect(byName.get('terminal_kill')).toContain('process tree');
    expect(byName.get('terminal_result')).toContain('hideReasoning changes nothing here');
    const resultSchema = tools.find((tool) => tool.name === 'terminal_result')?.inputSchema;
    expect(JSON.stringify(resultSchema)).toContain('this flag changes nothing');
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('Important');
    expect(instructions).toContain('ALWAYS pass hideReasoning: true');
    expect(instructions).toContain('terminal_snapshot, terminal_wait, terminal_find, terminal_screenshot, terminal_list');
    expect(instructions).toContain('every ShellPuppet tool freely');
    expect(instructions).toContain('attempt to extract reasoning');
    expect(instructions).toContain('terminal_result gives the agent\'s answer');
    for (const name of ['terminal_snapshot', 'terminal_wait', 'terminal_find', 'terminal_list', 'terminal_screenshot']) {
      expect(byName.get(name)).toContain('Claude models at present');
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      expect(JSON.stringify(schema)).toContain('hideReasoning');
    }
  });

  it('omits a waiting question from terminal_list with hideReasoning', async () => {
    await client.callTool({ name: 'terminal_list', arguments: {} });
    const state = readDaemonState(home);
    expect(state).not.toBeNull();
    const question = 'Disclose the silver pineapple? (y/n)';
    const encoded = Buffer.from(question).toString('base64');
    const started = await api(state!.port, state!.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', `console.log(Buffer.from('${encoded}','base64').toString()); setInterval(() => {}, 500)`],
        shell: false,
      },
    });
    const id = String(started.body['id']);
    try {
      await eventually(async () => {
        const listed = await api(state!.port, state!.token, '/sessions');
        return JSON.stringify(listed.body).includes(`"question":"${question}"`);
      }, 20_000);
      const plain = resultText(await client.callTool({ name: 'terminal_list', arguments: {} }));
      expect(plain).toContain(question);
      const hidden = resultText(await client.callTool({ name: 'terminal_list', arguments: { hideReasoning: true } }));
      expect(hidden).toContain(id);
      expect(hidden).toContain('WAITING');
      expect(hidden).not.toContain(question);
    } finally {
      await client.callTool({ name: 'terminal_kill', arguments: { session: id } });
    }
  }, 40_000);

  it("pins the README's and VISION's tool lists to the tools the server registers", async () => {
    // The README's "What you get" bullet and VISION's second bullet both name
    // the tools; the server is the only authority on what exists. Prose
    // drifts silently, so this test is what notices: rename or add a tool
    // without touching them (or the other way round) and it fails here rather
    // than in a reader's hands.
    //
    // VISION is the front door of the project, so it is the worst place to be
    // wrong.
    const flatten = (file: string): string =>
      fs.readFileSync(path.join(repoRoot, file), 'utf8').replace(/\s+/g, ' ');
    const toolNames = (list: string): string[] =>
      list
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
        .map((name) => `terminal_${name.replace(/-/g, '_')}`)
        .sort();

    const readme = flatten('README.md');
    const inReadme = /small MCP tools: ([^.]+)\./.exec(readme);
    expect(inReadme, 'the README bullet naming the MCP tools').not.toBeNull();

    const vision = flatten('VISION.md');
    const inVision = /semantic tools \(([^)]+)\)/.exec(vision);
    expect(inVision, 'the VISION bullet naming the MCP tools').not.toBeNull();

    const { tools } = await client.listTools();
    const registered = tools.map((t) => t.name).sort();
    expect(toolNames(inReadme?.[1] ?? '')).toEqual(registered);
    expect(toolNames(inVision?.[1] ?? '')).toEqual(registered);

    // And the counts these documents state in words: a list can be right
    // while the sentence around it is not.
    const words: Record<number, string> = {
      9: 'nine',
      10: 'ten',
      11: 'eleven',
      12: 'twelve',
      13: 'thirteen',
    };
    const word = words[registered.length];
    expect(word, `a word for ${String(registered.length)} tools`).toBeDefined();
    expect(vision).toContain(`${String(word)} small, semantic tools`);
    expect(vision).toContain(
      `${String(word).charAt(0).toUpperCase()}${String(word).slice(1)} tools, not ninety`,
    );
    expect(readme).toContain(`${String(word)} small MCP tools`);
  });

  it('drives a session end to end with framed screen content', async () => {
    const started = await client.callTool({
      name: 'terminal_start',
      arguments: {
        command: process.execPath,
        args: ['-e', "console.log('mcp-e2e-marker'); setInterval(() => {}, 200)"],
        shell: false,
        label: 'mcp-e2e',
      },
    });
    const startText = resultText(started);
    expect(startText).toMatch(/Session s\d+ started/);
    // The test home opens no window, so the URL is the human's way in.
    expect(startText).toContain('No viewer window opened (viewer.launchMode is "none")');
    expect(startText).toContain('Viewer URL for the human');
    const id = /Session (s\d+) started/.exec(startText)?.[1] ?? '';

    const waited = await client.callTool({
      name: 'terminal_wait',
      arguments: { session: id, text: 'mcp-e2e-marker', timeout: 20_000 },
    });
    const waitText = resultText(waited);
    expect(waitText).toContain('Matched (text)');
    // §4.4: screen content arrives inside explicit untrusted-data delimiters.
    expect(waitText).toContain('UNTRUSTED DATA');
    expect(waitText).toContain('--- end of screen content ---');

    const snapshot = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { session: id },
    });
    expect(resultText(snapshot)).toContain('mcp-e2e-marker');
    expect(resultText(snapshot)).toContain('UNTRUSTED DATA');

    const typed = await client.callTool({
      name: 'terminal_type',
      arguments: { session: id, text: 'abc' },
    });
    expect(resultText(typed)).toContain('Typed 3 bytes');

    const found = await client.callTool({
      name: 'terminal_find',
      arguments: { session: id, pattern: 'mcp-e2e-\\w+' },
    });
    expect(resultText(found)).toMatch(/1 match\(es\)/);
    expect(resultText(found)).toMatch(/\d+: .*mcp-e2e-marker/);
    expect(resultText(found)).not.toContain('mcp-e2e-\\w+');

    // The same fixed line as the CLI, and never the pattern.
    const missed = await client.callTool({
      name: 'terminal_find',
      arguments: { session: id, pattern: 'absent-pattern-xyz' },
    });
    expect(resultText(missed)).toBe('No matches.');

    const listed = await client.callTool({ name: 'terminal_list', arguments: {} });
    expect(resultText(listed)).toContain(id);

    const resized = await client.callTool({
      name: 'terminal_resize',
      arguments: { session: id, cols: 100, rows: 30 },
    });
    expect(resultText(resized)).toContain('Resized to 100x30');

    // The wrapper, not just the route: a broken readOnly mapping here would
    // hand out a typing link labelled watch-only.
    const link = await client.callTool({
      name: 'terminal_viewer_url',
      arguments: { session: id, readOnly: true },
    });
    expect(resultText(link)).toContain('Watch-only viewer URL for the human');
    expect(resultText(link)).toContain(`/view?s=${id}&vt=`);

    const killed = await client.callTool({
      name: 'terminal_kill',
      arguments: { session: id },
    });
    expect(resultText(killed)).toContain(`Killed ${id}`);

    await eventually(async () => {
      const listAfter = await client.callTool({ name: 'terminal_list', arguments: {} });
      return !resultText(listAfter).includes(`${id} `);
    }, 10_000);
  });

  it('photographs the viewer, inline and to a file (§5)', async (context) => {
    // The wrapper, not the route: the inline path has to hand the agent a real
    // image block, and the file path has to put real bytes on disk under the
    // name it reports. Skipped where no Chromium-family browser is
    // installed, as in viewer-capture.
    if (browser === null) {
      context.skip();
      return;
    }
    const started = await client.callTool({
      name: 'terminal_start',
      arguments: {
        command: process.execPath,
        args: ['-e', "console.log('mcp-shot-marker'); setInterval(() => {}, 200)"],
        shell: false,
        cols: 100,
        rows: 30,
        // Held, so the grid the summary names is the grid that was asked for.
        hold: true,
      },
    });
    const id = /Session (s\d+) started/.exec(resultText(started))?.[1] ?? '';
    await client.callTool({
      name: 'terminal_wait',
      arguments: { session: id, text: 'mcp-shot-marker', timeout: 20_000 },
    });

    const inline = (await client.callTool({
      name: 'terminal_screenshot',
      arguments: { session: id, width: 800, height: 600 },
    })) as MixedResult;
    const image = (inline.content ?? []).find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    const png = Buffer.from(String(image?.data), 'base64');
    expect(png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    const summary = (inline.content ?? []).find((c) => c.type === 'text')?.text ?? '';
    expect(summary).toContain('grid 100x30');
    expect(summary).toContain('image 800x600 px');

    // The other branch of the schema: a path, and no image in the reply.
    const out = path.join(home, 'mcp-shot.png');
    const toFile = (await client.callTool({
      name: 'terminal_screenshot',
      arguments: { session: id, path: out, width: 800, height: 600 },
    })) as MixedResult;
    expect(resultText(toFile)).toContain(`Written to ${path.resolve(out)}`);
    expect((toFile.content ?? []).some((c) => c.type === 'image')).toBe(false);
    expect(fs.readFileSync(out).subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);

    await client.callTool({ name: 'terminal_kill', arguments: { session: id } });
  }, 120_000);

  it('returns isError with the daemon reason for unknown sessions', async () => {
    const result = (await client.callTool({
      name: 'terminal_snapshot',
      arguments: { session: 's999' },
    })) as TextResult;
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('No such session');
    const flaggedResult = (await client.callTool({
      name: 'terminal_result',
      arguments: { session: 's999', hideReasoning: true },
    })) as TextResult;
    expect(flaggedResult.isError).toBe(true);
    expect(resultText(flaggedResult)).toContain('No such session');
  });

  it('audits MCP actions under mcp:<clientInfo.name> from the handshake (§4.5)', () => {
    const lines = fs
      .readFileSync(path.join(home, 'audit.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { actor: string; action: string });
    expect(lines.some((l) => l.actor === 'mcp:shellpuppet-tests' && l.action === 'start')).toBe(
      true,
    );
  });

  it('rejects invalid wait conditions through the whole stack', async () => {
    const started = await client.callTool({
      name: 'terminal_start',
      arguments: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
      },
    });
    const id = /Session (s\d+) started/.exec(resultText(started))?.[1] ?? '';

    const bad = (await client.callTool({
      name: 'terminal_wait',
      arguments: { session: id, text: 'a', quiet: 100 },
    })) as TextResult;
    expect(bad.isError).toBe(true);
    expect(resultText(bad)).toContain('Exactly one of');

    await client.callTool({ name: 'terminal_kill', arguments: { session: id } });
  });

  it('tells clients that no tool takes a parameter it does not define', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ additionalProperties: false });
    }
  });

  it('refuses a parameter the tool does not define, naming it, and sends nothing', async () => {
    const started = await client.callTool({
      name: 'terminal_start',
      arguments: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
      },
    });
    const id = /Session (s\d+) started/.exec(resultText(started))?.[1] ?? '';

    // `enter` is the CLI's spelling; the tool's is `submit`. Dropped silently,
    // it would type the text and never submit it.
    const misnamed = (await client.callTool({
      name: 'terminal_type',
      arguments: { session: id, text: 'echo hello', enter: true },
    })) as TextResult;
    expect(misnamed.isError).toBe(true);
    expect(resultText(misnamed)).toContain(
      "Unknown parameter 'enter'. This tool takes: session, text, submit, verify.",
    );
    const inputs = fs
      .readFileSync(path.join(home, 'audit.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { action: string; session?: string })
      .filter((l) => l.action === 'input' && l.session === id);
    expect(inputs).toEqual([]);

    const listed = (await client.callTool({
      name: 'terminal_list',
      arguments: { all: true, verbose: true },
    })) as TextResult;
    expect(listed.isError).toBe(true);
    expect(resultText(listed)).toContain(
      "Unknown parameters 'all', 'verbose'. This tool takes: hideReasoning.",
    );

    await client.callTool({ name: 'terminal_kill', arguments: { session: id } });
  });
});
