# ADR-007: Connected features: switched on by a person, and each says who can read what it sends

**Status:** Accepted
**Date:** 2026-10-28
**Decided by:** Red Eagle Tech (product owner)

## Context

ShellPuppet has no outbound path today. ADR-005 sets the rules for the two
channels planned inside the open tool itself: diagnostics, which a person
switches on and which carries no session content, and feedback, which a
person sends after reading.

Every other connection is a connected feature: a capability that does its job
by sending something to a service. Two sorts are in view.

- **A connection to a provider you choose.** Some capabilities need a model,
  and you may already have one: an inference provider you hold a key for, a
  model served on your own machine or network, or a gateway your organisation
  runs. You give ShellPuppet the destination and the credential, as you would
  any coding harness. Checking what an agent is about to do against a model
  you name is the first capability of this sort in view.
- **A connection to Intermeld,** the commercial platform described in
  [VISION.md](../../VISION.md#where-intermeld-begins), which adds connections
  from the open tool to a service we operate. Its features will not all work
  the same way. Some can be end-to-end encrypted, so our service carries data
  it cannot read; remote access is the first of these. Others can only do
  their job by reading what they receive; checking agent activity for security
  or safety risks is an example.

The rules below cover both sorts, before the first connection exists.

ADR-005's security reasoning applies here too. An outbound channel that an
agent could open is the path an injected instruction reaches for. A program
running as you can edit your configuration, as it can for any tool, so the
safeguards are that ShellPuppet's own tools, commands and endpoints never
switch a connection on, that a connection sends only what it declares, and
that every send is recorded with its destination. The two sorts differ in who
receives the data, and the rules differ with them.

## Decision

1. **Nothing leaves your machine unless you send it or switch it on.**
   Diagnostics and feedback stay under ADR-005. Every other connection
   is a feature that a person switches on, to a provider you choose or to
   Intermeld. A program ShellPuppet consults or sends through for its own
   purposes, such as a checker it asks before acting, is bound by these rules
   as ShellPuppet is. The browser it opens for the viewer or for a screenshot
   is your browser, and the programs you ask it to drive in a session are
   yours: neither is under these rules.
2. **A connection to a provider you choose is ordinary configuration.** You
   set the destination and the credential in your ShellPuppet configuration,
   or the organisation that manages your machine sets them through its device
   management.
   - The feature says what it sends before you configure it: which fields,
     drawn from what. It sends nothing else.
   - You choose the destination: any provider, at any endpoint you give it.
     ShellPuppet may come to know some providers by name, so that you do not
     have to describe how to talk to them, but there is no list of permitted
     providers.
   - Every send is recorded in the audit log, against the session, with the
     host it connects to, and the viewer and `shellpuppet daemon status` show
     which connection is on and where it goes. The entry is written before the
     send, and a send that cannot be recorded does not happen.
   - Your configuration holds the credential, or names the environment
     variable the daemon reads it from, so a credential manager can place it
     there for the daemon's lifetime without writing it to disk. The daemon
     never shows it: not in tool results, logs, the audit trail or the viewer.
     And it never hands its own copy to the sessions it starts, under
     `passthrough` as much as under the clean default; a value a client passes
     through `envNames` is that client's to pass.
   - No ShellPuppet tool, command or daemon endpoint sets or changes a
     destination or a credential, switches the feature on or widens what it
     sends.
   - A feature that cannot reach its provider fails safe. A check that gets no
     answer asks a person; it never allows on silence.

   A program running as you, which includes an agent's shell, can edit this
   configuration, and can read any credential the daemon can read. It gains
   no way of sending that a shell does not already have, and what it makes
   ShellPuppet send is recorded, with its destination, where the people using
   the session can see it. What protects you here is that you chose the
   recipient, you hold the credential and nothing is sent unrecorded. What
   such an edit does gain is persistence and the answer: it outlives the
   session and the agent, and a feature that asks the configured destination
   what to do takes that destination's answer. Against an agent that can
   write this configuration, a feature that checks the agent's actions is
   therefore advice, not a control; an organisation that needs a control sets
   the configuration from outside the machine, through its device management,
   in a place the agent cannot write. The daemon records the destination in the
   audit log when it starts and whenever it changes, so the record shows when
   as well as where.
3. **An Intermeld feature works only on a machine a person has registered.**
   - A machine is registered to an Intermeld account by someone with authority
     over it: the person who owns it, or an administrator of the organisation
     that manages it.
   - Creating the account and registering a machine take that person's own
     sign-in, confirmed with a second factor, or the organisation's device
     management, for example as part of how it deploys its machines. An agent
     on the machine cannot complete either. Other routes may follow, and each
     must meet this rule.
   - After that, which features are on is ordinary configuration, as with any
     tool: you, or a program running as you, can switch them on and off, and
     the people using a session can see which are working.
   - No ShellPuppet tool, command or daemon endpoint switches a feature on,
     and none can widen what a switched-on feature sends.
   - The client side of every connection is open source in this repository,
     and it sends only what the switched-on features need.
   - A machine removed from the account stops: the service refuses its
     credential.
   - The registration never identifies the hardware: no device fingerprint.
     Where the platform offers a key store that keeps a key on the machine,
     the machine's credential is held there.

   The rule is stricter here than for a provider you choose because the
   recipient is the company that makes the tool. Our service must not be able
   to appear on your machine by our doing or by an agent's, only by a person's
   registration.
4. **Every connected feature declares its kind before it can be switched on.**
   There are three kinds:
   - **processed by a provider you choose:** the provider reads what it
     receives, under the terms you hold with it;
   - **end-to-end encrypted:** our service carries the data and cannot read
     it;
   - **processed by Intermeld:** our service reads what it receives to do the
     job.

   Each feature also publishes a data sheet: what it receives, who can read
   it, where it is kept, for how long and which other companies process it
   for us. For a provider you choose, the data sheet says what is sent, says
   in terms whether screen content or typed input is among it, and says that
   the provider's own terms govern what happens to it.
5. **No silent downgrade.** A feature offered as end-to-end encrypted is never
   changed into one we can read. Anything that needs to read comes as a
   separate feature, with its own switch and its own data sheet.
6. **The people using a session can see which features are working on it,**
   and where each one sends, in the viewer and through the tools.
7. **Remote access is offered end-to-end encrypted.** The relay carries
   ciphertext only, and the keys live on your devices. A feature that needs to
   read what passes through, such as checking agent activity for risks, is a
   separate one you choose to switch on (decision 5).

Promises that belong to a single feature, such as retention periods and
hosting regions, go in that feature's data sheet when it ships, not in this
repository.

## Alternatives considered

- **A promise that Intermeld never reads your data.** It would either rule out
  features that only work by reading, or be broken when one arrives.
- **End-to-end encryption everywhere, with exceptions decided later.** This
  has the same problem, and costs more trust when the exceptions come.
- **An approval in the Intermeld account for each feature, beyond the
  machine's registration.** It would keep each switch out of an agent's
  reach. But an agent acting as you can change any setting on your machine,
  as it can for any tool, and a switch held on our side for every feature is
  not how people expect a tool to work. Registration, which an agent cannot
  complete, the declared payload and the record of every send carry the
  safeguard instead.
- **A device fingerprint to bind a credential to a machine.** It identifies
  the hardware, the kind of identifier ShellPuppet never collects. A key held
  in the platform's key store binds the credential without one.
- **A list of permitted providers.** It would guard against an attacker who
  already has your shell, at the price of every provider not on the list, and
  a key and an endpoint in your own configuration is how coding harnesses
  work. The audit log, naming where each send went, is the safeguard instead.
- **Describing each future feature here.** This repository records decisions.
  Features that do not exist yet get their data sheets when they ship.

## Consequences

- **The documents state the position as "nothing leaves your machine unless
  you send it or switch it on":**
  - VISION.md: principles 3 and 7, and "Where Intermeld begins";
  - the README, SECURITY.md, CONTRIBUTING.md, AGENTS.md and the CHANGELOG;
  - the feature-request template;
  - the design document and the security model.

  Diagnostics and feedback keep ADR-005's rules.
- **A client for a provider you choose has fixed obligations when it lands
  here.**
  - It connects only to the destination configured, with the credential the
    configuration holds or names, and sends only the fields its data sheet
    names. A credential read from a named variable it takes out of the
    environment it hands to sessions, whatever `sessionEnv` says, and when the
    named variable is unset it says so at start, by name.
  - It writes the audit entry for a send before sending, naming the host it
    connects to and any proxy it uses, and it honours no proxy setting it
    does not record. If the audit log cannot be written it sends nothing, a
    check falls to asking a person, and `shellpuppet daemon status` and the
    viewer say that auditing has stopped.
  - It records the configured destination at daemon start and whenever it
    changes, and reports the connection and its destination to the viewer and
    `shellpuppet daemon status`.
  - Tests pin that no MCP tool, CLI command or daemon endpoint can set or
    change a destination or a credential, that an audit entry carries the
    destination, and that nothing is sent when the entry cannot be written.
- **The documentation for such a feature recommends a credential manager that
  injects the secret at run time** over a value written into the
  configuration file: the credential then exists in the daemon's memory and
  nowhere on disk. The 1Password CLI, Bitwarden Secrets Manager, Doppler and
  Infisical each have a command that runs a program with secrets in its
  environment; HashiCorp Vault does the same through its agent. The daemon
  inherits its environment from whichever client started it and outlives that
  client, so the documentation says to start the daemon itself under the
  manager; when it was not started that way, its report that the named
  variable is unset says so.
- **The Intermeld client has fixed obligations when it lands here.**
  - It reads which features are switched on from the machine's configuration.
  - It sends only what those features need, and shows which ones they are.
  - Tests pin that no MCP tool, CLI command or daemon endpoint can switch a
    feature on.
- **Some reports count as security vulnerabilities** (SECURITY.md): a report
  showing that the tool sent something nobody sent or switched on, that a
  connected feature sent something its data sheet does not name, that a send
  went unrecorded or was recorded with the wrong destination, that an agent
  could switch a connection on or change where it sends through a ShellPuppet
  tool, command or daemon endpoint, or that an Intermeld account or machine
  could be registered without the person, or a removed machine's registration
  still used.
- **The limit stays as principle 5 states it:** a program running as you can
  do what you can do. An agent with a shell can start a sign-in, and could
  drive a browser that is already signed in. So registering an account or a
  machine must depend on something an agent on the machine cannot supply,
  such as a second factor the person holds or the organisation's own device
  management, and a registration must say plainly which machine it covers.
