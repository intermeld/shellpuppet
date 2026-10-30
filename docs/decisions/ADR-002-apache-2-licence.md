# ADR-002: Licence: Apache-2.0 for the open-source core

**Status:** Accepted
**Date:** 2026-08-25
**Decided by:** Red Eagle Tech (product owner)

## Context

The open-source release needed a licence before the public repository's first
commit. The model is open-core ([ADR-001](ADR-001-two-brand-open-core-naming.md)):
the terminal layer is open source and the Intermeld platform is commercial.
Adoption is what the open core is for; the business rests on the platform, the
trust story and the names, not on the licence.

## Decision

**Apache-2.0**, copyright Red Eagle Tech Ltd, with a NOTICE file per Apache
convention.

The rule: a permissive OSI licence, and within permissive, Apache-2.0 for its
explicit patent grant (the clause enterprise reviewers of security tooling most
often look for) and its NOTICE convention. MIT would also have fitted the
model.

Apache-2.0 §6 grants no trademark rights. The names are protected separately
([TRADEMARKS.md](../../TRADEMARKS.md)); UK trade mark applications for
ShellPuppet and Intermeld are pending.

## Alternatives considered

- **MIT**: the runner-up, simpler and no obstacle to adoption; set aside for
  the patent grant.
- **AGPL-3.0**: guards against third parties hosting ShellPuppet as a service,
  a risk this project accepts rather than taxing the corporate adopters it
  depends on.
- **Source-available licences (BSL and similar)**: rejected outright; the
  project's position needs a genuine OSI licence.

## Consequences

- Anyone may use, modify, embed or host the open core commercially, including
  in competition with Intermeld.
- Code released under Apache-2.0 stays Apache-2.0. The contribution policy that
  makes that structural is [ADR-004](ADR-004-contribution-policy.md); the
  commitment itself is stated in [VISION.md](../../VISION.md).
- LICENSE and NOTICE ship in the first commit; NOTICE gains third-party
  attributions as dependencies arrive.
