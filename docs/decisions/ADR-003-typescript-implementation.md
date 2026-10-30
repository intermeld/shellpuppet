# ADR-003: Implementation language: TypeScript on Node.js for the open-source layer

**Status:** Accepted
**Date:** 2026-08-25
**Decided by:** Red Eagle Tech (product owner)

## Context

The daemon, CLI, MCP server and viewer are TypeScript on Node 22+. Before
open-sourcing a privileged tool (it spawns pseudo-terminals and will later hold
device keys), the choice was re-examined rather than inherited: would Rust or Go
be the more credible foundation?

## Decision

Stay with TypeScript on Node.js for the open-source layer. The commercial
platform is built separately; the split is intentional.

The reasons that carry the decision: `node-pty` and xterm are the stack the VS
Code terminal is built on, and this codebase encodes hard-won Windows ConPTY
behaviour on top of them; the MCP ecosystem grew up TypeScript-first and the
tool surface is built on the TypeScript SDK; the viewer is necessarily
JavaScript; and a rewrite would delay the release while discarding verified
code. Memory safety mildly favours a Rust or Go daemon, which would carry a
thinner native footprint than `node-pty` plus V8; that is outweighed, not
absent. The npm supply chain is the ecosystem's real weakness. The controls
for it in place at the first release are a committed lockfile, a written
justification for each new dependency and npm provenance through trusted
publishing; OpenSSF Scorecard in CI is on the roadmap in
[ROADMAP.md](../../ROADMAP.md).

## Alternatives considered

- **Rust**: the strongest alternative; a full rewrite of working code.
- **Go**: the same rewrite cost, with a weaker terminal-emulator half.

## Revisit triggers

Reconsider, daemon first, if enterprise procurement makes a native single
binary gating; if OS-keystore work needs privileged native components beyond
small helpers; or if single-file distribution stays blocked
by the native addon while becoming commercially necessary. Trigger owner: the
product owner. Reviewed at each minor release and immediately when a trigger
fires.
