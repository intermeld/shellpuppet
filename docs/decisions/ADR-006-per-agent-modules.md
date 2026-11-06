# ADR-006: A module per agent CLI, declarative from outside

**Status:** Accepted (2026-11-05)
**Date:** 2026-09-17
**Proposed by:** Red Eagle Tech (product owner)

## Context

The following describes the context when this decision was proposed.

Every program ShellPuppet drives has its own habits. Each shows readiness in
its own way, asks questions in its own shapes, wants input submitted its own
way and paints different things while busy. Qoder discards what is typed
while it settles; Goose prints nothing at all while it boots. Today that
knowledge sits in three places. The core holds general heuristics, such as the
prompt detector and the readiness waits, that must suit every program at once.
Per-agent signatures, for dialogs and for telling an agent's reasoning from
its results, are data, and more can be added in configuration. The measured
specifics are prose in [agent-profiles.md](../reference/agent-profiles.md),
and callers copy its readiness patterns by hand. A fix for one program is a
change for all of them, and a contributor who knows one tool well has nowhere
in the code to improve it on its own. The direction is set out before the
first release, because it shapes what the project tells contributors, even
though the code comes later.

## Decision

- **One module per program.** Agent CLIs such as Claude Code, Codex, Gemini
  CLI, Goose, Qoder and Grok each get a module, and common shells can too. A
  module holds what is specific to its program: how it looks while starting,
  ready, busy or asking a question, what its answers look like and how input
  is submitted. The core keeps what is universal: PTYs, rendering, waits, the
  viewer and every security property.
- **An internal refactor first, after the first release.** Modules are files
  in this repository, with today's tests as the safety net. They are reviewed
  like any other change. A session resolves one identity at start: its explicit
  agent, otherwise a matching program name, otherwise `generic`. Readers,
  writers, waiters, the session list and audit use that same identity. Every
  session runs every module's prompt shapes and dialogs in the existing order,
  including prompts forwarded by a child program inside a known agent session.
  Input, resize, settling and reading use the session's own resolved module.
  A fallback identity has no reading; a configured reading named `generic`
  applies only when explicitly named or matched by program. Screen content
  never changes the session's identity.
- **Data first, with small internal functions where necessary.** Reading and
  dialog signatures retain their existing shapes and configuration overlays.
  A menu settler or command walk may be a small function inside its module.
  These remain candidates for a general capability in the core.
- **No public module interface yet.** The module format may change freely
  until one is published, and publishing one is a decision of its own, taken
  once the internal modules have settled.
- **Modules loaded from outside the repository are declarative.** If that
  arrives, such a module is data the core interprets: patterns, timings, key
  sequences and prompt shapes, never executable code. A module's patterns
  decide what the waits and the prompt detector report: when a session looks
  ready for input and when it is waiting for a human. Callers type on the
  strength of that judgement, so a stranger's code on that path is a different
  risk from a stranger's patterns.

## Alternatives considered

- **One universal detector with special cases.** Every quirk becomes a change
  for every program, tested against all of them.
- **A public module interface with the first release.** An interface is a
  compatibility promise, and what it needs is only knowable once several
  modules exist against real programs. Settled under launch pressure, it
  means keeping a poor design or breaking the first contributors.
- **Executable modules from outside the repository.** Someone else's code
  would decide when to type into a user's terminal, in a product whose
  premise is that screen content is untrusted.

## Consequences

- Agent-profiles.md remains the readiness reference and callers keep passing
  readiness patterns themselves. Readiness defaults, environment markers and
  safety adapters are reserved for subsequent work. The safety engine will
  remain separate from harness adapters, with no safety behaviour added here.
- The refactor aims to keep modules as data, so that a later external format
  can be the one the project already runs on. Where data cannot express
  something, the first choice is a general capability in the core.
- An improvement for one program lands in that program's module and is tested
  against that program's fixtures.
