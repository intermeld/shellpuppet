# Security policy

ShellPuppet lets an AI agent drive a real terminal while a human supervises. We
treat security reports on it with corresponding seriousness. This policy
follows Red Eagle Tech's
[vulnerability disclosure programme](https://redeagle.tech/vulnerability-disclosure),
which covers everything the company publishes; this page adds what is specific
to ShellPuppet. It is how to report a vulnerability and what counts as one. How
ShellPuppet protects you, and the limits that remain, is in the
[security model](docs/reference/security-model.md).

## Reporting a vulnerability

**Please don't open a public issue for a suspected vulnerability.** Either
route below reaches the same people:

- GitHub **private vulnerability reporting** on this repository; or
- email **security@redeagle.tech**. To encrypt, use the
  [Red Eagle Tech security PGP key](https://redeagle.tech/pgp-key.asc),
  fingerprint `C5AB 412E 4CAE 4CE3 ECB1 F9C9 E32E F95C 43A3 1BBD`.

The company's [security.txt](https://redeagle.tech/.well-known/security.txt)
carries the same details.

Please include:

- what you found and why it matters, with your view of the severity;
- steps to reproduce, with proof-of-concept code, screenshots or a recording
  where they help;
- the component (daemon, CLI, MCP server or viewer), the ShellPuppet version
  or commit, the Node.js version and the operating system;
- any configuration that matters, such as command policy, `sessionEnv` or the
  viewer launch mode.

## What we promise

- **Acknowledgement within three business days**, and initial triage within
  ten.
- **Regular updates** while we investigate and fix. The fix timeline depends
  on severity, and we'll tell you where things stand.
- **Coordinated disclosure.** We agree the timing with you and publish after
  the fix, or within 90 days at most, as a GitHub security advisory and in the
  release notes.
- **Credit** in the advisory and release notes unless you'd rather not, and a
  place in Red Eagle Tech's
  [security hall of fame](https://redeagle.tech/vulnerability-disclosure#hall-of-fame)
  for valid findings. The company programme describes its other thanks.

If you haven't heard back within the promised time, nudge us. We're human and
occasionally miss an email.

## Ground rules and safe harbour

Testing ShellPuppet on your own machine needs nobody's permission: it's your
software and your terminal. When research touches systems Red Eagle Tech
operates, such as the website or, later, an Intermeld service, the company
programme's ground rules apply: minimise impact, don't run denial-of-service
attacks or scanners that overwhelm systems, don't access, change or delete data
that isn't yours and don't social-engineer staff. Stop immediately if you
encounter someone else's data. Either way, please don't share a vulnerability
publicly before we've had a chance to fix it.

Follow these guidelines in good faith and Red Eagle Tech will not pursue legal
action against you. If a third party gives you trouble over research that
followed the rules, we'll confirm you had our permission. That is the company's
safe-harbour commitment, and it applies here in full.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| 0.0.1 (placeholder) | No |

Before 1.0, security fixes go into the latest release only: upgrade to
receive them.

## Scope notes

What the design claims, so reports can target it:

- **Screen content is untrusted data** throughout the design. Prompt-injection
  reports about *content* are the threat model working as intended, not
  vulnerabilities, unless the tooling fails to apply that rule somewhere.
- **The daemon binds loopback only.** It validates the `Host` header and the
  WebSocket `Origin`, sends no CORS headers and requires a credential
  everywhere but `/health`, the viewer page and its static assets. Those three
  answer without one deliberately: none of them can read or act on a session,
  and refusing the page would tell an unauthenticated caller which session ids
  exist. Reports that assume a remotely reachable daemon should show how one of
  those is bypassed. A daemon reached through a tunnel you run yourself is
  reached as you; what that tunnel admits is the tunnel's concern.
- **Anything running as your user can drive the daemon.** That is the
  same-user model, as with an SSH agent, and it is by design. A report should
  show a crossing of a boundary the design does claim: the client token, the
  session-scoped viewer grant and viewer credential, the command policy or the
  process-tree kill.

## Nothing leaves your machine unless you send it or switch it on

The open-source tool sends nothing on its own: no analytics, no usage
reporting, no crash reporting, no update checks. It has no outbound path at
all today.

Three connections are planned, and each starts with a person:
- **Diagnostics** (what many tools call telemetry). Usage counts and crash
  reports under a fixed schema that carries no session content, no free text
  and no identifiers. Off until you, or the organisation that manages your
  machine, switch it on, under the rules in
  [VISION.md](VISION.md#diagnostics-and-feedback). Its switch is ordinary
  configuration, which a program running as you can edit; the schema is the
  safeguard
  ([ADR-005](docs/decisions/ADR-005-diagnostics-and-feedback.md)).
- **Feedback.** Anything you send us from the tool, whether a problem report,
  a comment or an idea, is sent only by you, after you've read exactly what it
  holds, under the rules in the same section.
- **Connected features.** One that uses a provider you choose is configured by
  you, or by the organisation that manages your machine, with a destination
  and a credential of your own; it says what it sends first, and every send
  is recorded in the audit log with its destination before it happens. An
  Intermeld feature needs the machine registered to an Intermeld account
  first, which only a person can do, with a second factor or through the
  organisation's device management. After that its settings are ordinary
  configuration, as with any tool, and every send is recorded. A program
  running as you can edit that configuration: that is the same-user model
  above, not a vulnerability, and a send it causes is still recorded with its
  destination ([ADR-007](docs/decisions/ADR-007-connected-features.md)).

A serious vulnerability is any report showing one of these:
- the tool sent something you did not send or switch on;
- the body of a diagnostics payload held anything its schema does not name;
- a connected feature sent something its data sheet does not name;
- a send that the audit log does not record, or records with the wrong
  destination;
- an agent could switch a connection on, or change where it sends, through a
  ShellPuppet tool, command or daemon endpoint;
- an Intermeld account or machine could be registered without the person, or
  a machine's registration used after the person removed it.

Please report it privately as above.
