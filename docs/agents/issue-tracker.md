# Issue tracker: Cronk

Cronker tracks its own work in Cronk: the **CRONK** Project on the maintainer's Cronker installation, reached through its MCP server (the `cronk` connector, tools `mcp__cronk__*`). Code and pull requests stay on GitHub (`CronkCorp/Cronker`); its old issues are history and get no new ones.

Use `CONTEXT.md`'s words: a Ticket, not an issue.

## Conventions

You act as an Agent. Outside a Run, Cronk lets Agents:

- **Read**: `list_tickets` (with `project: "CRONK"`), `read_ticket`, `search`, `list_documents`, `read_document`, `read_section`.
- **File a Ticket**: `file_ticket` with `project: "CRONK"`. It becomes a Discovered Ticket: in Backlog, undelegated, assigned to your Owner and waiting in their Inbox. Until a User delegates, moves or dismisses it you may edit it with `edit_ticket`.
- **Blocking**: `add_block` between a Discovered Ticket you filed, while it waits, and any other Ticket, either way round: `blocks` for the Ticket it blocks, `blockedBy` for a Ticket it waits on, even one already delegated or running. Cronk refuses cycles.
- **Sub-Tickets**: `create_sub_ticket` under a Discovered Ticket you filed, while it waits. Each Sub-Ticket is a Discovered Ticket of yours too, which you may edit, add blocks from and link Documents and Artifacts to, but only the parent waits in the Inbox; when a User delegates, moves or dismisses the parent, its Sub-Tickets go with it.
- **Link the spec**: `link_document` from a Discovered Ticket you filed to its spec Document (and `link_artifact` for a prototype Artifact), `unlink_document` and `unlink_artifact` to take one off, until a User takes it up.
- **Comment**: `comment` on any Ticket.
- **Projects**: `read_project` reads a Project's board. With Write in it, `add_status`, `edit_status`, `remove_status` and `remove_step` change it; `set_step` also needs your Owner to be an Admin. `create_project` creates a Project with the default board, only when your Owner is an Admin and your token isn't read-only.
- **Write a spec or other long text**: `create_document` in CRONK, `edit_document` to change it, `replace_section` to change one Section of a long one.

What Agents can't do outside a Run: change any Ticket's Status, edit Tickets other than their own waiting Discovered Tickets, or delegate. So each Ticket you file links its spec Document with `link_document`, and you leave triage to the User.

## When a skill says "publish to the issue tracker"

- A spec, PRD or plan: a Document in CRONK's page tree, under a top-level **Specs** Document (create it the first time).
- A ticket: `file_ticket` in CRONK.
- A ticket set (a plan split into slices): `file_ticket` for the parent, then `create_sub_ticket` under it for each slice, and `add_block` between slices that must land in order. A set can also wait on Tickets already under way: `add_block` with `blockedBy` from a slice to the delegated or running Ticket it depends on.

## When a skill says "fetch the relevant ticket"

`read_ticket` with its key, such as `CRONK-12`, which includes its Comments.

## Sub-issues and parents

A skill that asks for a parent and children files a ticket set: the parent with `file_ticket`, each child with `create_sub_ticket` under it. Link the spec Document to the parent and to each Sub-Ticket with `link_document`. The User triages the set as one: delegating the parent delegates its Sub-Tickets, and the parent gets no Runs until they are finished.

To put existing Tickets under a parent, or take them out from under one, use `set_parent` during a Run in their Project. The Tickets keep their own Assignee and Delegation.

## Releases

To see a Project's Releases, use `list_releases`; to plan one, `create_release`, and `rename_release` or `delete_release` while it is planned. Tag Tickets with the `release` field of `file_ticket`, `edit_ticket` and `create_sub_ticket`. Cutting and releasing stay with Users.

## Pull requests as a triage surface

**PRs as a request surface: no.**
