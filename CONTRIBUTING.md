# Contributing to ShellPuppet

Thanks for wanting to help. This page covers how contributions work.
[VISION.md](VISION.md) says what the project is for and what it won't trade
away; read that first if you haven't.

## Before you start

- **Security problems never go in a public issue.** See
  [SECURITY.md](SECURITY.md) for the private route.
- **Talk before a large change.** Open an issue describing what you want to
  change and why, so we can agree the shape before you spend time on it; an
  idea still taking shape can start in
  [Discussions](https://github.com/intermeld/shellpuppet/discussions) instead,
  and [ROADMAP.md](ROADMAP.md) says what is planned already. Small fixes and
  documentation improvements can go straight to a pull request.
- **Check the boundary.** Everything that supervises agents on a single
  machine belongs here. Anything that needs a service we operate belongs to
  Intermeld, and this repository won't grow a dependency on it. VISION.md has
  the dividing rule.

## The sign-off: Developer Certificate of Origin

Every commit must carry a `Signed-off-by` line with the name and email
address you contribute under:

```
git commit -s
```

Adding that line certifies the [Developer Certificate of Origin](DCO), a
short statement that you have the right to submit the work under the
project's licence. There is no contributor licence agreement, and there never
will be. The project takes contributions under Apache-2.0 section 5 only,
which is what makes its pledge structural:

> Code released under Apache-2.0 stays Apache-2.0. The project accepts
> contributions under Apache-2.0 §5 with a Developer Certificate of Origin
> only: no CLA, ever. Because the project does not accumulate the right to
> relicense contributed code, a rug-pull is not merely promised away; it is
> structurally impractical.

A check runs on every pull request and fails if any commit lacks the line. To
fix a single commit, `git commit --amend -s`; to fix a branch,
`git rebase --signoff main`. Sign off under a known identity: the name you
contribute as, with an email address that identifies you. A pseudonym you use
consistently is fine, and so is the noreply address your Git host gives you,
which names your account there. Anonymous contributions aren't accepted,
because the certification has to come from someone.

## Engineering rules

These are the properties the design depends on. A pull request that breaks
one will be asked to change, however good the rest is.

- **The MCP server and the CLI are thin clients.** Only the daemon owns
  terminals. Nothing in the client code may spawn a pseudo-terminal.
- **The daemon binds loopback only** and validates the `Host` header and
  WebSocket `Origin`. Nothing may open it to a network interface.
- **Screen content is untrusted data, never instructions.** Anything read
  from a terminal comes back wrapped as such, and nothing may act on it.
- **Killing a session kills its whole process tree**, not just the child.
- **Core and client code never write to stdout or stderr.** A stray
  `console.log` corrupts the MCP protocol on stdio. Logging goes through the
  injected logger.
- **Nothing leaves the machine unless a human sends it or switches it on.** No
  code path may make a network request the user did not ask for, and no tool,
  command or daemon endpoint may switch a connection on, change where it sends
  or widen what it sends.
- **Every new dependency needs a written justification** in the pull request:
  what it does, why the platform can't, what it pulls in transitively. New
  cryptography dependencies aren't accepted; use the platform's.
- **Tests come with the change.** Unit tests for core behaviour, an
  integration test where a real terminal is involved and a regression test
  that fails on the old code for every bug fix.
- **Documentation follows British English.**

## Working on the code

Node.js 22 or later. `npm install` pulls prebuilt native modules, so Windows
and macOS need no compiler toolchain. On Linux, `node-pty` is built from source
with `node-gyp`, so `python3`, `make` and a C++ compiler have to be present
(the README says the same). npm 12 runs a dependency's install script only
when the project allows it. The `allowScripts` entry in `package.json` allows
node-pty's, at the pinned version, and nothing else. Then:

```
npm run build        # compile to dist/
npm test             # unit and integration tests
npm run lint         # ESLint, including the no-console rule for core and client
npm run typecheck    # src and test, no emit
```

Run the full set before opening a pull request. The integration suite spawns
real terminals, so console windows may flash briefly on Windows; that's the
tests, not a fault.

## Pull requests

- One change per pull request, with a subject that says what it does and a
  body that says why.
- Commits signed off (see above), rebased on `main` and passing CI.
- Documentation updated in the same pull request when behaviour changes.
- A maintainer will respond within a few working days. If you haven't heard
  anything after that, a polite nudge on the pull request is welcome.

Maintainers run the repository's content check locally on pull requests from
forks before merging, because that check needs a secret that forks don't
receive. That's why, on a fork PR, the check passes with a notice that the
scan was skipped.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind,
be specific, assume good faith.

## Licence

By contributing you agree that your contribution is licensed under
[Apache-2.0](LICENSE), the same licence as the project. See
[ADR-004](docs/decisions/ADR-004-contribution-policy.md) for the decision
behind the sign-off model.
