# ADR-010: Messages between sessions, read from a mailbox

**Status:** Proposed
**Date:** 2026-11-15
**Proposed by:** Red Eagle Tech (product owner)

**Amended:** 19 November 2026. Sessions join messaging groups only by a role
from a launch profile a person started, never by name. Named group members
are outside claims only. Messaging rules decide which participants the daemon
will carry messages between. They are not a security boundary against a local
process holding the daemon token: that process can already drive every session.
Our clients refuse to claim when they know they run inside a session, and the
daemon refuses claims presenting a session identity or the inside-session
mark. A request presenting neither is treated as an outside claim. Member
claims are audited.

## Context

People run several agents at once, and some of those agents coordinate the
rest: one agent hands work to another, or several agents share a piece of work
and keep each other informed. Today that coordination depends on each agent
CLI's own messaging, where it has any, so only some agents can lead others.
ShellPuppet already sits under every session it starts, whatever agent runs
there, so it can carry messages between them.

The obvious way to deliver a message is to type it into the receiving
terminal. Typed text carries the authority of the person at the keyboard: the
agent cannot tell a message from another agent apart from an instruction from
its user. Agent CLIs that offer a labelled channel for outside messages each
do it differently, and some offer none.

## Decision

- **Messages live in a mailbox the daemon keeps; the text is never typed.**
  A session sends a message to another session by name. The receiving agent
  reads it with an inbox tool, so the text reaches its model as the result of
  a tool call, which agents already treat as information rather than as their
  user's words. The same commands exist in the CLI, which is the read path for
  sessions that have no ShellPuppet MCP tools.
- **A fixed nudge is the only thing typed.** When a message arrives for a
  session that is idle, the daemon types one fixed line saying that a message
  is waiting, its id, who sent it and how to read it. The line carries no
  message text and no subject. The id is the daemon's own, and the sender is
  the name the daemon holds for that session, shown only when it is a plain
  short name and otherwise replaced by the session id, so nothing a sender
  writes reaches the user's turn. The daemon types it only when the module for that session's agent
  can tell the session is idle, with an empty composer and no prompt waiting,
  or, for an agent that takes a submitted line while it works (Claude Code,
  Grok Build and Muse Code queue it or hand it to the running turn), when a
  turn is running and the composer is visible, empty and unchanged; a
  person's draft during a turn always waits.
  Otherwise the message waits, and the session sees it the next time it reads
  its inbox. A session whose agent has no module that can tell this is never
  nudged. A session gets at most one nudge for each message; a later message
  brings a new nudge that lists every unread one, nudges are rate limited, and every nudge is recorded as the
  daemon's own input.
- **An uncertain typed nudge is never typed again into the same session.**
  Once the daemon has handed the body to the terminal, an unconfirmed submit
  leaves that body pending, even when the composer still appears empty. The
  daemon may send only the submit key after it sees exactly one copy of the
  pending body in the composer, provided no other input has reached the
  session since the body was written. This condition stays false for that
  pending body once a person types, even if they restore the same line or it
  paints late. Terminal reports are not a person's input; a paste identical
  to a terminal report is treated as a report, as it is elsewhere. Later
  messages do not change the condition. The
  recipient reads every waiting message from its inbox. The daemon records
  the ids covered by the pending body and the ids that arrived later. A
  recovered line may name a message already read; the agent reads its inbox
  and gets whatever is waiting. A pending body clears without submission
  only after a submitted turn was seen
  busy and then idle with a positively empty composer, or after the composer
  has been positively empty and the screen unchanged for 30 seconds from the
  last input or output. Input, output, resize, prompt, stall or an unknown
  composer restarts that quiet period. The module must prove emptiness from a
  blank composer or its known placeholder; a guess based on placeholder ink
  alone cannot clear a pending body. A composer showing two copies cannot
  authorise Enter. A refused recovery after other input is audited as
  `person-input-since`. A programme that holds accepted input unpainted for longer
  than the quiet period while showing an empty, idle composer can receive the
  line a second time. The submit check still refuses a composer holding two
  copies, so the daemon never submits that duplicate; a person can clear it.
  An abort records the last failed guard, without recording the line itself.
- **The daemon names the sender.** A daemon-started session sends under the
  identity the daemon gave it at start, proved by a per-session secret in that
  session's environment, not by a name the caller chooses. A client outside
  the daemon can hold a name for as long as it keeps its claim, and reads its
  mailbox without nudges. Names are unique among live sessions. A message is
  bound to the session that held the name when it was sent; if that session
  has ended, the sender is told the message was not delivered rather than a
  later session receiving it.
- **A message carries at most its sender's authority.** It is never the
  user's approval, and it cannot answer a prompt that is waiting for a human.
  Who may message whom is set by the user in configuration, for example a
  parent and its own children, or a group of sessions and outside claims. Messaging is off
  until the user switches it on.
- **Everything stays on the machine and in view.** Messages pass only through
  the local daemon. The dashboard has a view of every message between
  sessions, with its sender, receiver, time and state (waiting, nudged, read
  or not delivered) and its full text, and each session shows its own
  messages. The CLI can list them too. The audit log records the sender, the
  receiver, the time and the length, never the text. Messages are held in memory with size and count limits, and
  a daemon restart discards them.
- **The same for every agent first; agent-specific routes later.** The first
  release works the same way for every agent CLI. A module may later replace
  the typed nudge with a way its agent offers to wake a session with labelled
  input that is not the user's. The mailbox and the rules above stay the same.

## Alternatives considered

- **Typing the message itself, with a label saying who sent it.** The label is
  then part of the user's own turn, and the model has only its wording to go
  on.
- **Driving agents through an agent protocol or vendor SDK instead of the
  terminal.** It gives up the real terminal a person watches and can type
  into, which is what ShellPuppet is for. A prompt sent that way still reaches
  the model as the user's turn.
- **Each agent's own hooks from the start.** They differ by agent, several
  hand their text over as a user prompt, and some agents have none. They are
  improvements to the nudge, so they follow as module work.

## Consequences

- Parent and child sessions (`SHELLPUPPET_SESSION`) come first: the sender's
  identity is built on them.
- An agent that never reads its inbox still receives the nudge, and the
  message waits for it. The nudge is plain text an agent may act on, so its
  wording is fixed in the daemon and tested.
- Messages do not survive a daemon restart in the first release. Durable
  mailboxes, if they come, will need their own rules for storage and retention.
