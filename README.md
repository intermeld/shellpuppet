# ShellPuppet

![Screen recording: Claude Code runs four other coding agents (Codex, Antigravity, Grok and Qoder) side by side, each in its own ShellPuppet terminal. Codex's window lights up amber when it asks permission to run a command; the person answers in that window, declining with a reason, and Codex carries on with its review.](docs/media/demo.gif)

▶ [Watch the full demo](https://github.com/intermeld/shellpuppet/releases/download/v0.1.0/shellpuppet-demo.mp4)
(67 seconds, MP4)

**Supervised terminal sessions for AI agents.** An agent drives a real terminal
while a human watches, and types into, the same live session from a
browser. The terminal runs whatever you point it at: an agent CLI such as
Claude Code, Codex, Antigravity, OpenCode, MiMo Code, Qoder, Goose or Grok,
or any other TUI.

ShellPuppet is to the terminal what Playwright is to the browser. Playwright
gives a program a real browser: the program clicks, reads the page, waits and
works on pages only a person could use. ShellPuppet gives an agent a real
terminal the same way.

Without ShellPuppet, an agent runs a program the way you might shout through a
closed door: one instruction goes in, one note comes back, and if the program
asks a question, nobody is there to answer it. ShellPuppet opens the door. The
agent sits at the keyboard: it types, looks at the screen, waits and types
again. And there's a window on your screen, so you can pull up a chair,
watch what it's doing and take the keyboard yourself whenever you like. Some
programs only work if someone is sitting there: menus, wizards, chat-style
tools, other AI assistants. An agent couldn't use those at all. Now it can.

ShellPuppet is the open-source terminal layer of **Intermeld**, the agent
governance platform by [Red Eagle Tech](https://redeagle.tech). Everything in
this repository runs on your machine and needs nothing we operate.

> **Status: 0.1.0, the first release.** The daemon, CLI, MCP server and viewer
> install from npm (below). Watch the repository's Releases for what comes
> next, and bring questions, ideas and what you build with it to
> [Discussions](https://github.com/intermeld/shellpuppet/discussions). 🦅

## What you get

- **Real terminals, driven by tools.** Sessions run in a real PTY (ConPTY on
  Windows), rendered through a real terminal emulator and exposed as twelve
  small MCP tools: start, snapshot, type, key, wait, find, result, list,
  resize, screenshot, viewer-url, kill. The CLI has a verb for each, spelled
  `snap` for the snapshot.
- **An agent's answer without its reasoning.** Several agent CLIs draw the
  model's reasoning on screen as they work. A supervising agent can read a
  session with that left out (snapshot, find and wait take `hideReasoning`),
  or take just the answer that ended the latest turn, and so keep another
  model's reasoning out of its own context. A screenshot shows the whole
  screen.
- **A human in the same session.** When a session starts, a viewer window
  opens on your machine. You see what the agent sees, live, and you can type
  into it: to answer a prompt, to correct course or to take over. Your window
  sets the size: the terminal reshapes itself to fill it, as a terminal
  should. To watch from another device, or to let someone else watch, ask the
  agent for a link or run `shellpuppet viewer-url <id>`. A fresh link is live
  until it's opened, so hand it over as you would a key; it works once and for
  a few minutes, so a link in an old transcript is spent. `--read-only` gives
  one that can watch but never type.
- **Waits instead of sleeps, and prompts you're told about.** `wait` blocks on
  text, a regex, quiescence or "the program is asking a question". The daemon
  spots permission prompts in driven agent CLIs, flags sessions that sit on
  one and badges the viewer so the human knows they are needed.
- **Nothing leaves your machine unless you send it or switch it on.** Today
  the tool has no outbound path at all: no telemetry, no crash reporting, no
  update checks, and the daemon listens on `127.0.0.1` only. Diagnostics, when
  it comes, stays off until you switch it on, carries no session content and no
  identifiers, and writes every payload to a local file before it leaves. That
  rule, nothing leaves unless you send it or switch it on, is a permanent
  property of the tool rather than a default. [VISION.md](VISION.md) and
  [SECURITY.md](SECURITY.md) say why.

## Quickstart

Install, then wire it into your agent and ask it for something; or run the
five commands under *Check the install from any shell*.

You need Node.js 22 or later. `node-pty` ships prebuilt binaries for Windows
and macOS, so no compiler is needed there. On Linux npm builds it with
node-gyp, which needs Python 3, make and a C++ compiler (on Debian and Ubuntu:
`sudo apt-get install -y python3 make g++`).

**Install:**

```sh
npm install -g shellpuppet                            # Windows and macOS
npm install -g --allow-scripts=node-pty shellpuppet   # Linux
```

On Windows, npm installs `shellpuppet` as a PowerShell script as well as a
`.cmd`, and PowerShell's default execution policy refuses the script. Run
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned` in that
window first, or run ShellPuppet from Command Prompt.

npm 12 runs a dependency's install script only when you allow it. On Linux,
node-pty's install script is what builds it. Without the flag the install
still completes, but `shellpuppet start` then refuses and names the flag.

Recent npm 11 releases and npm 12 print a warning that node-pty has install
scripts. On Windows and macOS ShellPuppet needs none of them, so there the
warning is safe to ignore. npm 10 ignores the flag, and early npm 11 releases
warn that it is an unknown option; both run the install scripts anyway.

On macOS, ShellPuppet makes node-pty's `spawn-helper` executable itself on
the first start. If you installed with `sudo`, it can't, and that first start
tells you the `sudo chmod +x` to run once.

**From source** (the same thing, plus a build):

```sh
git clone https://github.com/intermeld/shellpuppet.git
cd shellpuppet
npm ci
npm run build
npm link            # puts `shellpuppet` on your PATH; or use `node dist/cli/index.js`
```

On Windows the shim `npm link` makes meets the same execution policy; set it
as above, or use the `node dist/cli/index.js` form instead.

**Wire it into your agent.** ShellPuppet is an MCP server. With `shellpuppet`
on your PATH, Claude Code is one command:

```sh
claude mcp add shellpuppet -- shellpuppet mcp
```

For any other MCP client, the equivalent entry:

```json
{
  "mcpServers": {
    "shellpuppet": { "command": "shellpuppet", "args": ["mcp"] }
  }
}
```

That shape works for Claude Code, Cursor, Gemini CLI and the desktop apps.
Codex reads `~/.codex/config.toml` instead:

```toml
[mcp_servers.shellpuppet]
command = "shellpuppet"
args = ["mcp"]
```

Without `npm link`, use `node` with the absolute path to `dist/cli/index.js`
and the argument `mcp`.

**Then ask your agent for something.** Tell it to run a program in a
ShellPuppet session. A window opens on your screen as the session starts: you
watch, and when the program asks a question, you click into the window and
answer it. A good first ask: *"Run `npm create vite@latest` in a ShellPuppet
session, in an empty folder, and let me choose the options."* npm first asks
whether to install the wizard: answer y, and the wizard's menus appear in the
window as they come, each one flagged for you; pick with the arrow keys and
Enter. In the recording at the top, four agents do this at once, and the
person answers Codex's permission prompt in its window.

**Check the install from any shell.** The CLI has a verb for every tool, so
you can drive a session by hand:

```sh
# 1. Start a Node REPL in a real PTY. The daemon starts itself, you get a
#    session id (s1) and a viewer window opens (or a link, if no window can).
#    s1 is the first session on a fresh daemon: use whatever id start printed.
shellpuppet start --label demo --no-shell node

# 2. Wait for the REPL to paint and settle, instead of guessing at a sleep.
shellpuppet wait s1 --quiet 1000

# 3. Type as an agent would, and confirm the keystrokes landed.
shellpuppet type s1 '6 * 7' --enter --verify

# 4. Read the screen back as plain text.
shellpuppet snap s1

# 5. Kill the session: the whole process tree, not just the PTY child.
shellpuppet kill s1
```

Step 2 prints the REPL banner and prompt, step 3 says `typed 6 bytes (verified
on screen).` and step 4 shows `42` under your input. That exercises daemon
auto-start, the PTY, the renderer, waiting, input verification and tree-kill.

**No window?** By default a session start opens the viewer in ShellPuppet's
own chromeless browser window, falling back to your default browser. On a
headless machine, or if you'd rather have a link, set `viewer.launchMode` to
`"none"` in `~/.shellpuppet/config.json`: `start` then prints a viewer link,
and an agent is given one to pass to you. Whatever the setting, `shellpuppet
viewer-url <id>` mints a fresh link whenever you want one, and `--read-only`
makes it a link that can watch but never type. The options are in
[`docs/reference/configuration.md`](docs/reference/configuration.md).

**How long it takes.** On clean machines:

- **Windows 11** (a fresh Windows Sandbox, Node 24): installing ShellPuppet with
  npm took 22 to 26 s from a cold npm cache, and the five steps above 3.6 s end
  to end.
- **Linux** (a clean container, Node 22): the install took 29 s, including
  npm building node-pty, and the five steps about 2 s.

The first viewer window on a fresh machine takes longer, about 13 s in that
sandbox, because the browser is starting for the first time.

## Working with an agent

Twelve tools appear once the server is wired in: `terminal_start`,
`terminal_snapshot`, `terminal_type`, `terminal_key`, `terminal_wait`,
`terminal_find`, `terminal_result`, `terminal_list`, `terminal_resize`,
`terminal_screenshot`, `terminal_viewer_url` and `terminal_kill`.

When the session runs another agent CLI, `terminal_result` returns the answer
that ended its latest turn and nothing else, and `terminal_snapshot`,
`terminal_find`, `terminal_wait`, `terminal_list` and `terminal_screenshot` take `hideReasoning` to leave out the
reasoning it draws. Each CLI's screen is read by a signature: Claude Code,
Codex, Qoder, OpenCode, MiMo Code, Grok and Antigravity are built in. A
session started through a shell or a launcher script says which CLI it runs
with `terminal_start`'s `agent`. A session with no signature is refused
rather than shown unfiltered.

**Important:** A session whose model is a Claude model should **ALWAYS** pass
`hideReasoning: true` on every call that reads a screen: `terminal_snapshot`,
`terminal_wait`, `terminal_find`, `terminal_screenshot`, `terminal_list`, and
`--hide-reasoning` with their CLI equivalents. Claude models' safety checks can
flag another model's reasoning read off a screen as an attempt to extract
reasoning and stop the session. Leaving the reasoning out avoids that;
`terminal_result` gives the agent's answer. With the flag, a Claude model can
use every ShellPuppet tool freely. Other models can leave the flag off when
they need the full screen.

In a filtered screenshot, hidden rows are blurred and dimmed before capture;
its returned row text is filtered too. A filtered session list reports that a
prompt is waiting and for how long without its question.

`terminal_start` opens the viewer
window for you and tells the agent so. It gives the agent a link only when no
window could open, and `terminal_viewer_url` mints one whenever you ask: for a
second device, a closed window or someone who should watch without typing.
Links work once and for a few minutes. An agent CLI that needs a key held only in the
client's environment gets the names you list for it in `agents.passEnv`, and any
other program the names you list in config `envNames` and ask for at start
(`docs/reference/configuration.md`). Sessions
otherwise start with a clean environment, not the daemon's, so a key in the
daemon's environment doesn't reach them. `terminal_screenshot` returns a PNG of the viewer as a
browser draws it. Use it to illustrate documentation with real screens, and to
check what is *actually* on screen when the text looks right and something
still seems wrong. A capture has 45 s to start a browser, draw the page and
take the picture; `shellpuppet screenshot --timeout <ms>` moves that budget
for a machine that is slower or in more of a hurry.

The tool descriptions carry the lessons that cost real time to learn: first
paint is not readiness; a wait for text you just typed matches your own echo;
`escape` resets a TUI that has stopped listening. The measured behaviour of
each agent CLI, with ready-text regexes and timeout budgets, is in
[`docs/reference/agent-profiles.md`](docs/reference/agent-profiles.md).

## The CLI

```
shellpuppet start [options] <command> [args...]   # options BEFORE the command
shellpuppet list | snap | type | key | wait | find | resize | kill
shellpuppet screenshot <id> [--out <file>]        # the viewer, as a browser draws it
shellpuppet viewer-url <id> [--read-only]         # a fresh single-use viewer link
shellpuppet daemon status|start|stop|restart     # status and stop never start one
shellpuppet mcp
```

`shellpuppet --help` documents every flag. Exit codes: 0 ok · 1 the operation
failed, such as typing into a session that has exited · 2 the request itself
was wrong, whether the CLI caught it or the daemon refused it with a 400, such
as an invalid `--regex` · 3 wait did not match, or find found nothing, so
scripts can branch on either. `find` prints each matching line as
`<row>: <text>` and nothing else on stdout; with no match it prints the fixed
line `No matches.` on stderr, never the pattern, as the MCP tool does. With
`--json` it prints the response, an empty `matches` list included, and still
exits 3 when nothing matched.

## How it works

One per-user **daemon** owns every PTY and serves the browser viewer, on
loopback only, with a token on every request bar `/health`, the viewer page
and its static assets. The MCP server and the CLI start the daemon if it isn't
running. Every CLI verb is a one-shot HTTP client that returns promptly,
except `mcp`, which stays up for the stdio transport, and `wait`, which blocks
until its condition holds or its timeout runs out (300 s at most). Because
every client talks to the one daemon, two agents' MCP servers share one set of
sessions, and so does the human at the viewer. That is the point: sessions are
shared or they are nothing.

The build specification is
[`docs/architecture/design.md`](docs/architecture/design.md). It is
self-contained. It records what was considered and rejected, and the code
follows it.

## Day one

ShellPuppet 0.1.0 is the first release. Here is what to expect from it, as of
October 2026. The [roadmap](ROADMAP.md) says what comes next, and your ideas
shape it: tell us what you'd like, and where it trips you up, in
[Discussions](https://github.com/intermeld/shellpuppet/discussions), and
report bugs in the [issues](https://github.com/intermeld/shellpuppet/issues).

- **One window per session, for now.** Each session opens its own viewer
  window, and the windows don't arrange or size themselves yet. A dashboard
  that holds every session as a pane, across more than one screen, is what
  we're building now.
- **Prompt detection is pattern-based.** It recognises the numbered,
  pointer-only and letter-keyed choosers and the confirmation prompts real
  agent CLIs draw, and the select, multi-select and confirm steps of
  scaffolding wizards built on `@clack/prompts`, each pinned by a fixture from
  a real screen. A shape it has not seen it will miss, and output that
  imitates one can fool it. If it misses a real prompt you meet, tell us, or
  better still, send a pull request with the fix.
- **Readiness is heuristic.** "First paint is not readiness" is in the tools
  themselves, and quiet-based waits need a first paint before silence counts;
  but a program can paint and still discard input while it finishes loading.
  Wait for its own ready text.
- **Killing can take seconds on Windows.** A Windows `kill` waits for
  `taskkill` to end the whole process tree. On the clean Windows 11 machine
  behind the install timings above it took under a second; on a busy
  development workstation it took up to about nine seconds.
- **Your MCP client may have a shorter patience than the daemon.** Waits go
  up to 300 s, but some clients background a tool call after two minutes.
  Keep long waits under your client's limit and poll.
- **Linux and macOS testers wanted.** Windows has had the most real-world
  driving so far. Linux and macOS run the full test suite on every change,
  and we'd welcome people who drive agents on them to try ShellPuppet and
  tell us how it goes.

## Documentation

| Read | For |
|---|---|
| [VISION.md](VISION.md) | What the project is for, what is open and stays open, the principles it won't trade away and where Intermeld begins. **Start here.** |
| [ROADMAP.md](ROADMAP.md) | What is being worked on now, what comes next and what is further off, without dates. |
| [`docs/architecture/design.md`](docs/architecture/design.md) | The build specification. |
| [`docs/reference/security-model.md`](docs/reference/security-model.md) | What running this grants, the token model, the limits that remain and the recorded prompt-injection drill. |
| [`docs/reference/configuration.md`](docs/reference/configuration.md) | Every `config.json` option: command policy, environment hygiene, audit, viewer launch. |
| [`docs/reference/agent-profiles.md`](docs/reference/agent-profiles.md) | Measured agent-CLI behaviour, ready-text regexes, timeout budgets, recipes. |
| [`docs/decisions/`](docs/decisions/) | Decision records: [ADR-001 naming](docs/decisions/ADR-001-two-brand-open-core-naming.md), [ADR-002 licence](docs/decisions/ADR-002-apache-2-licence.md), [ADR-003 TypeScript](docs/decisions/ADR-003-typescript-implementation.md), [ADR-004 contribution policy](docs/decisions/ADR-004-contribution-policy.md), [ADR-005 diagnostics and feedback](docs/decisions/ADR-005-diagnostics-and-feedback.md), [ADR-006 agent modules](docs/decisions/ADR-006-per-agent-modules.md), [ADR-007 connected features](docs/decisions/ADR-007-connected-features.md), [ADR-008 clean session environment](docs/decisions/ADR-008-clean-session-environment-by-default.md). |
| [SECURITY.md](SECURITY.md) · [SUPPORT.md](SUPPORT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) | Reporting a vulnerability · getting help · building, testing and sending changes. |

## Contributing

Contributions are accepted under the Developer Certificate of Origin: sign off
each commit (`git commit -s`), and there's no contributor licence agreement,
ever ([ADR-004](docs/decisions/ADR-004-contribution-policy.md)). The sign-off
check runs on every pull request. Bug reports are welcome in the issues, and
questions, ideas and any other feedback in
[Discussions](https://github.com/intermeld/shellpuppet/discussions);
[SUPPORT.md](SUPPORT.md) says where everything goes.

## Licence

[Apache-2.0](LICENSE). See also [NOTICE](NOTICE). Code released under
Apache-2.0 stays Apache-2.0; the pledge is in
[VISION.md](VISION.md#licensing-and-contributions). The names are trademarks:
see [TRADEMARKS.md](TRADEMARKS.md).
