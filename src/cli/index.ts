#!/usr/bin/env node
/**
 * ShellPuppet CLI: a thin, one-shot client over the daemon HTTP API
 * (design §2.4). Every invocation makes its request(s), prints and EXITS:
 * it never spawns anything it stays attached to. That one property is why the
 * CLI can never hang a calling shell (the inherited-stdio hang, §2.2).
 *
 * stdout carries results; warnings and errors go to stderr. Exit codes:
 * 0 success · 1 the operation failed · 2 the request itself was wrong, whether
 * this CLI caught it or the daemon refused it with a 400 · 3 wait did not
 * match, or find found nothing.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { DaemonGoneError, daemonStartMode, discoverDaemon, ensureDaemon, request, waitForPendingDaemon, withDaemonStartLock } from '../client/http.js';
import type { DaemonConnection } from '../client/http.js';
import { assertNodeVersion, packageVersion } from '../daemon/meta.js';
import { NO_MATCHES } from '../core/find.js';
import { resultRefusal } from '../core/reasoning.js';
import { inspectDaemonState, readDaemonState, shellpuppetHome } from '../daemon/paths.js';
import { clearRestartHold, readRestartHold, writeRestartHold } from '../daemon/restartHold.js';
import { planPassedEnv } from '../mcp/config.js';
import { isEnvNamesProblem, readDaemonConfig } from '../daemon/config.js';
import { agentNameFor } from '../core/reasoning.js';
import { knownKeys } from '../core/keys.js';
import { listedState, stallLine, startReadyLine } from '../core/types.js';
import type { StallState, StartReadyResult } from '../core/types.js';
import { installDesktopShortcut, uninstallDesktopShortcut, userShortcutOptions } from './desktopShortcut.js';
import type { Logger, SessionSummary } from '../core/types.js';

const USAGE = `ShellPuppet: drive a real terminal session; humans watch and type via the viewer.

Usage:
  shellpuppet start [options] <command> [args...]   Launch a program in a new session
      --label <s> --purpose <s> --cols <n> --rows <n> --cwd <dir>
      --ready-text <s> --ready-quiet <ms> --no-shell --hold --agent <name>
      --wait-ready --ready-timeout <ms>
      Pass --wait-ready when starting an agent CLI to delegate work to. It uses
      its known ready signals, or your --ready-text/--ready-quiet override.
      Returns for readiness, a question needing an answer, exit or timeout.
      --ready-timeout defaults to 30000 ms, capped at 300000. A longer wait
      needs a longer caller budget, including startup overhead. If the caller
      gives up, it may lose the answer; the session still exists in list.
      Readiness is tracked for up to five minutes from start. Unknown programs
      need an explicit condition. Without --wait-ready, start returns without waiting.
      --env-name <NAME> (repeatable) --no-viewer
      --no-viewer opens no dashboard or viewer window, for a short scripted session nobody
      needs to watch; viewer-url still gives a link to it.
      --cwd sets the folder the session starts in; it defaults to THIS shell's
      working directory, and a relative --cwd is taken from there.
      A session that runs as an agent CLI receives, from THIS shell's
      environment, the variables listed for that agent in agents.passEnv in
      config.json, with no flag. --env-name copies another variable, for a
      program that is not an agent CLI: only names listed in envNames in
      config.json pass, and any other name refuses the start. Values are
      never printed or logged.
      --agent names the agent CLI the session runs (claude, codex, muse, qoder...)
      when it is reached through a shell or a launcher script, so that
      --hide-reasoning and result can read its screen.
      --cols/--rows say where to START; the human's viewer reshapes the grid to
      its window unless --hold keeps it, which is for runs you compare against
      a known width.
      --purpose says what the session is FOR; it titles the viewer window.
      --no-shell starts the command without a shell; on Windows it must then
      be an .exe or .com, so start a script through the shell. A command with
      a path separator is resolved from the session's working directory, and
      a file name containing ':' is refused as an alternate data stream.
      On Windows, the default uses cmd.exe /d /s /c. Arguments are joined as
      shell text: quote spaces for cmd.exe, for example pass the one argument
      'mcp_servers.x.command="C:/Program Files/nodejs/node.exe"' from Git Bash.
      cmd.exe also expands %NAME% and interprets ^ & | < >. Use --no-shell
      with an .exe or .com when each argument must arrive literally.
      Options go BEFORE the command; everything after the command is passed
      to the daemon unchanged (so its own --flags survive).
  shellpuppet list [--waiting] [--hide-reasoning]   List sessions, or only waiting prompts
  shellpuppet snap <id> [--last <n>] [--hide-reasoning]
                                                    Print the rendered screen
      --hide-reasoning leaves out an agent CLI's reasoning, each block as one
      "[reasoning hidden: N lines]" line; a session whose agent has no
      signature is refused (exit 2), never printed unfiltered.
  shellpuppet result <id> [--hide-reasoning]        Print the agent's latest answer
      The answer that ends the latest turn, and its turn summary: never its
      reasoning. --hide-reasoning is accepted but changes nothing: result
      always leaves reasoning out. Exits 3, with the reason on stderr, while
      the agent is still working or when no answer is recognised.
  shellpuppet type <id> <text> [--enter] [--verify] Type text (--verify re-reads the screen,
                                                    for up to 15 s on long text)
  shellpuppet key <id> <name>                       Press a key (enter, escape, ctrl+c, f1…)
  shellpuppet wait <id> [--text <s>|--regex <r>|--quiet <ms>|--prompt|--stalled]
                        [--timeout <ms>] [--debounce <ms>] [--match-after-input true|false]
                        [--hide-reasoning]
                                                    Wait for a condition, print the screen
                        --prompt waits until the session asks a permission question
                        (the one you just answered does not count until it has been
                        seen to go; --match-after-input false accepts any prompt)
                        --stalled waits for a supported idle provider error, with
                        fixed reason and since metadata; combine with --prompt
                        --match-after-input true ignores text/regex matches at or
                        before the echo of what you last typed
                        --debounce waits for the condition to hold on every poll
                        for this many ms; a missed poll restarts it, while other
                        output such as a ticking timer does not; a match on the
                        final screen settles at once if the program exits
  shellpuppet wait [--prompt] [--stalled] [id ...] [--now] [--timeout <ms>] [--hide-reasoning]
                                                    Wait for any listed session's prompt or stall,
                                                    or every live session if no ids are given;
                                                    --now polls once without waiting
  shellpuppet find <id> <pattern> [--hide-reasoning]
                                                    Regex-search the screen, with line numbers
      Prints each matching line as <row>: <text>. Nothing matching prints
      "No matches." on stderr, never the pattern, and exits 3 (with --json
      too, after printing the empty result).
  shellpuppet screenshot <id> [--out <f>] [--hide-reasoning]
                             [--width <n>] [--height <n>] [--timeout <ms>]
                                                    Photograph the viewer as a browser draws it
      Defaults to shellpuppet-<id>.png at 1400x900, with 45 s for the whole
      capture (--timeout, 1000 to 120000, for a slow or a hurried machine).
      Needs a Chromium-family browser; it cannot type into the session or
      change its size.
  shellpuppet viewer-url <id> [--read-only]         Mint a fresh viewer link (single use)
      Links work once and expire after a few minutes; mint another whenever
      the human needs one. --read-only grants watching without typing, and the
      daemon enforces it rather than the page.
  shellpuppet dashboard                             Open the dashboard in its own window
      One window for every session, in ShellPuppet's isolated browser profile.
      Prints whether a window opened, never the link.
  shellpuppet desktop [--install|--uninstall]       Start ShellPuppet and open its dashboard
      Reuses a connected dashboard. --install adds or updates a per-user shortcut;
      --uninstall removes that shortcut. Neither option starts the daemon.
  shellpuppet resize <id> <cols> <rows> [--hold]    Set screen geometry
      Without --hold the human's window reshapes it again the moment they
      move it, which is what lets the viewer fill.
  shellpuppet kill <id>                             Kill the session and its process tree
  shellpuppet daemon status|start|stop|restart      Manage the shared daemon
      start/restart: --direct starts without daemon.startWith.
      stop/restart: --force to kill live sessions. status and stop never
      start a daemon: one that has gone is reported as not running.
      stop: --hold [seconds] prevents auto-start for 120 s by default (1 to 600).
  shellpuppet mcp                                   Run the MCP stdio server (long-running)
  shellpuppet --version | --help

Any verb accepts --json for the raw API response.

Exit codes: 0 ok · 1 the operation failed · 2 the request itself was wrong,
whether this CLI caught it (an unknown verb, a missing id or a flag without
its value) or the daemon refused it with a 400 (an unparsable --regex, a grid
outside the bounds) · 3 the wait did not match, or find found nothing, so
scripts can branch on either; result exits 3 when there is no answer yet.
Waiting for text you just typed matches its own echo, so pass
--match-after-input true, wait for output-only text or use --quiet.`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
  /** Every value of each repeatable flag, in the order given. */
  lists: Map<string, string[]>;
}

/** Flags that take a value and may be given more than once. */
const REPEAT_FLAGS = new Set(['env-name']);

/** Flags that take a value; everything else `--x` is boolean. */
const VALUE_FLAGS = new Set([
  'label',
  'agent',
  // Omitting a value-taking flag here does not fail loudly: the flag silently
  // becomes boolean `true` and its VALUE becomes the first positional, i.e.
  // the command to run, so `--purpose "Fix the failing login test"` would
  // send that whole string to cmd.exe as a program name.
  'purpose',
  'cols',
  'rows',
  'cwd',
  'ready-text',
  'ready-quiet',
  'ready-timeout',
  'last',
  'text',
  'regex',
  'quiet',
  'timeout',
  'debounce',
  'match-after-input',
  'out',
  'width',
  'height',
]);

/**
 * `stopAtFirstPositional` is how `start` avoids eating the target command's
 * own flags: `shellpuppet start [options] <command> [args...]`. Once the
 * command appears, everything after it (including `--version`, `--help`,
 * anything) belongs to the command verbatim: `start goose --version` hands
 * `--version` to Goose.
 */
function parseArgs(argv: string[], stopAtFirstPositional = false): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const lists = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--') || (stopAtFirstPositional && positionals.length > 0)) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (REPEAT_FLAGS.has(name)) {
      const value = argv[++i];
      if (value === undefined) fail(2, `--${name} needs a value.`);
      lists.set(name, [...(lists.get(name) ?? []), value]);
    } else if (name === 'hold' && argv[0] === 'stop' && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith('--')) {
      flags.set(name, argv[++i] ?? '');
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[++i];
      if (value === undefined) fail(2, `--${name} needs a value.`);
      flags.set(name, value);
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags, lists };
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function intFlag(parsed: ParsedArgs, name: string): number | undefined {
  const raw = parsed.flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(2, `--${name} must be an integer.`);
  return value;
}

const stderrLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message) => console.error(`warning: ${message}`),
  error: (message) => console.error(`error: ${message}`),
};

function surfaceWarnings(connection: DaemonConnection): void {
  for (const warning of connection.warnings) console.error(`warning: ${warning}`);
}

type Body = Record<string, unknown>;

async function call(
  connection: DaemonConnection,
  method: string,
  path: string,
  body?: unknown,
  options: { autoStart?: boolean } = {},
): Promise<Body> {
  const response = await request(connection, method, path, body, {
    logger: stderrLogger,
    actor: 'cli',
    ...options,
  });
  const payload = response.body as Body;
  if (response.status >= 400) {
    const message = typeof payload['error'] === 'string' ? payload['error'] : 'request failed';
    // A 400 is the daemon refusing THIS caller's own input: an unparsable
    // `--regex`, a grid outside the bounds, a `cwd` that is not one. That is
    // the same kind of mistake as a flag this CLI rejects itself, so it gets
    // the same exit code, and a script can tell "I asked wrongly" from "it
    // did not work" without reading the message. Everything else, meaning
    // 401, 403, 404, 409, 5xx and any transport failure, is the operation
    // failing and stays 1.
    fail(response.status === 400 ? 2 : 1, `error (${String(response.status)}): ${message}`);
  }
  return payload;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  assertNodeVersion();
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const parsed = parseArgs(argv.slice(1), verb === 'start');
  const wantJson = parsed.flags.get('json') === true;

  // `--help` and `-h` as the FIRST argument are answered here, with `help` and
  // `--version`, before any daemon contact: the unknown-verb branch runs
  // AFTER ensureDaemon(), and asking for help must not start a daemon.
  if (
    verb === undefined ||
    verb === 'help' ||
    verb === '--help' ||
    verb === '-h' ||
    parsed.flags.get('help') === true
  ) {
    console.log(USAGE);
    process.exit(verb === undefined ? 2 : 0);
  }
  if (verb === '--version' || verb === 'version') {
    console.log(packageVersion());
    process.exit(0);
  }

  if (verb === 'mcp') {
    // The one long-running verb: importing the MCP entry starts a stdio MCP
    // server that owns the process until its client disconnects. Nothing may
    // touch stdout before the transport does.
    await import('../mcp/index.js');
    return;
  }

  if (verb === 'daemon') {
    await daemonVerb(parsed, wantJson);
    process.exit(0);
  }
  if (verb === 'desktop' && (parsed.flags.has('install') || parsed.flags.has('uninstall'))) {
    if (parsed.flags.has('install') && parsed.flags.has('uninstall')) fail(2, 'Choose --install or --uninstall.');
    if (parsed.positionals.length > 0) fail(2, 'desktop takes no positional arguments.');
    const options = userShortcutOptions();
    console.log(parsed.flags.has('install') ? installDesktopShortcut(options) : uninstallDesktopShortcut(options));
    process.exit(0);
  }

  const connection = await ensureDaemon({ logger: stderrLogger });
  surfaceWarnings(connection);

  switch (verb) {
    case 'start': {
      const command = parsed.positionals[0];
      if (command === undefined) fail(2, 'start needs a command. See --help.');
      const body: Body = {
        command,
        args: parsed.positionals.slice(1),
        ...(parsed.flags.has('label') ? { label: String(parsed.flags.get('label')) } : {}),
        ...(parsed.flags.has('purpose') ? { purpose: String(parsed.flags.get('purpose')) } : {}),
        ...(parsed.flags.has('agent') ? { agent: String(parsed.flags.get('agent')) } : {}),
        ...(intFlag(parsed, 'cols') !== undefined ? { cols: intFlag(parsed, 'cols') } : {}),
        ...(intFlag(parsed, 'rows') !== undefined ? { rows: intFlag(parsed, 'rows') } : {}),
        // This shell's working directory, or --cwd taken from it: the daemon
        // runs elsewhere, so a folder is always sent, and always absolute.
        cwd: resolve(parsed.flags.has('cwd') ? String(parsed.flags.get('cwd')) : '.'),
        ...(parsed.flags.has('ready-text')
          ? { readyText: String(parsed.flags.get('ready-text')) }
          : {}),
        ...(parsed.flags.get('wait-ready') === true ? { waitReady: true } : {}),
        ...(intFlag(parsed, 'ready-timeout') !== undefined ? { readyTimeout: intFlag(parsed, 'ready-timeout') } : {}),
        ...(intFlag(parsed, 'ready-quiet') !== undefined
          ? { readyQuiet: intFlag(parsed, 'ready-quiet') }
          : {}),
        ...(parsed.flags.get('no-shell') === true ? { shell: false } : {}),
        ...(parsed.flags.get('hold') === true ? { hold: true } : {}),
        ...(parsed.flags.get('no-viewer') === true ? { openViewer: false } : {}),
      };
      // The same lists and the same rules as terminal_start. The CLI reads
      // config.json on every run, so a change to a list needs no restart here.
      const daemonConfig = readDaemonConfig(shellpuppetHome());
      const agent = agentNameFor(
        parsed.flags.has('agent') ? String(parsed.flags.get('agent')) : undefined,
        command,
        daemonConfig.config.agentSignatures ?? [],
      );
      const envNames = parsed.lists.get('env-name') ?? [];
      if (envNames.length > 0) {
        for (const problem of daemonConfig.problems.filter(isEnvNamesProblem)) console.error(`warning: ${problem}`);
      }
      const plan = planPassedEnv({
        agent,
        requested: envNames,
        agentLists: daemonConfig.config.agentPassEnv ?? {},
        adHoc: daemonConfig.config.envNames ?? [],
        environment: process.env,
        source: "this shell's environment",
      });
      if (plan.refusedForAgent.length > 0) {
        const names = plan.refusedForAgent;
        fail(
          2,
          `Not started: this session runs as ${String(agent)}, whose variables come from ` +
            `agents.passEnv.${String(agent)} in ~/.shellpuppet/config.json, and ` +
            `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not on it. List ` +
            `${names.length === 1 ? 'it' : 'them'} there, or start without --env-name.`,
        );
      }
      if (plan.refused.length > 0) {
        const names = plan.refused;
        fail(
          2,
          `Not started: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not listed in ` +
            `envNames in ~/.shellpuppet/config.json, the variables you allow to be passed into a ` +
            `session. Add ${names.length === 1 ? 'it' : 'them'} to that list, or start without ` +
            `${names.length === 1 ? 'it' : 'them'}.`,
        );
      }
      if (agent !== null) {
        for (const problem of daemonConfig.problems.filter((p) => p.startsWith('agents'))) {
          console.error(`warning: ${problem}`);
        }
      }
      if (Object.keys(plan.env).length > 0) body['env'] = plan.env;
      for (const note of plan.notes) console.error(note);
      const result = await call(connection, 'POST', '/sessions', body);
      if (wantJson) printJson(result);
      else {
        console.log(`${String(result['id'])}  ${String(result['label'])}`);
        const viewer = result['viewer'] as { opened?: boolean; mode?: string; reason?: string } | undefined;
        if (viewer?.mode === 'dashboard' && viewer.opened === true) {
          console.log('viewer: opened in the dashboard');
        } else if (viewer?.mode === 'dashboard' && viewer.reason === 'a dashboard is connected') {
          console.log('viewer: session is in the connected dashboard');
        } else if (viewer?.mode === 'dashboard' && viewer.reason === 'a dashboard window is opening') {
          console.log(`viewer: dashboard window launch is in progress (if it does not show the session, run shellpuppet viewer-url ${String(result['id'])} for a link)`);
        } else if (viewer?.opened === true) {
          const how = viewer.reason !== undefined ? `, ${viewer.reason}` : '';
          console.log(`viewer: window opened${how} (viewer-url ${String(result['id'])} mints a link)`);
        } else if (typeof result['viewerUrl'] === 'string') {
          const why = viewer?.reason !== undefined ? ` (${viewer.reason})` : '';
          console.log(`viewer: no window opened${why}; link: ${result['viewerUrl']}`);
        } else {
          console.log(`viewer: no window opened (--no-viewer); viewer-url ${String(result['id'])} mints a link`);
        }
        const readyWait = result['readyWait'] as StartReadyResult | undefined;
        if (readyWait !== undefined) {
          console.log(startReadyLine(readyWait, result['exitCode'] as number | null, result['readyReason']));
          if (readyWait.prompt !== undefined) console.log(JSON.stringify(readyWait.prompt, null, 2));
        } else if (result['ready'] !== true) {
          console.log('ready: false. First paint is not readiness; wait before typing.');
        }
      }
      break;
    }

    case 'list': {
      const query = new URLSearchParams();
      if (parsed.flags.get('hide-reasoning') === true) query.set('hideReasoning', '1');
      if (parsed.flags.get('waiting') === true) query.set('waitingOnly', '1');
      const result = await call(connection, 'GET', `/sessions${query.size > 0 ? `?${query.toString()}` : ''}`);
      if (wantJson) {
        printJson(result);
        break;
      }
      const sessions = result['sessions'] as SessionSummary[];
      if (sessions.length === 0) {
        console.log('no sessions');
        break;
      }
      for (const s of sessions) {
        if (parsed.flags.get('waiting') === true) {
          const waiting = s as unknown as { id: string; label: string; question?: string; options?: string[]; selectedOption?: number; waitingMs: number };
          console.log(`${waiting.id}  ${waiting.label}  WAITING ${String(Math.round(waiting.waitingMs / 1000))}s` + (waiting.question === undefined ? '' : `: ${waiting.question}`));
          for (const [index, option] of (waiting.options ?? []).entries()) console.log(`    ${index === waiting.selectedOption ? '* ' : '  '}${option}`);
          continue;
        }
        console.log(
          `${s.id}  ${listedState(s)}  ` +
            `${String(s.cols)}x${String(s.rows)}  watchers:${String(s.watchers)}  ` +
            `${s.stalled !== undefined ? stallLine(s.stalled) : s.ready ? 'ready' : 'NOT-READY'}  ${s.label}` +
            (s.agent !== null && s.agent !== undefined ? `  agent:${s.agent}` : ''),
        );
        const waiting = (s as SessionSummary & {
          waitingOnPrompt?: { question: string; selectedOption?: number; waitingMs: number };
        }).waitingOnPrompt;
        if (waiting !== undefined) {
          console.log(
            `    WAITING ${String(Math.round(waiting.waitingMs / 1000))}s on a prompt` +
              (waiting.question === undefined ? '' : `: ${waiting.question}`),
          );
          if (waiting.selectedOption !== undefined) console.log(`    selectedOption: ${String(waiting.selectedOption)} (zero-based)`);
        }
      }
      break;
    }

    case 'snap': {
      const id = parsed.positionals[0] ?? fail(2, 'snap needs a session id.');
      const last = intFlag(parsed, 'last');
      const query = [
        ...(last !== undefined ? [`lastLines=${String(last)}`] : []),
        ...(parsed.flags.get('hide-reasoning') === true ? ['hideReasoning=1'] : []),
      ];
      const path = `/sessions/${id}/snapshot${query.length > 0 ? `?${query.join('&')}` : ''}`;
      const result = await call(connection, 'GET', path);
      if (wantJson) printJson(result);
      else if (last !== undefined) console.log((result['lastLines'] as string[]).join('\n'));
      else console.log(String(result['screen']));
      break;
    }

    case 'result': {
      const id = parsed.positionals[0] ?? fail(2, 'result needs a session id.');
      const result = await call(connection, 'GET', `/sessions/${id}/result`);
      if (wantJson) printJson(result);
      else if (result['found'] === true) {
        const lines = [
          ...((result['answer'] as string[] | undefined) ?? []),
          ...((result['trailer'] as string[] | undefined) ?? []),
        ];
        for (const line of lines) console.log(line);
        // The prompt it answers, on stderr: stdout stays the answer alone.
        if (typeof result['prompt'] === 'string') console.error(`in answer to: ${result['prompt'].trim()}`);
      } else console.error(resultRefusal(String(result['reason'])));
      if (result['found'] !== true) process.exit(3);
      break;
    }

    case 'type': {
      const id = parsed.positionals[0] ?? fail(2, 'type needs a session id.');
      const text = parsed.positionals[1] ?? fail(2, 'type needs text.');
      const data = parsed.flags.get('enter') === true ? `${text}\r` : text;
      const result = await call(connection, 'POST', `/sessions/${id}/input`, {
        data,
        ...(parsed.flags.get('verify') === true ? { verify: true } : {}),
      });
      if (wantJson) printJson(result);
      else if (result['verified'] === false) {
        console.log(
          'typed, but the text did NOT appear on screen. The app may still be ' +
            'loading, a panel may have focus or, commonly with --enter, the app ' +
            'accepted it and cleared the input box. Run `shellpuppet snap <id>` FIRST: ' +
            'if the agent is working, it landed. Escape resets focus but is CANCEL in ' +
            'agent CLIs, so do not reach for it before you have looked.',
        );
        process.exit(1);
      } else {
        // Positive confirmation matters: with --verify the whole point is
        // knowing the keystrokes landed, so say so rather than printing the
        // same line as an unverified type.
        console.log(
          `typed ${String(result['bytes'])} bytes` +
            (result['verified'] === true ? ' (verified on screen).' : '.'),
        );
      }
      break;
    }

    case 'key': {
      const id = parsed.positionals[0] ?? fail(2, 'key needs a session id.');
      const key = parsed.positionals[1] ?? fail(2, `key needs a key name: ${knownKeys().join(', ')}`);
      const result = await call(connection, 'POST', `/sessions/${id}/key`, { key });
      if (wantJson) printJson(result);
      else console.log(`sent ${String(result['key'])}`);
      break;
    }

    case 'wait': {
      const multi = (parsed.flags.get('prompt') === true || parsed.flags.get('stalled') === true) && (parsed.positionals.length !== 1 || parsed.flags.get('now') === true);
      if (multi) {
        for (const name of ['text', 'regex', 'quiet', 'debounce', 'match-after-input']) {
          if (parsed.flags.has(name)) fail(2, 'A multi-session wait accepts --prompt and/or --stalled, --timeout, --now and --hide-reasoning only.');
        }
        const params = new URLSearchParams();
        if (parsed.flags.get('prompt') === true) params.set('prompt', 'true');
        if (parsed.flags.get('stalled') === true) params.set('stalled', 'true');
        for (const id of parsed.positionals) params.append('session', id);
        if (parsed.flags.get('now') === true) params.set('now', 'true');
        if (parsed.flags.has('timeout')) params.set('timeout', String(parsed.flags.get('timeout')));
        if (parsed.flags.get('hide-reasoning') === true) params.set('hideReasoning', '1');
        const result = await call(connection, 'GET', `/sessions/wait?${params.toString()}`);
        if (wantJson) printJson(result);
        else {
          for (const waiting of result['sessions'] as { id: string; label: string; stalled?: StallState; question?: string; options?: string[]; selectedOption?: number; waitingMs: number }[]) {
            if (waiting.stalled !== undefined) { console.log(`${waiting.id}  ${waiting.label}  ${stallLine(waiting.stalled)}`); continue; }
            console.log(`${waiting.id}  ${waiting.label}  WAITING ${String(Math.round(waiting.waitingMs / 1000))}s` + (waiting.question === undefined ? '' : `: ${waiting.question}`));
            for (const [index, option] of (waiting.options ?? []).entries()) console.log(`    ${index === waiting.selectedOption ? '* ' : '  '}${option}`);
          }
          console.error(`${result['matched'] === true ? 'matched' : 'NOT matched'} (${String(result['reason'])}, ${String(result['waitedMs'])} ms)`);
        }
        if (result['matched'] !== true && parsed.flags.get('now') !== true) process.exit(3);
        break;
      }
      const id = parsed.positionals[0] ?? fail(2, 'wait needs a session id.');
      const params = new URLSearchParams();
      for (const name of ['text', 'regex', 'quiet', 'timeout', 'debounce', 'prompt', 'stalled'] as const) {
        const value = parsed.flags.get(name);
        if (value !== undefined) params.set(name, String(value));
      }
      const afterInput = parsed.flags.get('match-after-input');
      if (afterInput !== undefined) params.set('matchAfterInput', String(afterInput));
      if (parsed.flags.get('hide-reasoning') === true) params.set('hideReasoning', '1');
      const result = await call(connection, 'GET', `/sessions/${id}/wait?${params.toString()}`);
      if (wantJson) printJson(result);
      else {
        console.error(
          `${result['matched'] === true ? 'matched' : 'NOT matched'} ` +
            `(${String(result['reason'])}, ${String(result['waitedMs'])} ms)`,
        );
        // The waiter's own explanation of a non-match ("has not painted
        // anything yet"), when it has one. It goes to stderr, with the outcome
        // line.
        if (typeof result['detail'] === 'string') console.error(result['detail']);
        if (result['stalled'] !== undefined) console.error(stallLine(result['stalled'] as StallState));
        const detected = result['prompt'] as { question: string; options: string[]; selectedOption?: number } | undefined;
        if (detected !== undefined) {
          // stderr, like the outcome line: stdout stays the screen alone, so
          // piping `wait` into a file or a diff keeps working unchanged.
          console.error(`prompt: ${detected.question}`);
          // No re-numbering: the options are captured verbatim and already
          // carry the numbers the TUI drew, so counting again gives
          // "1. 1. Allow once", and the number the human must press is the
          // program's, not ours.
          for (const option of detected.options) console.error(`  ${option}`);
          if (detected.selectedOption !== undefined) console.error(`selectedOption: ${String(detected.selectedOption)} (zero-based)`);
        }
        console.log(String(result['screen']));
      }
      if (result['matched'] !== true) process.exit(3);
      break;
    }

    case 'find': {
      const id = parsed.positionals[0] ?? fail(2, 'find needs a session id.');
      const pattern = parsed.positionals[1] ?? fail(2, 'find needs a pattern.');
      const result = await call(
        connection,
        'GET',
        `/sessions/${id}/find?pattern=${encodeURIComponent(pattern)}` +
          (parsed.flags.get('hide-reasoning') === true ? '&hideReasoning=1' : ''),
      );
      const matches = result['matches'] as { line: number; text: string }[];
      if (wantJson) printJson(result);
      else {
        // stdout holds matching lines and nothing else, so a script reads the
        // verdict from the exit code and never from the wording.
        for (const m of matches) console.log(`${String(m.line)}: ${m.text}`);
        if (matches.length === 0) console.error(NO_MATCHES);
        if (result['truncated'] === true) console.error('warning: matches truncated at 100');
      }
      if (matches.length === 0) process.exit(3);
      break;
    }

    case 'screenshot': {
      const id = parsed.positionals[0] ?? fail(2, 'screenshot needs a session id.');
      const out = parsed.flags.has('out')
        ? String(parsed.flags.get('out'))
        : `shellpuppet-${id}.png`;
      const result = await call(connection, 'POST', `/sessions/${id}/screenshot`, {
        ...(intFlag(parsed, 'width') !== undefined ? { width: intFlag(parsed, 'width') } : {}),
        ...(intFlag(parsed, 'height') !== undefined ? { height: intFlag(parsed, 'height') } : {}),
        ...(intFlag(parsed, 'timeout') !== undefined
          ? { timeoutMs: intFlag(parsed, 'timeout') }
          : {}),
        ...(parsed.flags.get('hide-reasoning') === true ? { hideReasoning: true } : {}),
      });
      const png = Buffer.from(String(result['png']), 'base64');
      await writeFile(out, png);
      if (wantJson) printJson({ ...result, png: `<${String(png.length)} bytes>`, path: resolve(out) });
      else {
        console.log(resolve(out));
        console.log(
          `${String(result['width'])}x${String(result['height'])} px, ` +
            `grid ${String(result['cols'])}x${String(result['rows'])}, ` +
            `${String(png.length)} bytes`,
        );
      }
      break;
    }

    case 'dashboard': {
      const result = await call(connection, 'POST', '/dashboard/open', {});
      if (wantJson) printJson(result);
      else console.log('dashboard: window opened');
      break;
    }
    case 'desktop': {
      if (parsed.positionals.length > 0) fail(2, 'desktop takes no positional arguments.');
      const result = await call(connection, 'POST', '/desktop/open', {});
      if (wantJson) printJson(result);
      else console.log(result['alreadyOpen'] === true
        ? 'ShellPuppet is already open. If you cannot see it, run shellpuppet dashboard.'
        : 'ShellPuppet desktop: window opened');
      break;
    }

    case 'viewer-url': {
      const id = parsed.positionals[0] ?? fail(2, 'viewer-url needs a session id.');
      const readOnly = parsed.flags.get('read-only') === true;
      const result = await call(connection, 'POST', `/sessions/${id}/viewer`, { readOnly });
      if (wantJson) printJson(result);
      else {
        const minutes = Math.round(Number(result['expiresInMs']) / 60_000);
        console.log(String(result['viewerUrl']));
        console.log(
          `${result['readOnly'] === true ? 'watch-only' : 'watch and type'}, single use, ` +
            `expires in about ${String(minutes)} min`,
        );
      }
      break;
    }

    case 'resize': {
      const id = parsed.positionals[0] ?? fail(2, 'resize needs a session id.');
      const cols = Number(parsed.positionals[1]);
      const rows = Number(parsed.positionals[2]);
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
        fail(2, 'resize needs integer cols and rows.');
      }
      const hold = parsed.flags.get('hold') === true;
      const result = await call(connection, 'POST', `/sessions/${id}/resize`, {
        cols,
        rows,
        hold,
      });
      if (wantJson) printJson(result);
      else {
        console.log(
          `resized to ${String(result['cols'])}x${String(result['rows'])}` +
            (result['geometryHeld'] === true ? ' (held against the viewer)' : ''),
        );
      }
      break;
    }

    case 'kill': {
      const id = parsed.positionals[0] ?? fail(2, 'kill needs a session id.');
      const result = await call(connection, 'DELETE', `/sessions/${id}`);
      if (wantJson) printJson(result);
      else console.log(`killed ${String(result['killed'])} (whole process tree)`);
      break;
    }

    default:
      fail(2, `Unknown verb: ${verb}. See --help.`);
  }
  process.exit(0);
}

async function daemonVerb(parsed: ParsedArgs, wantJson: boolean): Promise<void> {
  const sub = parsed.positionals[0];
  const force = parsed.flags.get('force') === true;
  const direct = parsed.flags.get('direct') === true;
  if (direct && sub !== 'start' && sub !== 'restart') fail(2, '--direct applies only to daemon start or restart.');
  const holdFlag = parsed.flags.get('hold');
  if (holdFlag !== undefined && sub !== 'stop') fail(2, '--hold applies only to daemon stop.');
  const holdSeconds = holdFlag === undefined ? undefined : holdFlag === true ? 120 : Number(holdFlag);
  if (holdSeconds !== undefined && (!Number.isInteger(holdSeconds) || holdSeconds < 1 || holdSeconds > 600)) {
    fail(2, '--hold needs a whole number of seconds from 1 to 600.');
  }

  // Every request here passes `autoStart: false`: asking about or stopping a
  // daemon must never start one, so a daemon that goes between being found
  // and being asked is reported as not running.
  const daemonOnly = { autoStart: false };

  /** Stop the daemon, or say false when it had already gone. */
  const stopRunning = async (connection: DaemonConnection): Promise<boolean> => {
    let response;
    try {
      response = await request(connection, 'POST', '/daemon/shutdown', { force }, {
        logger: stderrLogger,
        actor: 'cli',
        ...daemonOnly,
      });
    } catch (error) {
      if (error instanceof DaemonGoneError) return false;
      throw error;
    }
    if (response.status === 409) {
      fail(1, `${String((response.body as Body)['error'])} (use --force)`);
    }
    // Wait for the port to actually go quiet so restart cannot race it.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${String(connection.port)}/health`, {
          signal: AbortSignal.timeout(400),
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch {
        return true;
      }
    }
    fail(1, 'daemon did not stop within 10 s. Check daemon.log.');
  };

  switch (sub) {
    case 'status': {
      const hold = readRestartHold(shellpuppetHome(), stderrLogger);
      const holdRemainingSeconds = hold === null ? undefined : Math.max(1, Math.ceil((hold.expiresAt - Date.now()) / 1000));
      const notRunning = (): void => {
        console.log(wantJson ? JSON.stringify({ running: false, ...(holdRemainingSeconds !== undefined ? { holdRemainingSeconds } : {}) }) :
          `not running${holdRemainingSeconds === undefined ? '' : `; restart hold ends in ${String(holdRemainingSeconds)} s`}`);
      };
      const connection = await discoverDaemon({ logger: stderrLogger });
      if (connection === null) {
        notRunning();
        return;
      }
      let sessions: Body;
      try {
        sessions = await call(connection, 'GET', '/sessions', undefined, daemonOnly);
      } catch (error) {
        if (error instanceof DaemonGoneError) {
          notRunning();
          return;
        }
        throw error;
      }
      surfaceWarnings(connection);
      const list = sessions['sessions'] as SessionSummary[];
      const startedWrapped = readDaemonState(shellpuppetHome())?.startedWrapped === true;
      // What sessions inherit (ADR-008). A daemon that cannot say is left out
      // of the report rather than failing it.
      const environment = await request(connection, 'GET', '/environment', undefined, {
        logger: stderrLogger,
        actor: 'cli',
        ...daemonOnly,
      })
        .then((response) =>
          response.status === 200 ? (response.body as { mode: string; exposed: string[] }) : undefined,
        )
        .catch(() => undefined);
      if (wantJson) {
        printJson({
          running: true,
          port: connection.port,
          version: connection.version,
          sessions: list,
          startedWrapped,
          ...(holdRemainingSeconds !== undefined ? { holdRemainingSeconds } : {}),
          ...(environment !== undefined ? { sessionEnv: environment } : {}),
        });
      } else {
        console.log(
          `running on port ${String(connection.port)}, version ${connection.version}, ` +
            `${String(list.length)} session(s), started wrapped: ${String(startedWrapped)}` +
            (holdRemainingSeconds !== undefined ? `, restart hold ends in ${String(holdRemainingSeconds)} s` : '') +
            (environment !== undefined ? `, session environment ${environment.mode}` : ''),
        );
        if (environment !== undefined && environment.exposed.length > 0) {
          console.error(
            `warning: sessionEnv "passthrough" hands every session the daemon's whole ` +
              `environment, including ${String(environment.exposed.length)} variable(s) ` +
              `whose names look like credentials: ${environment.exposed.join(', ')}`,
          );
        }
      }
      return;
    }
    // `--help` says every verb accepts --json, so these three answer in JSON
    // when asked, and a script driving the daemon need not parse English.
    case 'start': {
      const { connection, alreadyRunning } = await withDaemonStartLock({ logger: stderrLogger }, async (lock) => {
        clearRestartHold(shellpuppetHome());
        const existing = await discoverDaemon({ logger: stderrLogger });
        return existing !== null ? { connection: existing, alreadyRunning: true } :
          { connection: await ensureDaemon({ logger: stderrLogger, direct }, lock), alreadyRunning: false };
      });
      if (alreadyRunning) {
        surfaceWarnings(connection);
        if (wantJson) {
          printJson({ running: true, port: connection.port, version: connection.version, startedWrapped: readDaemonState(shellpuppetHome())?.startedWrapped === true });
        } else console.log(`already running on port ${String(connection.port)}`);
        return;
      }
      surfaceWarnings(connection);
      if (wantJson) {
        printJson({ running: true, port: connection.port, version: connection.version, startedWrapped: readDaemonState(shellpuppetHome())?.startedWrapped === true });
      } else {
        console.log(`started on port ${String(connection.port)}, version ${connection.version}`);
      }
      return;
    }
    case 'stop': {
      if (holdSeconds !== undefined) {
        const stopped = await withDaemonStartLock({ logger: stderrLogger }, async () => {
          const existing = await discoverDaemon({ logger: stderrLogger });
          const didStop = existing !== null && await stopRunning(existing);
          writeRestartHold(shellpuppetHome(), holdSeconds);
          return didStop;
        });
        if (wantJson) printJson({ running: false, stopped: true, holdRemainingSeconds: holdSeconds });
        else console.log(stopped ? `stopped; restart hold ends in ${String(holdSeconds)} s` :
          `not running; restart hold ends in ${String(holdSeconds)} s`);
        return;
      }
      const connection = await waitForPendingDaemon({ logger: stderrLogger });
      // A daemon that went before it could be told to stop was not running.
      if (connection === null || !(await stopRunning(connection))) {
        // Nothing to stop IS the outcome asked for, so it reads the same to a
        // script as a daemon that was stopped.
        if (wantJson) printJson({ running: false, stopped: true });
        else console.log('not running');
        return;
      }
      if (wantJson) printJson({ running: false, stopped: true });
      else console.log('stopped');
      return;
    }
    case 'restart': {
      const connection = await withDaemonStartLock({ logger: stderrLogger }, async (lock) => {
        const home = shellpuppetHome();
        clearRestartHold(home);
        const record = inspectDaemonState(home);
        if (record.kind !== 'record') {
          throw new Error('Cannot restart without a readable daemon record. Wait about 15 seconds and run `shellpuppet daemon restart` again. If the record is still missing, the daemon is usually stopped; check that no ShellPuppet daemon process is running before `shellpuppet daemon start`.');
        }
        const existing = await discoverDaemon({ logger: stderrLogger });
        if (existing === null) return ensureDaemon({ logger: stderrLogger, direct }, lock);
        const state = readDaemonState(home);
        if (state === null || state.pid !== existing.pid || state.instanceId !== existing.instanceId) {
          throw new Error('The daemon changed while preparing its restart. Try again.');
        }
        // Publish the daemon being replaced before the shutdown request. Peers
        // can still see its healthy port until the stop completes.
        writeRestartHold(home, 140, { ...(existing.instanceId === undefined ? {} : { instanceId: existing.instanceId }),
          pid: existing.pid, port: existing.port, startMode: daemonStartMode(home, direct) });
        try {
          await stopRunning(existing);
          return await ensureDaemon({ logger: stderrLogger, direct }, lock);
        } finally {
          clearRestartHold(home);
        }
      });
      surfaceWarnings(connection);
      if (wantJson) {
        printJson({ running: true, port: connection.port, version: connection.version, startedWrapped: readDaemonState(shellpuppetHome())?.startedWrapped === true });
      } else {
        console.log(`restarted on port ${String(connection.port)}, version ${connection.version}`);
      }
      return;
    }
    default:
      fail(2, 'daemon needs one of: status, start, stop [--force] [--hold [seconds]], restart [--force]');
  }
}

main().catch((error: unknown) => {
  fail(1, error instanceof Error ? error.message : String(error));
});
