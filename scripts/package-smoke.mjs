#!/usr/bin/env node
/**
 * Package check: install ShellPuppet the way a user gets it, then drive one
 * session through the installed command.
 *
 * The test suite runs from the source tree, so it cannot notice a file missing
 * from the package, a broken install script or a command shim that does not
 * start. This script installs a tarball globally into a fresh prefix (the one
 * named on the command line, or one packed from the current tree, which needs
 * `npm run build` first) and then, against a daemon of its own in a fresh home
 * that opens no browser window:
 *
 *   list the MCP server's tools → start a session → wait for it → type →
 *   wait for the reply → read the screen → load the viewer page and every
 *   file it asks for → kill the session → stop the daemon.
 *
 * It never talks to a daemon already running on the machine: every command
 * gets `SHELLPUPPET_HOME` pointing at the temporary home.
 *
 * Usage: node scripts/package-smoke.mjs [path/to/shellpuppet-<version>.tgz]
 * Exit code 0 when every step passed, 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const given = process.argv[2];

// The tools the source registers. The installed MCP server must list exactly
// these: a package that loses or renames one is not the one this tree builds.
const registeredTools = [
  ...readFileSync(path.join(repoRoot, 'src', 'mcp', 'tools.ts'), 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g),
]
  .map((match) => match[1])
  .sort();

const work = mkdtempSync(path.join(tmpdir(), 'sp-package-'));
const prefix = path.join(work, 'global');
const home = path.join(work, 'home');
mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, 'config.json'), JSON.stringify({ viewer: { launchMode: 'none' } }));

// A program for the session: says it is ready, then answers each line it reads.
// It ends by itself after ten minutes, so a check killed part-way does not
// leave a live session keeping its daemon awake.
const program = path.join(work, 'echo.mjs');
writeFileSync(
  program,
  [
    "process.stdout.write('SP_READY\\n');",
    "process.stdin.setEncoding('utf8');",
    "let pending = '';",
    "process.stdin.on('data', (chunk) => {",
    '  pending += chunk;',
    '  let end;',
    '  while ((end = pending.search(/[\\r\\n]/)) >= 0) {',
    '    const line = pending.slice(0, end);',
    '    pending = pending.slice(end + 1);',
    "    if (line !== '') process.stdout.write(`GOT:${line}\\n`);",
    '  }',
    '});',
    'setTimeout(() => process.exit(0), 10 * 60_000);',
    '',
  ].join('\n'),
);

/**
 * Quote an argument for cmd.exe. Quotes protect spaces and parentheses, but
 * cmd.exe still expands %NAME% inside them (and !NAME! when delayed expansion
 * is on), and a quote cannot be nested. npm's own command shim then sets its
 * directory without quotes, so &, ^, |, < and > in the install path break the
 * installed command. An argument with any of those would reach the command
 * changed, so it is refused instead.
 */
function forShell(arg) {
  if (!isWindows) return arg;
  if (/[%!"&^|<>\r\n]/.test(arg)) {
    throw new Error(
      `${JSON.stringify(arg)} cannot pass through cmd.exe and npm's command shim unchanged; ` +
        'use a path without % ! " & ^ | < or >',
    );
  }
  return /[\s()]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Run a command and return its result. On Windows the npm and ShellPuppet
 * command shims are `.cmd` files, which Node only starts through a shell.
 */
function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(forShell(command), args.map(forShell), {
    cwd: options.cwd ?? work,
    env: { ...process.env, SHELLPUPPET_HOME: home },
    encoding: 'utf8',
    input: options.input,
    shell: isWindows,
    timeout: options.timeout ?? 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    ms: Date.now() - started,
  };
}

/** How a command ended, including why it could not start or was stopped. */
function outcome(result) {
  return result.error ? `${result.error.code ?? 'error'}: ${result.error.message}` : `exit ${result.status}`;
}

/** GET a URL and return its status and body; status 0 when the request failed. */
function get(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 10_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('timeout', () => request.destroy(new Error('no answer within 10 s')));
    request.on('error', (error) => resolve({ status: 0, body: error.message }));
  });
}

const steps = [];
function check(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}

/** Thrown to end a run early on purpose; not a failure. */
class EndsHere extends Error {}

const npm = isWindows ? 'npm.cmd' : 'npm';
const installed = isWindows
  ? path.join(prefix, 'shellpuppet.cmd')
  : path.join(prefix, 'bin', 'shellpuppet');

function shellpuppet(...args) {
  return run(installed, args);
}

try {
  let tarball;
  if (given !== undefined) {
    tarball = path.resolve(given);
    const named = /^shellpuppet-.+\.tgz$/.test(path.basename(tarball));
    if (!check('tarball', named && existsSync(tarball), tarball)) {
      throw new Error('expected an existing shellpuppet-<version>.tgz');
    }
  } else {
    if (!existsSync(path.join(repoRoot, 'dist', 'cli', 'index.js'))) {
      throw new Error('dist/ is missing: run `npm run build` before this script.');
    }
    const packed = run(npm, ['pack', '--pack-destination', work, '--json'], { cwd: repoRoot });
    const name = readdirSync(work).find((entry) => /^shellpuppet-.*\.tgz$/.test(entry));
    if (!check('pack', packed.status === 0 && name !== undefined, name ?? outcome(packed))) {
      console.log(packed.stdout, packed.stderr);
      throw new Error('npm pack failed');
    }
    tarball = path.join(work, name);
  }

  // Which npm installs matters: npm 12 runs a dependency's install scripts
  // only when allowed. SP_SMOKE_INSTALL_ARGS adds arguments to the install,
  // such as --allow-scripts=node-pty (split on spaces).
  const npmVersion = run(npm, ['--version']);
  check('npm', npmVersion.status === 0, npmVersion.stdout.trim() || outcome(npmVersion));
  const extraInstallArgs = (process.env.SP_SMOKE_INSTALL_ARGS ?? '').split(' ').filter((arg) => arg !== '');
  const install = run(npm, ['install', '--global', '--prefix', prefix, ...extraInstallArgs, tarball], {
    timeout: 600_000,
  });
  if (!check('install from the tarball', install.status === 0, `${install.ms} ms, ${outcome(install)}`)) {
    console.log(install.stdout, install.stderr);
    throw new Error('install failed');
  }
  if (!check('command shim installed', existsSync(installed), installed)) {
    throw new Error('no command shim');
  }

  const expected = /^shellpuppet-(.+)\.tgz$/.exec(path.basename(tarball))[1];
  const version = shellpuppet('--version');
  check('--version', version.status === 0 && version.stdout.trim() === expected, version.stdout.trim() || outcome(version));

  // The MCP server: initialise, list the tools, then close its input, which
  // ends it.
  const handshake = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'package-check', version: expected },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];
  const mcp = run(installed, ['mcp'], {
    timeout: 30_000,
    input: handshake.map((message) => `${JSON.stringify(message)}\n`).join(''),
  });
  const replies = mcp.stdout.split('\n').map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  });
  const initialised = replies.find((message) => message?.id === 1)?.result !== undefined;
  const tools = (replies.find((message) => message?.id === 2)?.result?.tools ?? []).map((tool) => tool.name);
  const missingTools = registeredTools.filter((name) => !tools.includes(name));
  const unexpectedTools = tools.filter((name) => !registeredTools.includes(name));
  const toolsMatch = registeredTools.length > 0 && missingTools.length === 0 && unexpectedTools.length === 0;
  const mcpDetail = [
    toolsMatch
      ? `${tools.length} tools, as the source registers`
      : `${tools.length} listed, ${registeredTools.length} registered in the source`,
    missingTools.length > 0 ? `missing ${missingTools.join(', ')}` : '',
    unexpectedTools.length > 0 ? `unexpected ${unexpectedTools.join(', ')}` : '',
    initialised ? '' : 'no initialize result',
    outcome(mcp),
  ].filter((part) => part !== '');
  if (!check('MCP server lists its tools', mcp.status === 0 && initialised && toolsMatch, mcpDetail.join('; '))) {
    console.log(mcp.stderr);
  }

  // An install that cannot open a terminal (npm 12 on Linux without node-pty's
  // install script) must refuse the start with what to do, and leave the
  // daemon answering. SP_SMOKE_START_FAILS_WITH names text the refusal must
  // contain; with it set, the check ends here.
  const mustFailWith = process.env.SP_SMOKE_START_FAILS_WITH ?? '';
  if (mustFailWith !== '') {
    const refused = shellpuppet('start', '--label', 'package-check', '--no-shell', process.execPath, program);
    const said = `${refused.stdout}\n${refused.stderr}`.trim();
    // Exit code 1: the operation failed, as a completed command (not a
    // timeout, and not a request the CLI or daemon called malformed). The two
    // conditions are separate checks, so each one can fail on its own.
    check('start refuses', refused.status === 1, outcome(refused));
    check(
      'the refusal says what to do',
      said.includes(mustFailWith),
      said.replace(/\s+/g, ' ').slice(0, 400) || 'nothing printed',
    );
    // `daemon status` only looks for a daemon and never starts one, so a
    // running answer here is the daemon that refused the start, still up.
    const status = shellpuppet('daemon', 'status', '--json');
    let running = false;
    try {
      running = JSON.parse(status.stdout).running === true;
    } catch {
      running = false;
    }
    check('the daemon that refused it still answers', status.status === 0 && running, status.stdout.trim() || outcome(status));
    throw new EndsHere();
  }

  const started = shellpuppet('start', '--json', '--label', 'package-check', '--no-shell', process.execPath, program);
  let id;
  try {
    id = JSON.parse(started.stdout).id;
  } catch {
    id = undefined;
  }
  // The id goes back through the shell, so it must look like one the daemon issues.
  const idOk = typeof id === 'string' && /^s\d+$/.test(id);
  if (!check('start (daemon auto-started)', started.status === 0 && idOk, `${started.ms} ms, ${outcome(started)}`)) {
    console.log(started.stdout, started.stderr);
    throw new Error('start failed');
  }

  const ready = shellpuppet('wait', id, '--text', 'SP_READY', '--timeout', '30000');
  check('wait for the program', ready.status === 0, outcome(ready));

  const typed = shellpuppet('type', id, 'hello-from-the-package', '--enter');
  check('type', typed.status === 0, outcome(typed));

  const answered = shellpuppet('wait', id, '--text', 'GOT:hello-from-the-package', '--timeout', '30000');
  check('wait for the answer', answered.status === 0, outcome(answered));

  const screen = shellpuppet('snap', id);
  check('snap shows the answer', screen.status === 0 && screen.stdout.includes('GOT:hello-from-the-package'));

  // The viewer is files in the package too: open a fresh link the way a
  // browser would, then fetch everything the page asks for.
  const link = shellpuppet('viewer-url', id, '--json');
  let viewerUrl;
  try {
    viewerUrl = new URL(JSON.parse(link.stdout).viewerUrl);
  } catch {
    viewerUrl = undefined;
  }
  if (check('viewer link', link.status === 0 && viewerUrl !== undefined, outcome(link))) {
    const page = await get(viewerUrl);
    const assets = [...page.body.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]);
    const missing = [];
    for (const asset of assets) {
      const fetched = await get(new URL(asset, viewerUrl));
      if (fetched.status !== 200) {
        missing.push(`${asset} (${fetched.status === 0 ? fetched.body : `HTTP ${fetched.status}`})`);
      }
    }
    check(
      'viewer page and its files',
      page.status === 200 && assets.length > 0 && missing.length === 0,
      page.status === 200
        ? missing.join(', ') || `${assets.length} files`
        : `page: ${page.status === 0 ? page.body : `HTTP ${page.status}`}`,
    );
  }

  const killed = shellpuppet('kill', id);
  check('kill', killed.status === 0, outcome(killed));
} catch (error) {
  if (!(error instanceof EndsHere)) check('run', false, error instanceof Error ? error.message : String(error));
} finally {
  let stopped = true;
  if (existsSync(installed)) {
    let result;
    try {
      result = shellpuppet('daemon', 'stop', '--force');
    } catch (error) {
      result = { status: null, error };
    }
    stopped = check('daemon stop', result.status === 0, outcome(result));
  }
  if (stopped) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      // A file still held open on Windows is not a failure of the package.
      console.log(`note: ${work} was not removed (${error instanceof Error ? error.message : String(error)})`);
    }
  } else {
    // Keep the evidence: the daemon may still be running from this home.
    console.log(`The daemon may still be running. Its record and log are daemon.json and daemon.log in ${home}; ${work} is left in place.`);
  }
}

const failed = steps.some((step) => !step.ok);
console.log(failed ? 'Package check FAILED.' : 'Package check passed.');
process.exit(failed ? 1 : 0);
