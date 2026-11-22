# Cronk merges the head of a Merge Queue; the Merge Step's Run only resolves conflicts

This amends ADR 0005. The Merge Status becomes a **Merge Queue**: one queue per Repository and base branch, in which Cronk itself merges one Pull Request at a time, in the order they joined, with the GitHub App's token and the Repository's default merge method (ADR 0007), under the same rules as `merge_pull_request`. Nobody orders a queue by hand. A User joins a Ticket by pressing **Merge** on it in a Review Status; Cronk then merges on that User's behalf, and the Ticket completes as Verified. The Merge Step's skip rule becomes "skip unless an agent may merge the Ticket, or a User queued it", and a queued Ticket gets no Merge Run for its merge: the Run is only for resolving a conflict, which reverses ADR 0005's "Merge never resolves conflicts itself". The rest of ADR 0005 stands: merging keeps its own Status, so the board shows what waits to merge and a Project can remove or reconfigure it like any column.

Several Merge Runs at once broke each other's merges, and every merge sent each conflicting Ticket back to Implement whether or not anyone meant to merge it soon. One merge at a time per queue means a merge never breaks one under way, and conflicts are only worth resolving for the Ticket about to merge. Merging no longer waits on an agent being available.

The queue is built in slices: this one queues a User's Merge and merges clean, green heads, leaving others waiting. Autonomous Tickets joining on their own, branches that are behind, conflicting heads stepping aside for a resolving Run, failures leaving the queue and Tickets with several Pull Requests come after it.

## Considered Options

- **Keep agents merging in Merge Runs**: no new mechanism, but Runs racing each other, a full Implement and Code review cycle for every conflict, and a merge that waits on an agent.
- **Hand Pull Requests to GitHub's own merge queue**: GitHub orders and merges, but only on Repositories that turn it on, and Cronk would no longer know who merged or when to resolve a conflict.
- **Let Users order the queue, or order it by Priority**: more control, but a second thing to manage on every board; entry order is enough while queues stay short.
