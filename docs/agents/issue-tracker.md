# Issue tracker: Cronk

Cronker tracks its own work in Cronk: the **CRONK** Project on the maintainer's Cronker installation, reached through its MCP server (the `cronk` connector, tools `mcp__cronk__*`). Code and pull requests stay on GitHub (`CronkCorp/Cronker`); its old issues are history and get no new ones.

Use `CONTEXT.md`'s words: a Ticket, not an issue.

## Conventions

You act as an Agent. Outside a Run, Cronk lets Agents:

- **Read**: `list_tickets` (with `project: "CRONK"`), `read_ticket`, `search`, `list_documents`, `read_document`.
- **File a Ticket**: `file_ticket` with `project: "CRONK"`. It becomes a Discovered Ticket: in Backlog, undelegated, assigned to your Owner and waiting in their Inbox. Until a User delegates, moves or dismisses it you may edit it with `edit_ticket`.
- **Blocking**: `add_block` from a Discovered Ticket you filed to the Ticket it blocks. Cronk refuses cycles.
- **Link the spec**: `link_document` from a Discovered Ticket you filed to its spec Document (and `link_artifact` for a prototype Artifact), `unlink_document` and `unlink_artifact` to take one off, until a User takes it up.
- **Comment**: `comment` on any Ticket.
- **Write a spec or other long text**: `create_document` in CRONK, `edit_document` to change it.

What Agents can't do outside a Run: make Sub-Tickets, change any Ticket's Status, edit Tickets other than their own waiting Discovered Tickets, or delegate. So each Ticket you file links its spec Document with `link_document`, and you leave triage to the User.

## When a skill says "publish to the issue tracker"

- A spec, PRD or plan: a Document in CRONK's page tree, under a top-level **Specs** Document (create it the first time).
- A ticket: `file_ticket` in CRONK.

## When a skill says "fetch the relevant ticket"

`read_ticket` with its key, such as `CRONK-12`, which includes its Comments.

## Sub-issues and parents

Cronk has Sub-Tickets, but an Agent can only make them during a Run. A skill that asks for a parent and children files the children as Discovered Tickets, links each to the spec Document with `link_document`, and names the parent (the spec Document, or a parent Ticket's key) at the top of each description, with `Part of …`.

## Pull requests as a triage surface

**PRs as a request surface: no.**
