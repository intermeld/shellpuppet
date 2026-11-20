# ADR-011: Session permission to launch profiles

**Status:** Accepted
**Date:** 2026-11-20

## Decision

The owner grants current participant names access to every configured launch
profile through `launcher.sessionLaunch`. The daemon authenticates the
session or outside claim, resolves its name and records who started the
child. A profile supplies all arguments, including an optional resume
template, and controls its role and environment. Both dashboard and session
launches follow ADR-009. This extends the sources of a chair role in ADR-010.

## Consequences

An unattended supervisor can recover a chair with its configured environment
and conversation. There is no per-profile grant list. Granting one name can
expose any credentials a profile passes to its child. A process running as
the same user with the daemon token can claim a free outside name.
An outside claimant keeps its proof across daemon restarts. Only its secret
digest is stored in the private home. Removing a grant revokes launch access.
