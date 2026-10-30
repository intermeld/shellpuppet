# ADR-001: Two-brand open-core naming: ShellPuppet, by Intermeld

**Status:** Accepted
**Date:** 2026-08-25
**Decided by:** Red Eagle Tech (product owner)

## Context

ShellPuppet is going open source, with a commercial platform to follow: remote
access to sessions over an end-to-end-encrypted relay, growing into agent
governance (fleet supervision, policy, approvals, audit). The open core and the
platform needed names, and the relationship between them, settled before first
publication: an npm package name and a repository's first public URL are
expensive to change once install lines and links accumulate.

## Decision

1. **ShellPuppet** is the open-source product: the terminal-supervision layer
   (daemon, CLI, MCP server, viewer). It keeps its name and identity.
2. **Intermeld** is the commercial platform brand. Positioning: *"Intermeld,
   the agent governance platform; ShellPuppet is its open-source terminal
   layer."*
3. The public repository is **`intermeld/shellpuppet`**, in a GitHub
   organisation that holds only the public open-source surface.
4. The npm package is the bare name **`shellpuppet`**, published by the
   `intermeld` npm organisation.
5. Red Eagle Tech's ownership of both brands is public, stated on the
   organisation profile and the company website.

## Consequences

- The organisation split makes the current boundary inspectable. The binding
  commitment is the boundary section of [VISION.md](../../VISION.md), with
  [ADR-004](ADR-004-contribution-policy.md) giving it structural teeth.
- Licence: [ADR-002](ADR-002-apache-2-licence.md). Names:
  [TRADEMARKS.md](../../TRADEMARKS.md).
