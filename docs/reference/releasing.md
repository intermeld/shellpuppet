# Releasing

How a maintainer publishes a version of ShellPuppet to npm. Publishing needs:
- write access to this repository;
- a maintainer's approval of the deployment;
- a maintainer's approval on npm, with two-factor authentication.

The workflow uses no long-lived npm token.

## How it is wired

- **Trusted publishing, stage only.** The `shellpuppet` package on npmjs.com
  trusts one publisher: this repository's `publish.yml` workflow, running in
  the `npm-publish` environment. It allows that publisher `npm stage publish`
  and nothing else. npm exchanges the workflow's identity for a short-lived
  credential that can stage a version but cannot publish one, so the workflow
  holds no npm token to leak or rotate.
- **The tagged commit is checked whole.** A version tag must:
  - match `package.json`;
  - name a release, not a prerelease;
  - point at a commit on `main`.

  The workflow runs the full CI workflow against that commit and packs the
  tarball once, in a job with no publishing rights. It then installs that
  tarball on Windows, Linux and macOS and drives a session through it.
- **Provenance or nothing.** The staging step passes `--provenance`, so npm
  refuses to stage at all when it cannot attach a provenance statement, for
  example from a private repository. After approval, the *Verify release*
  workflow checks three things:
  - npm serves the tarball the run checked;
  - the provenance names this repository, `publish.yml`, the version's tag,
    the Publish run itself and the commit it built;
  - npm verifies the package's signature and attestations.

  These checks trust `publish.yml` as it is reviewed on `main`. Anyone who
  can change that file can change what it checks, so what guards it is
  branch protection.
- **Two human gates.**
  - **The `npm-publish` environment** accepts only version tags, and waits for
    a maintainer to approve each deployment. The job behind it installs no
    dependencies and runs no project code. It stages the tarball the other
    jobs checked, with lifecycle scripts off, so npm itself is the only
    program it trusts.
  - **The staged version stays out of public view** until a maintainer
    approves it on npm with two-factor authentication. Staging needs no second
    factor, so anyone holding a publishing credential could stage something.
    That is why the maintainer checks the staged tarball against the run
    before approving it.

## One-time setup

These settings live outside the repository, so check them rather than assume
them. All four must be in place before a release.

1. **The repository is public.** npm attaches provenance only to packages
   built from public repositories.
2. **The trusted publisher on npmjs.com.** In the package's settings, under
   Trusted publishers, then GitHub Actions, it names:
   - the organisation `intermeld`;
   - the repository `shellpuppet`;
   - the workflow `publish.yml`;
   - the environment `npm-publish`.

   Its only allowed action is `npm stage publish`. Leave `npm publish`
   unticked: this workflow never publishes directly.
3. **The `npm-publish` environment** (the repository's settings, then
   Environments):
   - **Required reviewers** lists a maintainer.
   - **Prevent self-review** is off while there is a single maintainer.
   - **Allow administrators to bypass configured protection rules** is
     cleared.
   - Under **Deployment branches and tags**, **Selected branches and tags**
     holds one rule of type **Tag** with the pattern `v*.*.*`. A branch rule
     with that pattern would never admit a tag.
4. **Tokens cannot publish.** The package's publishing access is set to the
   strictest option: two-factor authentication required, tokens disallowed.
   Trusted publishing and approving a staged version both work under it.

The maintainer's own machine needs one thing, checked before tagging: an npm
with the `stage` commands, signed in as a maintainer of the package, with
two-factor authentication on the account. That means npm 11.15.0 or later;
11.20.0 is what the workflow uses. Check before tagging:
- `npm --version` shows the version;
- `npm whoami` shows who is signed in;
- `npm owner ls shellpuppet` must list that account.

The first approve or reject then asks for the second factor. The workflow's
short-lived credential can stage a version, but it cannot
download, inspect, approve or reject staged versions. Those take the
maintainer's own login.

## Each release

1. **Prepare it in a pull request.**
   - Set the version with `npm version <x.y.z> --no-git-tag-version`.
   - Move the notes under "Unreleased" in `CHANGELOG.md` to a heading with the
     version and the date.
   - Update anything in the README that names a version.

   The pull request is reviewed and merged like any other.
2. **Tag the merged commit:**
   ```sh
   git switch main && git pull
   git tag -a v<x.y.z> -m "ShellPuppet <x.y.z>"
   git push origin v<x.y.z>
   ```
   Push one release tag at a time, and let its run finish before tagging the
   next.
3. **Approve the deployment** once every other job in the Publish run is
   green. The publish job stages the checked tarball, and the run's summary
   shows the tarball's SHA-256 and the stage id. Nothing is public yet.
4. **Check the staged tarball, then approve it.**
   ```sh
   npm stage download <stage-id>
   sha256sum shellpuppet-<x.y.z>-<stage-id>.tgz   # must match the run summary
   npm stage approve <stage-id>                     # asks for two-factor authentication
   ```
   In PowerShell the check is
   `(Get-FileHash shellpuppet-<x.y.z>-<stage-id>.tgz -Algorithm SHA256).Hash.ToLower()`.
   You can also approve it on npmjs.com, which lists the package's staged
   versions, once the downloaded tarball has matched. Approve only a version
   from a Publish run that succeeded as a whole. `npm stage reject` also asks
   for two-factor authentication.
5. **Verify it.** Run the *Verify release* workflow with the version and the
   Publish run's id. It refuses a run that is not a successful Publish run for
   that version's tag. It also refuses provenance from any other run or commit.
   ```sh
   gh workflow run verify-release.yml -f version=<x.y.z> -f run_id=<run-id>
   ```
   It must pass. The version then appears on npmjs.com with a provenance
   badge, and `npm install -g shellpuppet@<x.y.z>` works on a clean machine.
6. **Publish the GitHub Release** from the tag, with that version's changelog
   section as its notes.

## When something goes wrong

- **A job before the deployment approval fails.** Nothing was staged.
  1. Fix the cause on `main`.
  2. Delete the tag locally and on GitHub: `git tag -d v<x.y.z>`, then
     `git push origin :refs/tags/v<x.y.z>`.
  3. Tag the fixed commit.

  If the refusal was the private repository, nothing on `main` needs fixing:
  make the repository public, then delete the tag and push it again. Re-running
  the jobs is not enough, because a re-run replays the original push event,
  which still records the repository as private.
- **The Publish run fails after the deployment approval.** Do not approve
  anything it staged. *Verify release* accepts only a successful Publish run,
  so a version approved from a failed run can never be verified. Run
  `npm stage list shellpuppet`.
  - **If the version is not listed,** nothing was staged. Fix the cause and
    re-run the failed jobs.
  - **If it is listed,** a staged version holds its version number, so the same
    version cannot be staged again until it is rejected. Reject it with
    `npm stage reject <stage-id>`, fix the cause, then re-run the failed jobs.
    A re-run while the version is still staged fails at the staging step.
- **The staged tarball does not match the run's SHA-256.** Do not approve it.
  Something other than this run staged that tarball, so treat it as a security
  incident. Keep the evidence before removing anything:
  1. Keep the downloaded tarball, and save what `npm stage view <stage-id>`
     reports.
  2. Check the package's maintainers and tokens on npmjs.com.
  3. Only then reject it with `npm stage reject <stage-id>`. Rejecting deletes
     the staged record and its tarball from the registry.
- **A release abandoned after staging.** A staged version that is never
  approved stays on npm, holding its version number, until someone rejects it.
  Reject it explicitly with `npm stage reject <stage-id>`.
- **Once a version is approved, never re-run the publish job or push its tag
  again.** A version number can never be used twice on npm, even after an
  unpublish, so the run can only fail. Fix forward with a new patch version.
- **Verify release fails.** The version is public, so find out why before
  anything else.
  - **If npm serves a different tarball, or the provenance names another
    repository, workflow, tag, run or commit,** deprecate the version, publish
    a fix and treat it as a security incident.
  - **If the provenance is not visible yet,** wait a few minutes and
    run the workflow again.
- **A bad version.** `npm deprecate shellpuppet@<x.y.z> "<reason>"` warns
  anyone who installs it. Whether it can also be unpublished depends on npm's
  [unpublish policy](https://docs.npmjs.com/policies/unpublish). Deprecating
  it and publishing a fix is the normal response.
