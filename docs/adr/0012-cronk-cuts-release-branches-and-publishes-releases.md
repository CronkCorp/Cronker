# Cronk cuts release branches and publishes Releases

This amends ADR 0007. A Project may have **Releases**. When a User presses **Cut** on one, Cronk creates `release/<name>` from the default branch's head in each of the Project's Repositories. When a User presses **Release**, Cronk tags each release branch's head `<name>` and creates a GitHub Release. Both use the GitHub App's installation token. `contents: write` already covers refs and Releases, so no permission is added.

Cronk still never commits. A Ticket of a cut Release whose default-branch Pull Request merges after the Cut gets its change onto the release branch by **Backport**: a Run of the Merge Step cherry-picks the merge and opens a second Pull Request against the release branch. That Pull Request joins the release branch's Merge Queue, queued by whoever queued the first. The Ticket completes only once both have merged.

Backporting after the merge, rather than opening both Pull Requests at once, means only one change gets reviewed, and the release branch receives exactly what merged into the default branch. Only conflicts cost agent work. Creating refs is a narrower write than committing: Cronk never writes content, only names a commit GitHub already has.

## Considered Options

- **The Implement Run opens both Pull Requests.** This needs no new Run mode. But every Run does double work, Code review reviews two diffs that can drift apart, and a Ticket can complete with only one of them merged.
- **Target the release branch first and merge it forward into the default branch.** Fewer Pull Requests, but the default branch lags, and conflicts in the forward merge belong to no Ticket.
- **Humans cut the branches on GitHub.** Cronk would need no new write, but it would be a manual step, and Cronk wouldn't know the cut commit it needs to decide which merges need a backport.
- **Cronk cherry-picks clean changes itself.** Faster, with no Run, but it means Cronk committing, which ADR 0007 rules out.
