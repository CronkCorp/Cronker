# Issue tracker: Cronk

Cronker tracks its own work in Cronk: the **CRONK** Project on the maintainer's Cronker installation, reached through its MCP server (the `cronk` connector, tools `mcp__cronk__*`). Code and pull requests stay on GitHub (`CronkCorp/Cronker`); its old issues are history and get no new ones.

Use `CONTEXT.md`'s words: a Ticket, not an issue.

## Conventions

You act as an Agent. Outside a Run, Cronk lets Agents:

- **Read**: `list_tickets` (with `project: "CRONK"`), `read_ticket`, `search`, `list_documents`, `read_document`.
- **File a Ticket**: `file_ticket` with `project: "CRONK"`. It becomes a Discovered Ticket: in Backlog, undelegated, assigned to your Owner and waiting in their Inbox. Until a User delegates, moves or dismisses it you may edit it with `edit_ticket`.
- **Blocking**: `add_block` from a Discovered Ticket you filed to the Ticket it blocks. Cronk refuses cycles.
- **Sub-Tickets**: `create_sub_ticket` under a Discovered Ticket you filed, while it waits. Each Sub-Ticket is a Discovered Ticket of yours too, which you may edit and add blocks from, but only the parent waits in the Inbox; when a User delegates, moves or dismisses the parent, its Sub-Tickets go with it.
- **Comment**: `comment` on any Ticket.
- **Write a spec or other long text**: `create_document` in CRONK, `edit_document` to change it.

What Agents can't do outside a Run: link Documents to Tickets, change Status, Priority or Labels, or delegate. So name the spec's Document (its title and address) at the top of each Ticket's description instead of linking it, and leave triage to the User.

## When a skill says "publish to the issue tracker"

- A spec, PRD or plan: a Document in CRONK's page tree, under a top-level **Specs** Document (create it the first time).
- A ticket: `file_ticket` in CRONK.
- A ticket set (a plan split into slices): `file_ticket` for the parent, then `create_sub_ticket` under it for each slice, and `add_block` between slices that must land in order.

## When a skill says "fetch the relevant ticket"

`read_ticket` with its key, such as `CRONK-12`, which includes its Comments.

## Sub-issues and parents

A skill that asks for a parent and children files a ticket set: the parent with `file_ticket`, each child with `create_sub_ticket` under it. Name the spec Document at the top of the parent's description. The User triages the set as one: delegating the parent delegates its Sub-Tickets, and the parent gets no Runs until they are finished.

## Pull requests as a triage surface

**PRs as a request surface: no.**
