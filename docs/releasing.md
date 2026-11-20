# Releasing

How a new version of Cronk is cut. Installations upgrade by following **Upgrading** in `docs/setup.md`.

## Versions

- Semantic versions below 1.0, tagged `v0.<minor>.<patch>` on a commit of `main`, with `package.json`'s `version` set to match.
- **Minor** (`v0.2.0`): new behaviour, such as a milestone's tickets, or anything an installation must act on (a migration that can't run on its own, a new environment variable, a GitHub App permission to accept).
- **Patch** (`v0.2.1`): fixes only, nothing to do by hand.
- Every release is a GitHub Release on that tag. There are no release branches: a fix for an older release is released from `main` as the next patch.

## Checklist

1. **Main is green.** CI passed on the commit you'll tag, and no Ticket you want in the release is still open.
2. **Bump the version** on a branch: set `version` in `package.json` (and `package-lock.json`) with `npm version 0.2.0 --no-git-tag-version`, commit as `chore: release v0.2.0`, open a PR and merge it.
3. **Tag the merge commit and publish the release:**

   ```sh
   git switch main && git pull
   gh release create v0.2.0 --target main --title v0.2.0 --generate-notes
   ```

   `--generate-notes` lists the pull requests merged since the previous tag, by their titles, so keep PR titles in the `feat:` / `fix:` / `docs:` form and written for people running Cronk.
4. **Edit the notes** on GitHub: put anything an installation must do by hand under an **Upgrade notes** heading at the top (new environment variables, GitHub App permissions or events to add, anything else the migrations can't do), and say "Nothing to do by hand" when there is none.
5. **Upgrade your own installation** with `docs/setup.md`'s **Upgrading**, so every release has been through that path once before anyone else follows it.
