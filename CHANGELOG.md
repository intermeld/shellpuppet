# Changelog

Notable changes to ShellPuppet, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a minor
version may change behaviour, and every such change is listed here.

## [Unreleased]

### Added

- `launcher.launchesPerMinute` sets the dashboard and granted session launch allowance from 1 to 60 starts per minute. It defaults to eight and updates when configuration changes.

### Changed

- New CLI and MCP clients now submit by default for listed built-in agents whose launched program matches the agent. Explicit false types only. Written Enter reports `unconfirmed` until a turn-correlated agent acceptance event exists; legacy response fields remain available.

### Fixed

- Explicit submit to Codex is no longer withheld as "not seen" in fast mode, whose footer adds a word the check did not accept, or while a slash command suggestion is shown above the input.
- After a Hermes turn, waiting messages can be nudged when the completed summary lists extra activity and the grey footer clips a timer.
- Waiting time and stall alerts restart after input to a held prompt, including when the next prompt has the same question and choices. Redraws without input retain the timer.
- Codex recognises a repeated short prompt in its live composer when an earlier copy belongs to a completed turn. Grok recognises a padded welcome footer after typed send hints appear.
- Hermes welcome screens with hour and minute footer clocks now allow message nudges and exact wrapped drafts to be submitted.
- `daemon stop` waits for a new standalone daemon's process to exit before
  reporting success, or reports teardown still in progress after 65 seconds.
  An authenticated preflight keeps that guarantee when the shutdown response
  is lost. A requested restart hold survives a timeout after an accepted response.
- Shutdown cancels wider reads before session tree teardown. Temporary growth
  cannot apply to a removed session, including a Windows resize deferred until
  first output.

## [0.4.2] - 2026-11-25

Copying from programs that use OSC 52, recovery of a lost outside claim, submit outcome reporting and a launch allowance fix.

### Fixed

- Programs can copy text with OSC 52 for two seconds after you press the primary pointer button, type a character or use a supported editing or navigation key in the focused viewer or dashboard pane. Pasting ends that window. Hold Shift and drag to select text even when the program handles the mouse.
- The CLI and MCP show recovery advice alongside the existing claim error. A conflict on a held outside name gives both recovery commands. A request marked as coming from inside a session can read or release its outside claim without extending its idle time.
- A dashboard or granted session launch that fails to start no longer uses up the per-minute launch allowance. A pending start reserves a slot, a confirmed start is charged for sixty seconds, and a failed or cancelled start releases its slot at once.

### Added

- Explicit submit can report the result of the existing checks as `submitted`, `withheld` with a reason, or `unconfirmed`. If the reporting marker would exceed the request size limit, the client sends the original input.
- Recover a lost outside claim with `msg claim <name> --replace` or `replace: true` on `session_claim`. The new claim receives pending messages and any launch grant on the name. The daemon must write the audit entry before it can replace the claim and invalidate the old proof.

### Changed

- `audit.captureContent: true` no longer records typed input; it captures recognised terminal reports only. Typed input audit entries record their length, and requests with the reporting marker also record the outcome.

## [0.4.1] - 2026-11-24

Fixes for dashboard windows and for intermittent tests.

### Fixed

- Opening or reloading a dashboard window no longer disconnects another window once eight are open: a document proof is kept while any dashboard feed or session stream still uses it. At most eight unused proofs are kept, with 256 in total, and a new page gets a 503 with recovery instructions when every slot is in use. Revoking or replacing the credential still closes every feed and stream.
- Dashboard proofs are compared in constant time in the launch and grid-transfer paths, and a session stream echoes a subprotocol only when dashboard authentication admitted it.
- Intermittent tests: notice placement is checked against the delivered rows and deadlines, browser setup has its own readiness budget, and session identity reports are written atomically.

## [0.4.0] - 2026-11-23

Scheduled prompts for named sessions, a Hermes module and start folders in
session listings, with fixes to restart records, wrapped Codex lines and
Windows starts.

### Added

- `terminal_list` and `shellpuppet list --json` show each session's absolute start folder in `cwd`.
- Scheduled prompts for named sessions with UTC cron, live configuration reload and a read-only `schedule list` command.
- Hermes Agent: a module for Hermes sessions (agent label `hermes`): reasoning hidden from filtered reads, its replies, menus and command approvals recognised, idle and draft composers proven before typed Enter or a message nudge, and a message queued with Tab while Hermes is busy.

### Fixed

- `shellpuppet previous` records the conversation a Claude Code session switched to with `/resume`: the ShellPuppet MCP server reads its Claude process's own session record and reports the live id; when it cannot, the launch id is kept.
- Codex: a typed line or message nudge that Codex wraps at spaces, path separators or punctuation is recognised (using the same Unicode 15.0 line-break rules Codex uses), so Enter is sent once the complete draft is visible; text outside Latin-1 still has Enter withheld.
- Windows daemon starts from the Start menu shortcut and through a start wrapper: program lookup works whatever the case of the PATH variable, a failed start is logged and shown, the wrapped daemon no longer opens a console window, and wrapped restarts stay under the start lock and survive their starting client closing.

## [0.3.0] - 2026-11-21

Several dashboard windows, messages between sessions, session names and
roles, launches from sessions, and many reading and nudging fixes.

### Added

- Designate one dashboard window for agent and CLI starts, start profile
  sessions in their own window, drag panes between windows, and open empty
  windows with New window. Pop out now creates an ordinary dashboard window.
- Messages between sessions ([ADR-010](docs/decisions/ADR-010-messages-between-sessions.md)),
  off until switched on with a `messaging` section in `config.json` that says
  who may message whom. Named participants send and read messages through
  daemon routes, MCP tools (registered only while messaging is on) and CLI
  commands; outside callers take a claim on a name. Messages wait in a
  bounded in-memory mailbox; send results and outboxes show delivery states;
  idle outside claims lapse and their unread messages are marked not
  delivered. Audit and event records never hold message text.
- Type a fixed, rate-limited nudge line into a supported session when a
  message waits for it, through the normal input queue, naming the
  `session_inbox` tool. Before Enter the daemon rechecks the screen, the
  waiting messages and the terminal size. Idle Claude Code, Codex, Qoder,
  Muse Code, OpenCode, MiMo Code, Grok Build and Antigravity composers are
  recognised; Claude Code, Grok Build, Muse Code and OpenCode sessions are
  also nudged while they work, once the composer is free, so the line is
  queued. A program whose composer cannot be read is left alone.
- Show owner-wide messages in the dashboard with session and group filters,
  safe text display and unread counts on panes.
- Give each session its own instance identity and secret
  (`SHELLPUPPET_SESSION`), verify its client calls, and show parent sessions
  in lists and the dashboard feed.
- Name sessions: a Name box in the dashboard launcher, numbered repeats, and
  renaming live sessions, which updates the pane and the messaging address
  together. Sessions show a chair or delegate role; chair is set only by a
  launch profile, and messaging groups can match by role.
- Let named sessions and outside claims granted in `launcher.sessionLaunch`
  launch owner-configured profiles, including a conversation to resume.
  Before a restart the daemon saves its live profile sessions and known
  conversation ids for a granted supervisor to relaunch (`shellpuppet
  previous`), and active launcher claims survive orderly restarts. Daemon
  records on Windows are owner-only, and claim proofs are stripped from
  child environments.
- Read a clipped terminal dialog at a wider grid with `terminal_snapshot` or
  `snap --wider`, then return the grid and dashboard control to their
  previous state.
- Show a session that stops on an error from its model provider as stalled,
  in session lists and the dashboard, wake `--stalled` / `stalled: true`
  waits for it and tell its supervisor. Recognised: MiMo refusals, output
  limits and failed requests, other idle error blocks (including long ones
  whose marker scrolled away), and a persistent OpenCode or MiMo Code
  server connection loss.
- Opt in to waiting for a delegate agent's known ready signals at start, with
  early returns for questions and exits and a time limit that leaves the
  session running.

### Changed

- Agent-specific knowledge (reading signatures, prompt shapes and dialogs,
  Muse's input rules) now lives in one module per harness under
  `src/agents/`, as ADR-006 describes. Prompt detection still runs every
  harness's shapes in every session, so a prompt painted by a program running
  inside an agent is still caught.
- Sessions resolve their agent once from the explicit agent or the program
  name, falling back to `generic`; lists and start audit entries show it.
  Starting Muse by its program name applies its input rules as an explicit
  agent does.
- The dashboard's profile list shows each profile's purpose in brackets after
  its label.
- A failed screenshot says which capture step failed, how long each step took
  and what state the browser was in. It never includes the picture.
- Session identity is checked on client-token WebSocket upgrades, and daemon
  audit records stay free of inherited caller identity.

### Fixed

- Submit a launch command typed at a shell prompt before the agent starts;
  once an agent's composer is on screen, wait for a typed line or paste
  placeholder to settle and send Enter only with proof that the composer
  holds exactly that line, with at most one safe retry.
- Never type an unconfirmed message nudge twice; a pending line is submitted
  with the submit key alone once the composer shows it exactly once, and is
  left for the person if they have typed since. Nudge again when a new
  message arrives after an unanswered nudge, and let one recipient's failure
  not stop the others.
- Show the Windows folder picker in front of the dashboard when Browse is
  clicked.
- Keep full-screen sessions alive when a wider read grows the grid after an
  earlier shrink, and stop text from a wider layout lingering past the right
  edge after a full-screen program's grid narrows.
- Bound viewport repair after a resize and end only the affected session if
  terminal rendering fails; repair missing rows after a scrolled screen grows,
  a terminal emulator fault that could stop the daemon on the next output;
  keep ending sessions and closing panes safe while their last output is
  still being drawn.
- Keep waiting alerts and other notices clear of the prompt they announce and
  steady while a terminal repaints.
- Dashboard grid control: a pane takes its grid when the controlling window
  releases it during a move to another window, the human's grid survives
  socket loss, reload and reconnects, Auto fit retries after a lost request,
  and screens below the 80 by 24 floor stay wholly visible with consistent
  text after font or display-scale changes.
- Prompt and dialog reading: Grok Build permission boxes (edit-pattern
  actions, wrapped commands, a question scrolled off the screen) keep their
  choices and command rows while reasoning stays hidden; OpenCode and MiMo
  Code question panels clipped by the terminal height report the visible
  choices; Muse Code's tool-action and two-choice command approvals read as
  waiting; Qoder suggestions and drafts no longer read as choices.
- MiMo refusals are recognised on narrower screens and with modern footers,
  grey suggestions and expandable tool panels, and stay stalled when the
  screen narrows and widens.
- A message wait for `from` set to a name now returns.

## [0.2.1] - 2026-11-05

Safer planned restarts, and a dashboard fix for windows that close.

### Added

- `daemon stop --hold` pauses automatic starts during a planned rebuild;
  `daemon restart` keeps the start lock through the replacement start and
  makes clients wait for the replacement while the old daemon is stopping.
  Clients identify the replacement by its daemon instance id, use a fixed
  wait bound, and resume starts if the process performing a restart has gone.

### Changed

- `/health` also returns the daemon's instance id, so a client can tell a
  replacement daemon from the one it was talking to.

### Fixed

- A dashboard window that has just closed can no longer claim its panes back
  with a late roster. Its panes stay with the windows still open, while a
  duplicate window for the same screen and a reloaded window stay eligible.

## [0.2.0] - 2026-11-04

The dashboard: every session as a pane, across more than one screen, with
launch profiles to start sessions from it.

### Added

- `shellpuppet dashboard` opens the dashboard in ShellPuppet's isolated browser
  profile and prints whether a window opened, never the URL or grant. The
  daemon's dashboard opener never falls back to the default browser: a window
  that cannot open revokes the grant and fails the command, with a message
  naming `viewer.browserPath`.
- The dashboard page shows passive terminal panes from the live session feed.
  Auto uses an even grid while panes meet the 80 by 24 floor, then a large
  pane and strip; Grid and Focus are available too. Pin, reorder, attention,
  navigation with a configurable shortcut, text size, Fit, Enlarge and Restore
  work in the page. Layout
  and font changes leave the PTY grid alone; deliberate geometry acts take
  it. Covered and scrolled-off panes disconnect until visible again. Browser
  WebSockets that omit both Fetch Metadata headers work with the exact Origin
  and page proof checks.
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
- The dashboard can assign panes across several windows. It asks for screen
  permission only on an Allow screens click, opens at most one window per
  click, places granted windows in each screen's available rectangle and
  offers an unplaced window when placement is unavailable. A blocked popup
  leaves its button available. Browser windows share the dashboard cookie,
  coordinate their roster and pane assignment over `BroadcastChannel`, and
  return panes when a window closes.
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
- New sessions open in the dashboard by default. The daemon opens one isolated
  dashboard window when needed and waits for it to connect before trying another.
  If the window cannot open, the start still succeeds and returns a viewer link.
- `shellpuppet desktop` starts or reuses the daemon and opens the dashboard only
  when no dashboard page is connected. `desktop --install` adds or updates a
  per-user Start menu shortcut on Windows or an application launcher on Linux;
  `--uninstall` removes it. A redeemed dashboard grant leaves the address bar
  and history, and a page without a valid cookie explains how to start again.
- Muse Code 1.4.14 has a built-in agent signature for filtered reasoning,
  latest-turn answers, its workspace trust menu and its approval menus, with
  two or three choices, in stages, at any width and with long commands that
  wrap. An empty composer showing Muse's hint is read as empty, so results
  return the answer above it, and typed text not yet sent is reported as
  `prompt-typed`. An approval menu whose heading is not bold counts as a
  question once it has stayed unchanged for 1.5 seconds, because Muse draws
  it a moment before its keys work. Text sent with a final Enter is written
  first and the Enter 400 ms later, because Muse ignores an Enter that
  arrives with the text; later input, keys and resizes wait behind it.
  Versioned `muse-bin` executables are recognised, as are sessions started
  with `agent: "muse"` through a launcher script.
- `daemon.startWith` runs a configured wrapper when a missing daemon starts.
  An optional environment condition and direct overrides support clients
  already running under a secrets tool. Daemon status reports whether its
  start was wrapped. Windows wrappers must be executable programs rather than
  batch files, and failed wrapped starts clean up the spawned process tree.
  Daemon starts are now serialised per ShellPuppet home through a local
  endpoint that the operating system releases if the starting client dies;
  other clients, `daemon stop` and `daemon restart` wait for a pending start.
- Dashboard launch profiles accept `"envFromDaemon": "all"` to pass the
  daemon's environment to sessions a person starts from that profile.
  Connected feature credentials, ShellPuppet's own variables, `NODE_OPTIONS`
  and malformed variable names stay out;
  client-token starts are unchanged.
- A profile with `"cwd": "ask"` may set `"folders": "any"` to accept an
  existing local folder chosen by path or the desktop picker. Its dashboard
  box offers recent paths and configured root folders together. The picker
  requires the dashboard credential and page proof, allows one dialog at a
  time, and times out after ten minutes.
- Focus and Grid pane boundaries can be dragged or moved with the keyboard.
  Grown panes fit on release; shrunken panes keep their terminal grid. Track
  sizes survive a reload in their own window and reset with Auto or Grid.
- `terminal_wait` can watch for prompts across every live session or a chosen
  list, returning compact waiting details without screens. `now: true` polls
  once. `terminal_list waitingOnly: true` and `shellpuppet list --waiting`
  expose the same view; `shellpuppet wait --prompt` accepts no id or several.
  Filtered views omit question and options. Single-session waits retain their
  existing response.
- Auto fit is on by default in the dashboard. It remembers the toggle and
  refits visible panes after layout or window changes settle, respecting the
  80 by 24 floor and geometry held by another client.
- One remembered dashboard text size control applies to every pane and window.
  `dashboard.fontSize` sets its initial size when the browser has no saved choice.
- Dashboard error banners have a Close button and close on Escape outside a
  terminal. A valid shortcut clears a previous shortcut error.
- Dashboard profiles can offer immediate folders from `folderRoots` alongside
  named folders. The page filters choices, starts the selected one on Enter,
  and keeps recent folders per profile for one-click starts. The daemon
  validates real paths at launch and refuses escaped or removed folders.
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

- Root folder listing uses asynchronous reads and omits dot-prefixed folders,
  links and common Windows system folder names. The Windows Hidden attribute
  is not read. Folder picker helpers run from fixed system paths and are
  cancelled on timeout or daemon shutdown. A mapped drive letter may still
  name a network drive.
- Dashboard panes fill their tile at the 400 by 150 grid cap.
- Dashboard panes fill their tile at the 400 by 150 grid cap. Auto fit refits
  after a settled outside resize, but follows a client that resizes again
  within ten seconds. Followed and held grids scale down to 6 px, then scroll
  when still larger than the pane. Shift+wheel and horizontal wheel movement
  scroll the pane while plain wheel reaches the terminal. Focus and typing
  keep the scrolled view steady, and the guidance note wraps. Text
  stops growing at 40 px; Fit restores the chosen text size.
- Renamed `viewer.launchMode: "none"` to `"no-window"`; `"none"` remains an alias for existing configurations.
- node-pty 1.2.0-beta.18 creates a Windows session's program only once its
  ConPTY output worker has connected: a few hundred milliseconds after the
  spawn returns, and five seconds at most, a bound node-pty adds.
  The start contract is unchanged from the outside: a start still answers
  only once the program exists, so the `pid` in a start response (over HTTP,
  `terminal_start` and `shellpuppet start --json`) is the program's real pid,
  never 0. A start whose program Windows could not create fails as before
  the upgrade (HTTP 500, "Failed to start session", with Windows' code in
  the message). A start whose output worker never connected in those five
  seconds fails with the same status and shape and a message that says so;
  under node-pty 1.1.0 such a start waited instead. Either way no session is
  left behind, and none is listed while the start waits. A kill of a session in its first moments waits the same
  way before its process tree is ended, and the daemon's shutdown kills
  every tree only once every program exists, so a teardown is still awaited
  and verified.
- node-pty now ships Linux prebuilt binaries (glibc, x64 and arm64), so a
  compiler is needed only where none matches (another architecture, or musl
  in place of glibc). `npm install -g --allow-scripts=node-pty shellpuppet`
  stays the documented Linux install, and where no prebuilt matches it is
  still what builds node-pty.
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

- `terminal_wait` and `shellpuppet wait` with `debounce` now settle once the
  condition holds continuously, even when a busy timer keeps repainting.
- Dashboard relayouts now settle session and window assignments before taking
  pane grids, avoiding intermediate resizes when sessions move between windows.
- Dashboard windows return sessions promptly when a window or its session feed
  closes. A late roster from a closed feed cannot reclaim them, while a
  reconnected or reloaded dashboard joins the share again. Documents with the
  same screen ID share sessions separately.
- `terminal_wait` and `shellpuppet wait` with `hideReasoning` now match text and
  regex only on the filtered screen.
- Filtered screenshots repair extra replay text left by terminal serialisation
  after a wrapped row is deleted, so the frozen browser picture matches the
  daemon's rows on active inline screens.
- Direct Windows starts (`--no-shell` or `shell: false`) now preserve literal
  arguments which begin and end with double quotes and contain spaces.
- Dashboard windows retain their session share through slowed browser timers,
  hand sessions back on close, spread overflow by readable capacity and refit
  panes in the window that receives them.
- `terminal_screenshot` and `shellpuppet screenshot` with `hideReasoning` now
  work on screens that keep changing, such as an agent's running timer or an
  idle animation: the picture is taken of the same frozen screen the filter
  read, instead of failing with "The screen changed". The CLI help lists
  `--hide-reasoning` for `screenshot`.
- `hideReasoning` now hides reasoning lines that the terminal wrapped onto
  further rows, on every reader (snapshot, last lines, find, wait, result and
  screenshots). A wrapped row always belongs to the line it continues, so a
  long answer keeps all of its rows.
- A dashboard window keeps driving its sessions' grids when a pane briefly
  reconnects after a relayout, such as Enlarge and Restore or another session
  closing, instead of falling back to following. Every grid take is
  acknowledged, so a pane never repeats a take, and a session that exits on
  its own releases its grid owner.
- Windows starts now retry once when node-pty 1.2.0-beta.18's ConPTY output
  worker misses its connection bound, after the failed console host is confirmed
  ended and node-pty's worker-disposal interval has passed. A start cancelled
  during either attempt fails, and other start failures are returned without retry.
- Dashboard profiles using `envFromDaemon: "all"` no longer inherit agent CLI
  session markers from the process that started the daemon; `SHELLPUPPET_HOME`
  remains available to the launched session.
- Root folder lists omit dot-prefixed directories and common Windows system
  folder names. Rooted launches fill `{folder}` and record the selected folder
  in the start audit.
- A Windows console host that is already gone when cleanup lists it is now
  logged at info level. A session kill can leave no host for the later list;
  ambiguous matches and failed cleanup still warn.
- A daemon on Windows no longer crashes when two sessions end at the same
  moment. `node-pty` is pinned to 1.2.0-beta.18 (the beta VS Code pins,
  `^1.2.0-beta.18` in its `package.json`, checked 30/10/2026): its exit
  watchers once removed their terminals from a list every terminal shares
  with no lock (microsoft/node-pty#921, fixed by #922 in 1.2.0-beta.13), and
  one unlucky pair of exits could end the whole daemon with every session it
  was running. The mutex arrived in 1.2.0-beta.13; the pin is beta.18.
  Windows needs ConPTY for every session now: Windows 10 version 1809
  (build 18309) or later, as node-pty requires; on an older build a start is
  refused with the minimum named, where node-pty 1.1.0 fell back to winpty.
- Every MCP result frames all text read from a terminal (screens, prompt
  questions and options, results) as untrusted data, between boundary lines
  that carry a random value drawn fresh for each result, so a program cannot
  print the closing line. A line on screen that imitates a boundary is shown
  with a leading backslash. This covers the single-session and multi-session
  waits, both list forms and `terminal_result`.
- On Windows, the console hosts queued in one batch are ended by one
  asynchronous PowerShell, off the daemon's thread, so the daemon keeps
  answering `/health` and its other sessions while that call runs. The
  process is ended only by the handle opened, by reading it, before the name
  and creation-time checks, and only when it is still the listed host. A call
  that omits the creation time is refused and leaves the process running.
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
  daemon's children names the host whose creation time falls in that exact
  window, and ends that one process. Sessions that end within a few
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
