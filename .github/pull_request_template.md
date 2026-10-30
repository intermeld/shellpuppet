<!-- Thanks for the pull request. One change per PR, please. -->

## What this changes

<!-- What it does, in a sentence or two. -->

## Why

<!-- The problem it solves, or the issue it closes (e.g. "Closes #12"). -->

## Checklist

- [ ] Every commit carries a `Signed-off-by` line (`git commit -s`); see [CONTRIBUTING.md](https://github.com/intermeld/shellpuppet/blob/main/CONTRIBUTING.md)
- [ ] Tests cover the change; a bug fix includes a regression test that fails on the old code
- [ ] `npm test`, `npm run lint` and `npm run typecheck` pass locally
- [ ] Documentation updated where behaviour changed (British English)
- [ ] No new dependency, or its justification is in this description
- [ ] Nothing here opens the daemon beyond loopback, acts on screen content or makes a network request the user did not ask for
