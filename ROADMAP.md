# Roadmap

What's being worked on now, what comes next and what's further off, without
dates. This page states intent, and it moves as work lands and as feedback
arrives; the commitments the project makes are in [VISION.md](VISION.md). An
idea that becomes agreed work appears here before it ships. If something you
need is missing, say so: [SUPPORT.md](SUPPORT.md) says where.

## Shipped

The [CHANGELOG](CHANGELOG.md) lists every release, and the README says
[what to expect from the first release](README.md#day-one).
Releases carry npm provenance through trusted publishing from the first.

## Now

- **One window for all your sessions.** A dashboard that holds the sessions
  as panes, instead of a window per session, and spans more than one screen
  when you want it to. Each pane is the viewer you have today, with the same
  typing, badges and sizing.
- **Sessions you start yourself.** Start a session from the dashboard and work
  in it, then hand it to an agent over MCP or let one join you: a session is
  the same thing whoever started it, and the CLI already starts sessions that
  every connected agent can see. ShellPuppet becomes a place to work as well
  as something an agent invokes.
- **A module per agent CLI.** What's specific to one program moves out of the
  core into a module of its own, in this repository: its prompt detection and
  its measured profile. It starts as an internal refactor, with the profiles as
  the starting point. There's no public module interface yet
  ([ADR-006](docs/decisions/ADR-006-per-agent-modules.md)).
- **Prompt detection that covers more shapes.** Each new agent CLI brings a
  shape of its own, and each gets a fixture from a real screen.

## Next

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
- **A public module interface**, once the internal modules have settled. The
  project's own modules stay in this repository, and a module loaded from
  outside it is data the core interprets, never code
  ([ADR-006](docs/decisions/ADR-006-per-agent-modules.md)).
