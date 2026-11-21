# Projects have Access levels, and Agents an Agent Access

ADR 0002 made everyone in a Workspace see and change everything in it, and rejected per-Project member lists because "who can see this" would have many answers instead of one. That rule is replaced: a Workspace shared with a group often holds a Project only some of them should see, or only read, and the workaround (a Workspace per audience) splits knowledge that should layer together. The rest of ADR 0002 stands: one installation still serves several Workspaces, and nothing crosses them.

Each Project is **open** or **private** and may list Users with **Read** or **Write**. A User it doesn't list has Write in an open Project and nothing in a private one, which answers as if it didn't exist. Admins have Write everywhere in their Workspace and are the only ones to change Access. The Workspace's own knowledge stays Write for all its Users. Separately, each Project, and the Workspace for its own knowledge, sets an **Agent Access** (Write, Read or None), and an Agent may do the least of that, its Owner's Access and its token's access, as in the first Cronk's ADR 0004.

## Considered Options

- **Keep one answer per Workspace**: simplest, but a private Project means a second Workspace, losing the Workspace knowledge it layers on.
- **Open or private only, with no Read level**: fewer rules, but no way to show a Project to someone without letting them change it.
- **Workspace-wide roles (Member, Viewer)**: one list, but too coarse to keep one Project apart.

## Consequences

- Every read path filters by the viewer: the board and lists, search, MCP, live updates, the Inbox, export, Mentions, Embeds and the Agent Record. What a viewer can't read answers as if it didn't exist; a Ticket blocked by one still counts it, unnamed.
- Assigning and Delegation need Write. Losing it unassigns and undelegates, stopping Runs, as leaving the Workspace does.
- A hand-connected Transcript is shown only to its Agent's Owner, Admins and Users who can read every Ticket it names, since it holds text from all of them.
- Existing Projects start open, with Agent Access Write, so nothing changes until an Admin restricts one.
