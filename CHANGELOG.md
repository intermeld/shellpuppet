# Changelog

Notable changes to ShellPuppet, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a minor
version may change behaviour, and every such change is listed here.

## [Unreleased]

### Added

- The dashboard page's human controls. Terminal mode types into the focused
  pane. The configurable `Ctrl+Shift+A` prefix enters navigation and is not
  sent to the session; `Ctrl+\` is not that prefix. Kill is one menu action
  away from the pane header, not a header icon, and sends one
  `DELETE /sessions/<id>` with the dashboard cookie and the page proof. That
  kill is audited as `dashboard`. The same cookie still cannot shut the daemon
  down, mint a viewer link, take a screenshot, read the environment report,
  start an arbitrary command, or call an HTTP input or key route. The page
  lists profiles from `GET /dashboard/profiles` and starts one with
  `POST /dashboard/launch`: a profile name and, where the profile offers
  folders, a folder name. It never sends a command. The response's `open`
  value adds the pane (`grid`), focuses it (`focus`) or pops it out
  (`window`). Pop out opens that pane in its own window at
  `/dashboard#pop=<id>`, with no grant in the URL. The window can be made
  full screen, and closing it returns the pane to its place in the grid.
  Restart is offered only for a session this page started from a profile, and
  it repeats that profile and folder. Copy session id copies the id only.
  An ended pane stays until it is dismissed or the existing reap removes it.
  Mode, order and pin stay in `localStorage`. The profile and folder a start
  used stay there too. Nothing is written to the daemon home or to
  `config.json`.
- The dashboard page shows passive terminal panes from the live session feed.
  Auto uses an even grid while panes meet the 80 by 24 floor, then a large
  pane and strip; Grid and Focus are available too. Pin, reorder, attention,
  navigation with a configurable shortcut, text size, Fit, Enlarge and Restore
  work in the page. Layout
  and font changes leave the PTY grid alone; deliberate geometry acts take
  it. Covered and scrolled-off panes disconnect until visible again. Browser
  WebSockets that omit both Fetch Metadata headers work with the exact Origin
  and page proof checks.

- `shellpuppet dashboard` opens the dashboard in ShellPuppet's isolated browser
  profile and prints whether a window opened, never the URL or grant. The
  daemon's dashboard opener never falls back to the default browser: a window
  that cannot open revokes the grant and fails the command, with a message
  naming `viewer.browserPath`.
- The dashboard's launch API can start a session from a profile you write in
  `launcher.profiles` in `config.json`, and from nothing else. `GET
  /dashboard/profiles` lists the profiles and any entry that did not load;
  `POST /dashboard/launch` takes a profile name and, when the profile offers
  them, one folder name. The body cannot supply a command, arguments, a path
  or an environment value. Global policy and the profile's own allow and deny
  lists see the real command before the Windows shell wrap, and the command
  is resolved to the file that runs. The route accepts eight starts in any
  sixty seconds and refuses at thirty-two live sessions
  when `policy.maxSessions` is unset; a configured cap replaces that number.
  Sessions start clean, plus the names a profile lists in `envFromDaemon`,
  copied from the daemon's environment. The response and the audit line carry
  the names, never the values. The started session's id and the profile's
  `open` value are returned. An invalid profile is named in `daemon.log` and
  left out, and its siblings still load. With no launcher, the dashboard is
  watch-only. A profile's `command` is resolved
  to an absolute executable before the session starts (a bare name on `PATH`
  only, never the session's folder; a relative path with a separator from the
  profile's folder); one that cannot be resolved refuses the launch and starts
  nothing, and the audit records the resolved file beside the written command.
  The route takes only `application/json`, answers malformed JSON with 400 and
  an oversized body with 413, and audits a missing or foreign `Origin` as
  `origin`. `envFromDaemon` copies only variables the daemon's environment
  holds as strings, and a variable reserved for a connected feature's
  credential never reaches a session. The page's start control comes later.
- The dashboard has its own one-use grant, which lives for five minutes and is
  minted only by the daemon. `POST /dashboard/open` (client token) mints it and opens
  the page in the isolated browser profile, never the default browser. The grant is not returned to the
  caller. A top-level navigation to `GET /dashboard` redeems it for an
  `HttpOnly` `sp_dash` cookie. That cookie may open the dashboard page,
  `GET /sessions` and `/dashboard/events`. Each accepted navigation embeds a
  fresh proof. `GET /sessions` requires `X-ShellPuppet-CSRF`. The events
  socket requires the `sp-csrf` subprotocol. While that socket is open, a
  session start does not open a per-session viewer window.
- A dashboard pane opens `/sessions/<id>/stream` with the `sp_dash` cookie and
  the `sp-csrf` subprotocol, under the same Origin and Fetch Metadata rules as
  `/dashboard/events`. The dashboard credential is always passive, whatever
  the query says: the pane adopts the session's grid, does not take it on
  connect, and does not inherit it when another socket leaves. A `resize`
  without `take` is ignored. A `resize` with `take: true` (what Fit, Enlarge,
  Focus and Restore send) sets the terminal size, clamped at 400 by 150,
  tells every watcher, and is audited as `dashboard`. Keystrokes on that
  socket are audited as `dashboard`. `drive=0` is the opt-out for a viewer or
  client-token socket only, and `drive=false` is not a spelling. The echoed
  subprotocol names the dashboard credential; a client token on the same
  request selects none. A read-only viewer cookie does not become a dashboard
  credential. The cookie still does not open `/events`, a raw start, a
  shutdown, a screenshot, a viewer mint, or an HTTP input or key call.
  `DELETE /sessions/<id>` is the kill, and it needs the document proof.
- `hideReasoning` now covers screenshots and session lists, including their CLI
  commands. Screenshots blur and dim reasoning rows in the image and replace
  their row text. Filtered lists omit waiting prompt questions. Filtered waits
  report questions and options only from their filtered screens, and prompt
  stall logs omit question text. MCP instructions explain when to use the flag.

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
- On Windows, a start with `shell: false` (`--no-shell`) is refused with a
  400 unless the command resolves to an `.exe` or a `.com` file. A `.cmd`,
  `.bat`, `.ps1` or extensionless script is refused, and so is a path whose
  file name contains `:`, which names an alternate data stream. The 400 for
  a script says to run it through the shell or to name its interpreter. A
  command that contains a path separator and is not absolute is resolved
  from the session's working directory, and that absolute path is what is
  checked and started. A bare name is found on PATH.
- A session started without `cwd` starts in the folder of the client that
  asked for it: `terminal_start` sends the MCP server's working directory and
  `shellpuppet start` the shell's, and a relative `cwd` is taken from there. A
  direct `POST /sessions` with no `cwd` starts in the user's home directory.
- The auto-started daemon runs in the user's home directory, so it holds no
  client's folder open (on Windows, a folder a process runs in cannot be
  deleted or renamed).

### Fixed

- A viewer's waiting and connection notices sit in the half of the terminal
  away from its cursor, scroll within at most one third of its height, and let
  clicks through to the terminal. Its identity strip keeps a fixed height, so
  badge changes do not resize the session. A repaint of the same prompt keeps
  its waiting age and stall alert; a short redraw gap does not clear it, while
  a prompt still missing after one second clears without waiting for the next
  five-second scan. (#41)
- OpenCode and MiMo Code question menus now report their wrapped question and
  numbered choices as a waiting prompt. The menu survives `hideReasoning`, and
  filtered session lists omit its question text.
- On Windows, a waiter for console-host cleanup now waits for every running
  batch when process lists overlap. Finishing one list no longer reports the
  queue settled while another session's host is still being checked.
- On Windows, a session's console host (`conhost.exe`, or `OpenConsole.exe`
  when that is the host in use) is ended after the session ends, whether its
  program exited or the session was killed, instead of running until the
  daemon exits; a long-lived daemon with many sessions held one host, about
  8 MB, for each. The session records the time immediately before and after
  its spawn, during which the host is created; after the end, one list of the
  daemon's children names the host whose creation time falls in that window,
  widened by 5 ms, and ends that one process. Sessions that end within a few
  hundred milliseconds share the list. The list is a short-lived PowerShell
  `Get-CimInstance` that compiles nothing; it is on no path a caller waits on,
  and takes about ten seconds. Zero or several hosts in the window, or a list
  that fails or times out, ends nothing. The daemon's own pseudoconsole handle
  stays open until the daemon exits, and the host is given no
  CTRL_CLOSE_EVENT.
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
- `shellpuppet daemon status`, `daemon stop` and the stop half of `daemon
  restart` never start a daemon. When the daemon has gone between being found
  and being asked, `status` reports `not running` (`{ "running": false }`
  with `--json`), and `stop` reports it as not running. Every other verb
  still starts a daemon in place of one that has gone. The start half of
  `daemon restart` is the one start that verb makes.
- The viewer window and the screenshot browser are started with switches,
  documented in Chromium's source, that ask the browser to make no background
  requests of its own: background networking, component updates, built-in
  extensions' background pages, default apps, Domain Reliability, sync,
  metrics and crash reports, the variations seed, proxy auto-detection, the
  Optimization Guide's hints and models, and network time queries. A fresh
  Chrome still contacts a few of its services that these switches do not
  reach (design §5 says which).
- Screenshot browser profiles no longer pile up. Each capture's profile
  folder is made in `capture-profiles` in the ShellPuppet home; one that
  Windows will not let go of as the capture ends is tried again after 30
  seconds and after 5 minutes, and the daemon removes what is left as it
  starts: folders with a capture's name, untouched for 10 minutes.
- The daemon answers `/health` and every request while it detects the browser
  for the viewer window, which it begins as it starts. The paths
  chrome-launcher checks first are tried by file access alone. On Windows
  that list is chrome-launcher's whole search, so no further lookup runs. On
  macOS and Linux the rest of the lookup runs in a child process, and a
  lookup that times out, crashes or prints something other than a JSON list
  is logged once. The browser found is the one chrome-launcher ranks first.
- `hideReasoning` never hides a question the program is waiting on. The rows
  the prompt detection claims for that question, and the border rows beside
  them, stay, for every signature. Grok's own rules also stop on the box's
  question row (`│  > `, two spaces between the bar and `>`), its command rows
  and its option rows, so the box keeps those even when detection claims
  nothing. The composer row is `│ >` with one space, and it is not that
  question. A numbered list in the reasoning is not claimed when a question
  with nothing below it is the only reason it looked live and the list sits
  inside a reasoning block that began above the question. A one-line reasoning
  summary drawn between a question and its options stays hidden. The older
  Grok box, whose command is plain bar text above the radios, keeps that run
  when a bare bar or a reasoning start closes it off from the reasoning above
  and the run carries command evidence: the box's `│  > ` question row, a
  `$`, or a `:` continuation. The limits: a row shaped as a Grok option
  (`1 (○)`, `2 (•)`) stays even when the reasoning drew it, because the
  signature keeps that shape when detection claims nothing; a filled radio
  inside another program's reasoning stays, because that glyph is what shows
  a selector is live; a blockquoted numbered list drawn as `│  > 1.` stays,
  because that row is also the box's question row and a sign-in marker; a
  letter menu at the end of a reasoning block stays, because its letter keys
  are what show a selector is live and dropping the claim would hide a real
  one; a run of plain bar text stays with the reasoning when nothing closes
  it off, or when it carries no command evidence, because that run is the
  same shape as the reasoning. A wait result carries the question and the
  options. The rows the filter uses are not part of it.
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
