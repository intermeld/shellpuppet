# ShellPuppet documentation

| Location | Contents |
|---|---|
| [`architecture/design.md`](architecture/design.md) | **The build specification.** Self-contained: the daemon, thin clients, tool surface, security model, viewer, test plan and platform quirks. |
| [`reference/security-model.md`](reference/security-model.md) | The security model as an operator sees it, the limits that remain and the recorded prompt-injection drill. |
| [`reference/configuration.md`](reference/configuration.md) | Every `config.json` option, with the fail-closed rules. |
| [`reference/releasing.md`](reference/releasing.md) | How a maintainer publishes a version to npm: trusted publishing that can only stage, provenance and the two approvals. |
| [`reference/agent-profiles.md`](reference/agent-profiles.md) | Measured behaviour of the agent CLIs, readiness and idleness regexes, recipes and the manual smoke checklist. |
| [`decisions/`](decisions/) | Decision records ADR-001 to ADR-008. |

What the project is for, its principles and the open-core boundary are in
[`VISION.md`](../VISION.md) at the repository root, alongside
[`SECURITY.md`](../SECURITY.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md),
[`SUPPORT.md`](../SUPPORT.md) and [`TRADEMARKS.md`](../TRADEMARKS.md).
