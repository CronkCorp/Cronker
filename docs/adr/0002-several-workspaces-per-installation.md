# One installation serves several Workspaces

The first Cronk served exactly one Workspace per installation (its ADR 0008), to keep tenancy out of the early work. This rewrite lets one installation hold several Workspaces, each its own group of Users who see everything inside it and nothing outside it. A User may belong to several and switches between them. The immediate need is one personal Workspace and one shared with a small group, without running two servers with two sign-ins and two MCP addresses; it also keeps a hosted, paid Cronk possible later.

## Considered Options

- **Two installations**: no tenancy code, but everything set up twice and no single place to work.
- **One Workspace with per-Project member lists**: visibility per Project instead of per Workspace, so "who can see this" has many answers instead of one.

## Consequences

- Every record carries its Workspace from the start; nothing is shared across Workspaces.
- Admin is per Workspace, with no installation-wide role; server commands handle recovery.
