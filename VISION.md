# ShellPuppet: vision, principles and the open-core boundary

**Version 1.0 · October 2026 · Red Eagle Tech Ltd**

This document is the front door to the project's reasoning. It says what
ShellPuppet is for, the principles it won't trade away, what's open source and
stays that way, and where the commercial platform begins. The
[decision records](docs/decisions/) hold the individual decisions; this
document carries the commitments they add up to. A commitment made here
changes only through a new decision record, never through a quiet edit.

> **Status:** 0.1.0, the first release, is on npm. The [README](README.md)
> carries the current status.

## What ShellPuppet is

An AI agent can run a command and read what comes back. It falls over the
moment the work needs a real terminal: an installer that asks questions, a
REPL, a debugger, an SSH login, another agent's own command-line interface or
a menu that redraws. ShellPuppet gives the agent a real terminal, rendered
through a genuine terminal emulator so it reads a clean screen instead of raw
escape codes, and gives you a live view of that same session in your browser,
where you can watch, type and take over.

It's Playwright's model applied to terminals, with one addition that matters
more than the driving: a human can always see the session and step into it.

The pieces:

- a per-user **daemon** that owns every terminal session and serves the
  viewer, listening on loopback only;
- an **MCP server** exposing twelve small, semantic tools (start, snapshot,
  type, key, wait, find, result, list, resize, screenshot, viewer-url, kill)
  to any MCP-capable agent;
- a **CLI** with the same verbs, for scripts and for agents that prefer a
  shell to a tool call;
- a **browser viewer**, opened by default in its own chromeless window, where
  you see what the agent sees and type into the same session.

The MCP server and the CLI are thin clients. The daemon is the only thing that
touches a terminal, which is why several agents on one machine can share
sessions and why a human can join any of them.

## Who it's for

- **People who delegate to agent CLIs** (Claude Code, Codex, Antigravity,
  Gemini CLI, Goose, Qoder, Grok and others) and want to watch the delegate
  work, answer its prompts and step in without killing it.
- **Agents that need interactive programs**: anything with a prompt, a menu,
  a form to fill in or a screen that redraws.
- **Anyone who wants a supervision point** between "the agent decided" and
  "the command ran". ShellPuppet's job is to make that point exist, on your
  machine, with you in it.

## Principles

These are properties of the product, not settings.

1. **A human can always see and step in.** Every session can be watched from
   the moment it starts: a window opens on your machine by default, and a
   link to watch in a browser of your own, or from elsewhere, is yours for the
   asking. Supervision isn't a mode; it's the reason the tool exists.
2. **Local-first.** The daemon binds 127.0.0.1 on your machine, runs as you,
   and needs no account, no sign-in and no network connection for anything it
   does on its own. It never will.
3. **Nothing leaves your machine unless you send it or switch it on.**
   ShellPuppet on its own has no outbound path: no analytics, no crash
   reporting, no update checks, no licence checks, no network connection you
   didn't ask for. Today that is the whole story. Three things are planned,
   and each starts with a person. Diagnostics, meaning usage counts and crash
   reports that carry no session content and no identifiers, stays off until
   you switch it on to help improve ShellPuppet, or the organisation that
   manages your machine does. Feedback, whether a problem report, a comment or
   an idea, is sent only by you after you've read it, under the rules below.
   Connected features send nothing until you or your organisation switch them
   on, and each says what it sends first. One that uses a provider you choose
   is configured by you, with a credential you hold, and records every send
   with its destination; an Intermeld feature needs your machine registered
   to an Intermeld account, which only a person can do. On a machine your
   organisation manages, switching on can be its decision rather than yours,
   and the people using a session can always see which features are working
   on it and where they send. No ShellPuppet tool, command or daemon endpoint
   switches any of them on, sends feedback, changes where one sends or widens
   what it sends. If the tool ever sends anything you didn't send or switch on,
   treat that as a security vulnerability and [report it](SECURITY.md).
4. **Screen content is data, never instructions.** Everything read from a
   terminal, including another agent's output, is untrusted. The tools say so
   inside their own results, and the design assumes prompt injection will be
   attempted through the screen.
5. **Honest about limits.** ShellPuppet is not a sandbox. Starting a shell
   grants shell access; anything running as your user can drive the daemon; a
   viewer link grants typing. The security documentation says what the design
   does not defend against, and we'd rather you knew than found out.
6. **Small surface, measured claims.** Twelve tools, not ninety. A number
   appears in the documentation because it was measured, and the drills we run
   are published with what actually happened, whatever the result.
7. **You can check what leaves your machine.** The client side of every
   connection, to a provider you choose or to Intermeld, is open source in
   this repository, and it sends only what the features you have switched on
   need. Reaching your sessions from another device is yours to arrange or
   ours to provide. A tunnel you run yourself ends on your machine and brings
   its own access control; the daemon never opens a port to a network. Remote
   access through a relay we operate is an Intermeld capability (see below).

## Diagnostics and feedback

**Planned, not built.** We want to know what breaks and what you wish it did.
The fastest routes are a count of what ShellPuppet does on the machines that
run it, and what you tell us from the machine you're working on. **Neither
exists yet**, and until they do the tool sends nothing at all: there is no
reporting code in this repository and no endpoint to disable. The rules below
are the contract they will be built to, published in advance so you can hold
us to them. They rest on one principle: you're treated well and your privacy
is respected whether or not you've read this page.

**Diagnostics** (what many tools call telemetry) is anonymous usage counts and
crash reports, for people who want to help improve ShellPuppet.

1. **Off until a person switches it on.** You switch it on in your ShellPuppet
   configuration, or the organisation that manages your machine switches it on
   through its device management. After you've used ShellPuppet for a while, it
   may invite you once, in the viewer or the CLI and never in what an agent's
   tools return, to switch it on in your configuration. It asks again only if
   what it would send changes, and saying no changes nothing else. No
   ShellPuppet tool, command or daemon endpoint switches it on. A program
   running as you, which includes an agent's shell, can edit your
   configuration, as it can for any tool. What
   protects you is what the channel can carry: counts, versions and crash
   traces from ShellPuppet's own code. They tell us a lot about how ShellPuppet
   behaves on real machines, and they carry no identifiers and nothing from
   your sessions.
2. **It carries counts, versions and crash traces, nothing else.** Counts and
   timings of ShellPuppet's own operations, the ShellPuppet, Node.js and
   platform versions, and for a crash the error class and a stack trace
   through ShellPuppet's own code. No screen content, no typed input, no
   command lines, no environment variables, no tokens, no usernames, hostnames
   or paths, no free text and no device or install identifier. A trace keeps
   only the function, the file within the package and the line for each frame
   in ShellPuppet's own files; its message line and every other frame are
   dropped. The error class is one of a fixed list, and counts are keyed by
   names fixed in the schema, never by anything taken from a session. The
   schema is a file in this repository, and a build sends nothing the schema
   doesn't name. It's sent as one summary a week, and no identifier links one
   week's summary to another's.
3. **You can see what left.** Every payload is written to a local file before
   it is sent, and the viewer and `shellpuppet daemon status` will say when
   diagnostics is on.

**Feedback** is anything you want to tell us from the tool: a problem report
when something goes wrong, a comment or an idea.

4. **You send it, after reading it.** Feedback is written to a local file and
   shown in full before sending. An agent may draft a problem report when it
   hits a problem; it goes nowhere until you approve it in the viewer or the
   CLI. Nothing is queued, batched or sent on its own.
5. **Feedback carries no session content, and nothing that identifies you
   unless you put it there.** No device or install IDs, no screen content, no
   typed input, no command lines, no
   environment variables, no tokens. Usernames, hostnames and paths, which
   error messages and log lines often hold, are removed when the feedback is
   put together, before you see it, and what you see is what is sent. It
   carries what you write, and your contact details only if you choose to
   include them.

**For both:**

6. **You can read the code and change the destination.** The code that builds
   and sends them will be in this repository. The endpoint will be a
   configuration value, so you can route them to your own systems or switch a
   channel off for a machine.
7. **Where they go is published, and they're handled with care.** They travel
   over an encrypted connection and are stored encrypted, and the address they
   came from isn't kept with them. Who can read them, what they're used for
   (improving ShellPuppet, nothing else) and how long they're kept will be
   stated alongside each feature, and for feedback, how to have it deleted.
   Diagnostics can't be traced to you, so it holds nothing of yours to find
   and delete.

Decision record: [ADR-005](docs/decisions/ADR-005-diagnostics-and-feedback.md).

## What's open, and stays open

Everything in this repository is open source under Apache-2.0, and that
includes every part of supervising agents on a single machine:

- the daemon, the CLI, the MCP server and the viewer;
- the local HTTP and WebSocket API the clients use, which is the same surface
  anyone else's client can use;
- command policy (allow and deny lists), the audit log, environment hygiene
  and the process-tree kill;
- prompt detection and the alerts that tell you a delegate is waiting for an
  answer;
- diagnostics and feedback, including the schema of what they send,
  when they exist;
- the client side of any connection, to a provider you choose or to Intermeld,
  when that exists.

The commitments:

- **What's open stays open.** We won't remove a released capability from the
  open core to sell it back. The boundary moves in one direction only:
  capabilities can graduate from Intermeld into ShellPuppet, never the
  reverse.
- **No account for anything local, and no nagging.** Everything ShellPuppet
  does on your own machine works without an account, and no ShellPuppet
  capability will ever be moved behind a sign-in. Intermeld's capabilities
  need an Intermeld account, because they run on a service we operate; the
  tool says so where you'd reach for them, and nowhere else. No nag screens,
  no upsell prompts, no advertising.
- **No private hooks.** Intermeld talks to ShellPuppet through the same public
  interfaces you can use. No code path in the open core works only with
  Intermeld.
- **You may host it, sell it, fork it or compete with us.** Apache-2.0 permits
  all of that, and we chose it knowing so. Private services, ours included,
  may use contributed code on the same terms the licence grants everyone.

## Where Intermeld begins

Intermeld is Red Eagle Tech's commercial platform for governing AI agents, and
ShellPuppet is its open-source terminal layer. The dividing line is simple:
**if it runs on one machine for one person, it belongs in ShellPuppet; if it
needs a service we operate, or a relationship between machines or between
people, it's Intermeld.** Intermeld's themes:

- reaching your sessions from another device over an end-to-end-encrypted
  relay;
- supervising agents across many machines from one place;
- approval workflows with identity, so a team knows who approved what;
- central policy and consolidated audit across a fleet.

None of that changes what the open tool does on its own. A tunnel you run
yourself to reach the daemon from another device is not a relationship between
machines in that sense: the daemon sees a connection from its own machine, the
tunnel's access control is yours and nothing we operate stands between the
two. What it takes to work with one belongs here, and [ROADMAP.md](ROADMAP.md)
says what that is.

A feature that connects to a provider you choose, such as a model you hold a
key for, is ShellPuppet's: it runs on one machine for one person, with your
credential, configured by you or by the organisation that manages your
machine. Where a feature can use a model, Intermeld's is one of the providers
you may pick, through your Intermeld account.

Every Intermeld feature is off until you or your organisation switches it on,
and it needs the machine registered to an Intermeld account first. Only a
person can register: it takes that person's own sign-in with a second factor,
or the organisation's device management. After that, a feature's settings are
ordinary configuration, as with any tool. Before it is switched on, a feature
says which of two kinds it is:

- **End-to-end encrypted.** Our service carries your data and cannot read it.
  Remote access is one of these.
- **Processed by Intermeld.** Our service reads what it receives to
  do the job, for example checking agent activity for security or safety
  risks.

Each feature also states what it receives, who can read it, where it is kept,
for how long and which other companies process it for us. A feature offered
as end-to-end encrypted will never be changed into one we can read. Anything
that needs to read your data comes as a separate feature, which you choose
whether to switch on. The people using a
session can always see which features are working on it.
[ADR-007](docs/decisions/ADR-007-connected-features.md) records these rules.

## Roadmap

[ROADMAP.md](ROADMAP.md) says what's being worked on now, what comes next and
what's further off, without dates. The README says what has shipped and what
to expect from the first release.

## Naming

ShellPuppet is the open-source product and keeps its name. Intermeld is the
commercial platform brand. Both belong to Red Eagle Tech Ltd. We chose two
names rather than one because it makes the boundary above legible by
construction: what carries the ShellPuppet name is open source, and what
carries the Intermeld name is the platform. The names and logos are
trademarks; how you may use them is set out in [TRADEMARKS.md](TRADEMARKS.md),
and UK trade mark applications for both are pending. The code is free; the
names are how you know what you're getting.
Decision record: [ADR-001](docs/decisions/ADR-001-two-brand-open-core-naming.md).

## Licensing and contributions

The open core is licensed under [Apache-2.0](LICENSE), chosen for its explicit
patent grant and its NOTICE convention. It lets you use, modify, embed, host
and sell the software, including in competition with us. Contributions are
accepted under the Developer Certificate of Origin: you sign off each commit,
and there is no contributor licence agreement. The pledge that goes with that:

> Code released under Apache-2.0 stays Apache-2.0. The project accepts
> contributions under Apache-2.0 §5 with a Developer Certificate of Origin
> only: no CLA, ever. Because the project does not accumulate the right to
> relicense contributed code, a rug-pull is not merely promised away; it is
> structurally impractical.

Decision records: [ADR-002](docs/decisions/ADR-002-apache-2-licence.md)
(licence) and [ADR-004](docs/decisions/ADR-004-contribution-policy.md)
(contributions).

## How decisions get made

Red Eagle Tech maintains ShellPuppet and is its product owner. Decisions with
lasting consequences are recorded as [decision records](docs/decisions/): the
decision, the reasons a contributor needs, the alternatives considered where
any are worth recording, and what the decision commits the project to.
Security reports follow [SECURITY.md](SECURITY.md). A governance document
describing how decisions are made with outside contributors will follow once
there are outside contributors to describe; until then, this document and the
decision records are the whole of it.

## How we'll judge success

Not by stars. By the time it takes a stranger to get from a clean machine to a
supervised session; by how quickly issues and pull requests get a first
response; by the project's Scorecard results; and by whether people who
contribute once come back.
