# Decision records

One file per decision that shapes the project: what was decided, the reasons a
contributor needs, the alternatives considered where any are worth recording,
and what the decision commits the project to. They are deliberately short.
The commitments they add up to are collected in [VISION.md](../../VISION.md).

| ADR | Decision |
|---|---|
| [ADR-001](ADR-001-two-brand-open-core-naming.md) | Two-brand open-core naming: ShellPuppet, by Intermeld |
| [ADR-002](ADR-002-apache-2-licence.md) | Licence: Apache-2.0 |
| [ADR-003](ADR-003-typescript-implementation.md) | Implementation language: TypeScript on Node.js |
| [ADR-004](ADR-004-contribution-policy.md) | Contribution policy: DCO with a published no-relicensing pledge |
| [ADR-005](ADR-005-diagnostics-and-feedback.md) | Diagnostics and feedback: off until a person switches it on or sends it |
| [ADR-006](ADR-006-per-agent-modules.md) | A module per agent CLI, declarative from outside (proposed) |
| [ADR-007](ADR-007-connected-features.md) | Connected features: switched on by a person, and each says who can read what it sends |
| [ADR-008](ADR-008-clean-session-environment-by-default.md) | Sessions start with a clean environment by default |

## Conventions

- Named `ADR-NNN-short-title.md`, numbered sequentially, never reused.
- Sections: Status / Date / Context / Decision / Alternatives considered (where
  any are worth recording) / Consequences, with others where a decision needs
  them: ADR-003 ends with *Revisit triggers*. `Supersedes:` and
  `Superseded by:` fields where applicable; a record that changes an earlier
  decision says so.
- Statuses: Proposed → Accepted → Superseded.
- `Date:` is the date of the decision.
- A public record cites only public artefacts.
