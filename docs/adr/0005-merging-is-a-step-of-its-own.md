# Merging is a Step of its own, skipped unless an agent may merge

Agents merge Pull Requests from a Merge Step on its own Status, between Code review and In Review on the default board, rather than from the Code review Step. The Merge Step skips itself, passing the Ticket on to In Review by its default Outcome, unless the Ticket has Autonomous Delegation and its Project has *agents may merge* on (off by default): a built-in skip rule beside the Label rules. Merging has its own failure, a merge conflict, that sends the Ticket back to Implement as a round; a separate Status shows on the board which Tickets are waiting to merge, lets a Project remove or reconfigure merging like any column, and keeps Code review's brief about reviewing.

## Considered Options

- **Code review merges when allowed**: no new Status, but one Step with two jobs and Outcomes that depend on the Ticket's Delegation, and a conflict found at merge time would look like a review result.
- **An optional Merge Status each Project adds itself**: no skip rule, but merging by agents would need setup on every board before it works.
