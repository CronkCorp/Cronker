# Releasing

How a new version of Cronk is cut. Installations upgrade by following **Upgrading** in `docs/setup.md`.

## Versions

- Semantic versions below 1.0, tagged `v0.<minor>.<patch>` on a commit of `main`, with `package.json`'s `version` set to match.
- **Minor** (`v0.2.0`): new behaviour, such as a milestone's tickets, or anything an installation must act on (a migration that can't run on its own, a new environment variable, a GitHub App permission to accept).
- **Patch** (`v0.2.1`): fixes only, nothing to do by hand.
- Every release is a GitHub Release on that tag. There are no release branches: a fix for an older release is released from `main` as the next patch.

## Once: npm

The daemon is published as `cronk-runner` on npm by trusted publishing, so there is no npm token. In the package's settings on npm, a maintainer:

- adds a **trusted publisher** for GitHub Actions: organization `CronkCorp`, repository `Cronker`, workflow `release.yml`, no environment, allowed to run `npm stage publish` and not `npm publish`. npm drops a new trusted publisher whose first publish doesn't succeed within 2 days, so add it just before a release. Its fields can't be changed later; delete it and add another;
- sets **Publishing access** to *Require two-factor authentication and disallow tokens*.

The Release workflow only stages each version; a maintainer with 2FA approves it.

## Checklist

1. **Main is green.** CI passed on the commit you'll tag, and no Ticket you want in the release is still open.
2. **Bump the version** on a branch: set `version` in `package.json` (and `package-lock.json`) with `npm version 0.2.0 --no-git-tag-version`, and the same in `daemon/package.json` (run the same `npm version` in `daemon/`), since the `cronk-runner` daemon is released with Cronk; commit as `chore: release v0.2.0`, open a PR and merge it. If the daemon protocol changed in a way an older daemon gets wrong, also raise `minDaemonVersion` in `server/machines/machines.ts` to the new version, so Cronk refuses older daemons with `daemon_too_old`, and say under the notes' **Upgrade notes** that every Machine must upgrade `cronk-runner`.
3. **Tag the merge commit and publish the release:**

   ```sh
   git switch main && git pull
   gh release create v0.2.0 --target main --title v0.2.0 --generate-notes
   ```

   `--generate-notes` lists the pull requests merged since the previous tag, by their titles, so keep PR titles in the `feat:` / `fix:` / `docs:` form and written for people running Cronk.
   Publishing the release runs `.github/workflows/release.yml`, which stages the `cronk-runner` daemon on npm at the same version (a prerelease under the `next` dist-tag), and fails if `daemon/package.json` doesn't match the tag. Check its run on the Actions tab.
4. **Approve `cronk-runner` on npm.** Nobody can install the staged version until a maintainer approves it, under **Staged Packages** on npmjs.com or, with npm 11.15 or later and signed in:

   ```sh
   npm stage list cronk-runner
   npm stage approve <stage-id>
   ```

   Both ways of approving ask for 2FA. npm may take a few minutes to serve the version; check with `npm view cronk-runner version`. To redo a staged version, `npm stage reject <stage-id>` it first.
5. **Edit the notes** on GitHub: put anything an installation must do by hand under an **Upgrade notes** heading at the top (new environment variables, GitHub App permissions or events to add, anything else the migrations can't do), and say "Nothing to do by hand" when there is none.
6. **Upgrade your own installation** with `docs/setup.md`'s **Upgrading**, so every release has been through that path once before anyone else follows it.
