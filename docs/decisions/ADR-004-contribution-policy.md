# ADR-004: Contribution policy: DCO, with a published no-relicensing pledge

**Status:** Accepted
**Date:** 2026-09-03
**Decided by:** Red Eagle Tech (product owner)

## Context

Apache-2.0 §5 licenses inbound contributions to the project but does not
assign their copyright. A project that wants the option of relicensing later
needs a contributor licence agreement (CLA) from every contributor, and it
needs it before the first outside contribution: a policy adopted afterwards
cannot bind the contributors who came before it. That is why this decision had
to precede the repository becoming public. The question underneath: keep the
legal option of relicensing future versions of the open core, or give it up
publicly and make its absence the project's commitment?

## Decision

**DCO**: every commit carries a `Signed-off-by` line, checked in CI from the
first external pull request. **And a published pledge:**

> Code released under Apache-2.0 stays Apache-2.0. The project accepts
> contributions under Apache-2.0 §5 with a Developer Certificate of Origin
> only: no CLA, ever. Because the project does not accumulate the right to
> relicense contributed code, a rug-pull is not merely promised away; it is
> structurally impractical.

The pledge is published in [VISION.md](../../VISION.md) and referenced from
CONTRIBUTING.md.

## Alternatives considered

- **A CLA**: preserves relicensing and dual-licensing options, at the cost of
  contributor friction and, for an open-core project, the wrong signal.
- **DCO now, CLA later if needed**: later is exactly when it stops working.

## Consequences

- Dual licensing, and any future licence change for code containing outside
  contributions, are forfeited. That forfeit is the point.
- CONTRIBUTING.md carries the sign-off instructions; the DCO check runs before
  the first outside pull request is possible.
- [ADR-001](ADR-001-two-brand-open-core-naming.md) and
  [ADR-002](ADR-002-apache-2-licence.md) point here for the structural
  guarantee.
