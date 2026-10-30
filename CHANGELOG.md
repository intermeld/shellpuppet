# Changelog

Notable changes to ShellPuppet, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a minor
version may change behaviour, and every such change is listed here.

## [Unreleased]

### Changed

- The variables a caller may name at start are listed in config `envNames`, at
  the top level, read by both `terminal_start`'s `envNames` and `shellpuppet
  start --env-name`. A config that still uses `mcp.passEnv` passes nothing and
  is reported.
- When the daemon answers a request with its catch-all 500, the line it
  writes to `daemon.log` holds the error's stack and the request's method and
  path. The query, the headers and the body are left out: a query can carry a
  viewer grant, and a header the client token. For an absolute-form target
  the path is logged without the scheme and authority.
- An overrun of a built-in signature's regular-expression time budget, dialog
  or agent, is logged as `signature set aside`, with nothing to change: it is
  tried again in a minute. An overrun of an entry from config is a
  `CONFIG PROBLEM` that asks for simpler patterns.

### Fixed

- A dialog signature, built-in or from config `prompts.dialogs`, whose
  pattern runs past the regular-expression time budget is set aside for a
  minute and then tried again, as an agent signature is. The budget is
  wall-clock time, so on a loaded machine an ordinary pattern can overrun it
  once. Each overrun is reported in `daemon.log`.
- On Windows, a resize made before a session's first output, by a viewer or
  `terminal_resize`, is dropped when the session's program has ended by the
  time that output arrives, and the daemon and its sessions keep running.
  A resize asked for once the program has ended, before the session's exit
  has followed, is answered over HTTP and `terminal_resize` with the 409 a
  session that has exited gets. A viewer's is not answered, so a page whose
  window does not fit the grid does not ask again; the session's exit follows
  within about a second.
- The daemon answers `/health` and every request while it detects the browser
  for the viewer window, which it begins as it starts. The paths
  chrome-launcher checks first are tried by file access alone, and its full
  lookup, which on macOS takes seconds, runs in a child process, so a first
  `daemon start` on macOS is no longer at risk of missing the client's
  ten-second wait. The browser found is the one chrome-launcher ranks first,
  as before.
- On Windows, a session whose input pipe refuses a write once its console
  host has gone (`write EAGAIN`), or whose output worker or output socket
  fails, has the failure logged once, and the daemon and its other sessions
  keep running.
- On Windows, a session's kill ends the session's processes with its tree
  kill alone. node-pty's own kill ends no process and starts no helper
  process, so it never ends a process, or a whole console of them, found by a
  pid the session's program no longer holds, and it cannot stop the daemon by
  failing to start one.
- On Windows, a session that ends because its output socket failed, while
  its program runs on, ends that program and its tree at once and logs it.
  Its `exitCode` stays null. The viewer, the list and the 409 say the session
  ended because its output failed, not that the program exited. A kill, the
  reap and stopping the daemon walk the tree of any such program whose end has
  not been seen.
- An error on a connection whose WebSocket upgrade the daemon refused, or a
  connection the daemon's HTTP server could not accept, leaves the daemon
  running; the second is logged.
- On Windows, input or a key sent over the API to a session whose input pipe
  has failed is answered with a 409 that says so and to kill the session and
  start it again (a session that has already exited still gets the 409 that
  says it exited).
- On Windows, a viewer typing into a session whose input pipe has failed is
  told once, and one that opens afterwards is told as it connects; the page
  says that the session's input has failed and to kill it and start it again,
  and nothing typed there is written, audited or logged.

## [0.1.0] - 2026-10-30

The first public release.

### Added

- A per-user daemon that owns real terminal sessions: a real PTY (ConPTY on
  Windows) rendered through a real terminal emulator, listening on
  `127.0.0.1` only and shared by every client the user runs on the machine.
- An MCP server with twelve tools (start, snapshot, type, key, wait, find,
  result, list, resize, screenshot, viewer-url, kill) and a CLI with a verb
  for each, spelled `snap` for the snapshot. A tool refuses a parameter it
  does not define, naming it.
- Reading an agent CLI without its reasoning: `terminal_snapshot`,
  `terminal_find` and `terminal_wait` take `hideReasoning`, and
  `terminal_result` returns the answer that ended the latest turn and nothing
  else. Signatures for Claude Code, Codex, Qoder, OpenCode, MiMo Code, Grok
  and Antigravity are built in, and config `agents.signatures` adds others.
  `terminal_start`'s `agent` (CLI `--agent`) names the CLI a session runs. A
  session with no signature is refused, never shown unfiltered.
- Waits on text, a regular expression, quiescence or a permission prompt,
  with a time budget on caller-supplied patterns so one pattern cannot stall
  the daemon.
- Detection of permission prompts in driven agent CLIs, and of the select,
  multi-select and confirm steps drawn by `@clack/prompts` (the create-vite
  and `sv create` wizards, MiMo Code's folder-trust question), with sessions
  that sit on one flagged and the viewer badged.
- Permission dialogs that a program draws inside its own screen, with its
  choices as a row of buttons, recognised by signature: OpenCode's and MiMo
  Code's are built in, and config `prompts.dialogs` adds others without a
  release.
- Variables from the client's own environment passed into a session it
  starts, only those a person has listed: per agent CLI in config
  `agents.passEnv`, which a session started as that agent receives with
  nothing named at start, and for other programs in config `mcp.passEnv`,
  named at start (`terminal_start` `envNames`, `shellpuppet start
  --env-name`). Names are recorded; values never appear in tool results, the
  CLI's output, logs, the audit trail or the viewer.
- `shellpuppet start --no-viewer` opens no viewer window, for a short scripted
  session nobody needs to watch; `viewer-url` still gives a link to it.
- Sessions start with a clean environment: a minimal functional set rather
  than the daemon's whole environment, which is whatever the client that
  auto-started the daemon had (ADR-008).
  - Config `sessionEnv` adds names to it, or with `"passthrough"` hands on
    everything. Under passthrough the daemon names the credential-shaped
    variables it passes on, in `daemon.log` and `daemon status`, and never
    shows their values.
- A browser viewer on the same session for a human to watch and type into. A
  window opens when a session starts, and the caller is given a link only when
  none opened, or on request. Viewer links work once and expire after five
  minutes; read-only links are enforced by the daemon; the human's window sets
  the grid unless the session holds it.
- Screenshots of the viewer through a headless Chromium-family browser.
- Installs under npm 12, which runs a dependency's install scripts only when
  allowed:
  - ShellPuppet has no install script of its own. It restores the execute bit
    on node-pty's macOS helper itself.
  - On Linux, install with `--allow-scripts=node-pty` so that node-pty is
    built.
  - When node-pty cannot open a terminal, starting a session says what to do,
    and the daemon keeps running.
- Token authentication, `Host` and `Origin` checks, a command policy
  (allowlist or denylist), an audit log that keeps a viewer's automatic
  terminal replies apart from what people type, and a kill that ends the
  whole process tree.
- No telemetry, usage reporting, crash reporting or update checks, and no
  outbound path at all: nothing leaves the machine unless a person sends it or
  switches it on.

## [0.0.1] - 2026-08-25

A placeholder that reserved the package name. It contains no functionality;
install 0.1.0 or later.
