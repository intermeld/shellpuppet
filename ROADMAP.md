# Roadmap

What's being worked on now, what comes next and what's further off, without
dates. This page states intent, and it moves as work lands and as feedback
arrives; the commitments the project makes are in [VISION.md](VISION.md). An
idea that becomes agreed work appears here before it ships. If something you
need is missing, say so: [SUPPORT.md](SUPPORT.md) says where.

## Shipped

The [CHANGELOG](CHANGELOG.md) lists every release, and the README says
[what to expect from the latest one](README.md#day-one).
Releases carry npm provenance through trusted publishing from the first.

- **One window for all your sessions** (0.2.0). A dashboard that holds the
  sessions as panes, spreads them across screens, and lets you pop out a pane
  into its own window. Each pane shares the single-session viewer's terminal
  client. See
  [ADR-009](docs/decisions/ADR-009-dashboard-and-sessions-you-start-yourself.md).
- **Sessions you start yourself** (0.2.0). Start a session from the
  dashboard's launch profiles and work in it, then hand it to an agent over
  MCP or let one join you: a session is the same thing whoever started it.
- **Several dashboard windows** (0.3.0). One window takes new starts; drag
  panes between windows; open empty windows; Pop out makes an ordinary one.
- **Messages between sessions** (0.3.0). Any named session can message another,
  whatever agent runs in either; messages wait in a mailbox the daemon keeps and
  are read with an inbox tool, and a free composer gets one fixed line saying a
  message is waiting. Off until you switch it on, with who may message whom in
  your configuration
  ([ADR-010](docs/decisions/ADR-010-messages-between-sessions.md)).
- **Session names, roles and identity** (0.3.0). Each session has its own
  identity and parent, a name you can change, and a chair or delegate role.
- **Launches from sessions** (0.3.0). A session or claim you grant can launch
  your profiles, and relaunch the sessions a restart ended.
- **Sessions that stall, noticed** (0.3.0). A session stopped on a provider
  error is shown as stalled, wakes stalled waits and tells its supervisor.
- **A module per agent CLI** (0.3.0), internal: what is specific to one program
  lives in its own module in this repository
  ([ADR-006](docs/decisions/ADR-006-per-agent-modules.md)).

## Now

- **Prompt detection that covers more shapes.** Each new agent CLI brings a
  shape of its own, and each gets a fixture from a real screen. More provider
  errors noticed as stalls, each with a fixture from a real screen.
- **Reliable typing and nudges across agent CLIs**, including composers that wrap
  long lines at punctuation, and restart records that follow the conversation
  a session has switched to.

## Next

- **Parent and child sessions in the dashboard.** Sessions already know their
  parent; the dashboard groups and tags children and jumps to a parent's
  waiting children, whichever agent supervises.
- **A Hermes module.** Reading, prompt detection and nudges for Hermes, an agent
  meant to run for a long time.
- **Scheduled prompts.** Set a schedule and a message for a session you have
  open, and the daemon types it in at those times: for a long-running agent,
  a regular job or check. Your choice whether a busy session skips that run or
  gets the message queued, as nudges are. Off until you set one, recorded as
  the daemon's own input.
- **Named hosts for a tunnel you run.** The daemon stays on loopback. A tunnel
  that ends there and presents its own hostname, such as Tailscale Serve or a
  Cloudflare Tunnel, gets in once you name that host in your configuration:
  the `Host` and `Origin` checks admit it; the viewer connects over `wss` when
  its page came over `https`, with its cookie marked `Secure`; and viewer
  links are minted with that name. An SSH forward to the same port number
  needs none of this and works today. The tunnel's access control is the
  boundary: whoever it admits reaches the daemon as you.
- **Raw capture on request.** A bounded, in-memory copy of a session's raw
  terminal stream, kept only when switched on for that session and read back
  by an explicit tool, for the times the rendered screen and the program
  disagree.
- **Diagnostics and feedback.** Usage counts and crash reports under a fixed
  schema, off until you switch them on; and feedback drafted on the machine
  you're working on, whether a problem report from you or the agent, a comment
  or an idea, shown to you in full and sent only when you say so
  ([ADR-005](docs/decisions/ADR-005-diagnostics-and-feedback.md)).
- **Feedback from inside the tool.** A command that drafts a note with the
  version and platform facts filled in, shows it to you and opens it in this
  repository's forms for you to send. Nothing leaves until you do, and what
  you send there is public, under your GitHub account, like any issue.
- **The safety check: what an agent is about to do.** Before the daemon
  starts a command or types for an agent, it can ask a checker whether to
  allow it, refuse it or check with you first; a checker that gives no answer
  means checking with you. The checker is part of ShellPuppet, behind a
  public interface so a different one can take its place. It has a shared
  part, with rules that work offline, and a part specific to each agent CLI.
  Configured with a provider you choose, it can also put the question to a
  model there; on a machine registered to Intermeld, to Intermeld's
  ([ADR-007](docs/decisions/ADR-007-connected-features.md)).

## Later

- **Trust evidence.** OpenSSF Scorecard in CI, signed releases with a software
  bill of materials, and the prompt-injection drill re-run and published for
  each release.
- **More ways to install.** winget, Homebrew and signed Windows binaries.
- **Remote access through Intermeld**, end-to-end encrypted, with the client
  half open here.
- **Sessions that stall, nudged.** More provider errors noticed, such as a
  model at capacity, a dropped stream or a usage limit. Nudging a stalled
  session to carry on is a setting, off until you switch it on, and each
  nudge is recorded as the daemon's own input. Further off: a supervisor, a
  model you choose that watches the sessions you put it on,
  nudges the ones that have stalled and, given a goal for a session, checks
  that it is still heading there; on a machine registered to Intermeld, one
  that Intermeld provides
  ([ADR-007](docs/decisions/ADR-007-connected-features.md)).
- **Agent-specific ways to wake a session for a message.** Where an agent
  CLI offers labelled input that is not its user's, its module uses that in
  place of the typed line
  ([ADR-010](docs/decisions/ADR-010-messages-between-sessions.md)).
- **A public module interface**, once the internal modules have settled. The
  project's own modules stay in this repository, and a module loaded from
  outside it is data the core interprets, never code
  ([ADR-006](docs/decisions/ADR-006-per-agent-modules.md)).
