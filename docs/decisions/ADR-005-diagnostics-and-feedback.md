# ADR-005: Diagnostics and feedback: off until a person switches it on or sends it

**Status:** Accepted
**Date:** 2026-10-28
**Decided by:** Red Eagle Tech (product owner)

## Context

A tool that supervises AI agents in people's terminals has to decide what, if
anything, it sends back to its makers. The choice sits between two ends. At
one end the tool sends nothing under any circumstances, and problems reach us
only when someone writes them up by hand. At the other, the tool reports usage
and errors automatically, which is how much software learns what breaks. In a
terminal that is riskier than most: terminals hold secrets, and the screen
content here is produced by other agents.

Between the two sit the people who run a free tool and are glad to help improve
it, on two conditions: that it costs them nothing they care about and that
they can see what it does. The decision had to be made before the first
release, because a tool's outbound behaviour is part of its trust story from
day one.

## Decision

**Two channels, each switched on by a person, neither on by default.**

1. **Diagnostics: usage counts and crash reports, switched on by a person.**
   Off until you switch it on in your ShellPuppet configuration, or until the
   organisation that manages your machine switches it on through its device
   management. After you have used ShellPuppet for a while, it may invite you
   once, in the viewer or the CLI and never in what an agent's tools return,
   to switch it on in your configuration; it asks again only if what it would
   send changes, and declining changes nothing else. What it can send is fixed
   by a schema in this repository: counts and timings of ShellPuppet's own
   operations; the ShellPuppet, Node.js and platform versions; and for a crash
   the error class and a stack trace through ShellPuppet's own code. It never
   sends screen content, typed input, command lines, environment variables,
   tokens, usernames, hostnames, paths or any other free text, and it carries
   no device or install identifier. A trace is reduced before it is sent: each
   frame in ShellPuppet's own files keeps its function name, its file path
   relative to the package and its line number; frames outside those files are
   dropped; the message line is dropped, because a message can carry what the
   program was handling. The error class is one of the names the schema lists,
   otherwise `Error`. Counts are keyed by names fixed in the schema, never by a
   value taken from a session. Diagnostics is sent as one summary a week,
   crash traces included, and no identifier links one week's summary to
   another's, so the summaries received in a week give an approximate count of
   the installations that have it switched on. Every payload is written to a
   local file before it is sent, so what you can read is what left. The viewer
   and `shellpuppet daemon status` say when diagnostics is on.
2. **Feedback: each item sent by the person who has read it.** Feedback is a
   problem report, a comment or an idea. It is assembled locally, shown in
   full and sent only by a person. An agent may draft a problem report when it
   hits a problem; the draft goes nowhere until a person approves it in the
   viewer or the CLI. Feedback carries the same exclusions as diagnostics,
   except that it may carry text the person adds. Usernames, hostnames and
   paths are removed when it is put together, before it is shown, and what is
   shown is what is sent. Contact details are included only if the person
   chooses to include them.

For both channels the code lives in this repository. The endpoint is a
configuration value, so a machine can route them to its own systems or switch
a channel off. Both travel over an encrypted connection and are stored
encrypted, and the address a payload came from is not kept with it. Where
they go, who reads them, what for and how long they are kept are published
with the feature, and for feedback, how to have it deleted. Diagnostics
cannot be traced to a person, so it holds nothing that could be found and
deleted on someone's request.

**Why the schema, not the switch, is the safeguard.** A program running as
you can do anything you can do, including edit your configuration, as it can
for any tool, so no setting on the machine is out of an agent's reach. For
diagnostics the safeguard is what the channel can carry, not the switch. Its
schema is fixed in the code, carries no session content and no free text, and
names one destination, set where the switch is set. An injected instruction
that managed to switch it on, or to point it elsewhere, would gain counts and
stack frames and nothing else. Feedback carries free text, which is where
session content would leak, so each item passes a person. In both cases no
ShellPuppet tool, CLI verb or daemon endpoint switches a channel on or sends
anything.

## Alternatives considered

- **No reporting of any kind.** The strongest privacy statement and the
  simplest to verify, but bugs would stay invisible until someone wrote them
  up, and the people who want to help would have no way to.
- **Telemetry on by default, with an opt-out.** It gives the most signal, but
  someone who never read the documentation would be sending data without
  knowing it. That runs against the principle these channels are built on:
  people are treated well and their privacy respected whether or not they have
  read the documentation.
- **Asking until you agree.** A prompt that returns after a no is pressure,
  not a choice. One invitation, shown to the person and repeated only when
  what diagnostics would send changes, is the limit.
- **A ShellPuppet command or tool that switches diagnostics on.** It would hand
  an agent the switch. The setting lives in configuration or device management
  only.
- **Diagnostics that runs unseen once switched on.** A channel nobody can
  inspect has to be taken on trust, whoever switched it on. So
  every payload is written to a local file before it is sent, and the viewer
  and `daemon status` show that the channel is on.
- **Feedback sent automatically.** Feedback carries free text, and an
  outbound channel an agent could trigger unreviewed would be the path an
  injected instruction reaches for.
- **An install identifier in diagnostics.** It would link every report from
  one installation, which makes the data pseudonymous rather than anonymous.
  Crash reports are grouped by a hash of their reduced frames instead, and a
  week's summaries give an approximate count of the installations that have
  it switched on.

## Consequences

- The README, SECURITY.md and VISION.md state the position as "nothing leaves
  your machine unless you send it or switch it on": diagnostics and connected
  features are switched on by a person, feedback is sent by one, and
  ShellPuppet on its own has no outbound path. ADR-007 sets the rules for the
  connections to a provider you choose and to Intermeld.
- Both channels are roadmap work, not properties of the first release. Until
  they ship, the tool has no outbound path at all and there is nothing to
  switch off.
- When diagnostics lands, its schema is a file in this repository, tests pin
  that a payload holds only what the schema names and that no tool, CLI verb or
  daemon endpoint can switch it on, and the viewer and `daemon status` show
  that it is on.
- Diagnostics is anonymous: it carries no identifier, and the address it came
  from is not kept with it. Feedback is anonymous unless the person includes
  contact details or writes something that identifies them.
