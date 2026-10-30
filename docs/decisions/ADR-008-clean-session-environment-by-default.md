# ADR-008: Sessions start with a clean environment by default

**Status:** Accepted
**Date:** 2026-10-26
**Decided by:** Red Eagle Tech (product owner)

## Context

A session's environment comes from the daemon's, through `sessionEnv`. The
daemon is long-lived and auto-starts from whichever client reaches it first,
so what it holds is decided by that one client, nondeterministically.

A daemon auto-started by a client running under a secrets manager's wrapper
holds that client's resolved secrets. If its whole environment were passed on,
every later session, and every agent of every vendor driving one, could read
them. Config `envNames` would restrict nothing, because it governs only what
a client adds. The operator has no sign of any of this.

`sessionEnv` has three forms:
- `"clean"`, a minimal functional set;
- the list form, the clean set plus named variables;
- `"passthrough"`, the daemon's whole environment.

A session can also be given variables through `terminal_start`'s `envNames`,
checked against the human's list in config `envNames`. The form that applies
when nobody chooses one decides what sessions hold wherever nobody has read the
configuration reference. A clean set is a workable default only if ordinary
toolchains run in it, and passthrough is a safe choice only if an operator can
see what it hands out.

## Decision

1. **The default is `"clean"`.** A session gets the functional baseline, plus
   the names an operator adds in the list form, plus what its starter passes
   through `envNames`. `"passthrough"` is available, chosen by name.
2. **The baseline covers ordinary toolchains.**
   - On Windows, besides `PATH`, the system folders and the user's profile and
     temporary folders, it holds the standard variables that carry no secrets
     and that MSBuild, the .NET SDK, PowerShell modules and Git for Windows look
     for:
     `ProgramFiles(x86)`, `ProgramW6432`, `CommonProgramFiles`,
     `CommonProgramFiles(x86)`, `CommonProgramW6432`, `ALLUSERSPROFILE`,
     `PUBLIC`, `COMPUTERNAME`, `USERDOMAIN`, `USERDOMAIN_ROAMINGPROFILE`,
     `LOGONSERVER`, `OS`, the `PROCESSOR_*` variables, `PSModulePath` and
     `NoDefaultCurrentDirectoryInExePath`.
   - On POSIX it holds `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR` and
     the locale (`LANG`, `LC_ALL`, `LC_CTYPE`), without which terminal programs
     lose UTF-8.
   - Variables that grant access to a credential, can carry one or change what
     a program trusts stay opt-in through the list form: `SSH_AUTH_SOCK`, the
     proxy variables and `NODE_EXTRA_CA_CERTS`.
3. **Passthrough says what it exposes.** While `"passthrough"` is in effect,
   the daemon names the variables in its environment that look like credentials.
   - It matches by name only: a name split into words contains `KEY`, `TOKEN`,
     `SECRET`, `PASSWORD`, `CREDENTIAL`, `COOKIE`, `AUTH` or similar.
   - It says so once in `daemon.log` at start, and through `shellpuppet daemon
     status` (and `--json`).
   - It never shows a value.

## Alternatives considered

- **`"passthrough"` as the default, with documentation.** That hands the
  daemon's secrets to every session wherever nobody has read the
  documentation, and gives no sign of it.
- **A denylist of secret-shaped names.** Name patterns cannot be complete. A
  missed pattern fails open, where an allowlist fails closed. The pattern
  serves only to name what passthrough exposes.
- **`"clean"` with only what a shell needs to start.** It is safe, but on
  Windows ordinary builds need more, so operators would switch straight to
  `"passthrough"`.

## Consequences

- A program that needs a setting beyond the baseline gets it by name in the
  list form. A credential comes through config `envNames` and
  `terminal_start`'s `envNames`, to the one session that needs it.
- An agent CLI that expands `${VAR}` in its own configuration sees only what
  its session was given.
- `GET /environment`, behind the client token, reports the mode and, under
  passthrough, the exposed names. `/health` stays unauthenticated and says
  nothing about the environment.
