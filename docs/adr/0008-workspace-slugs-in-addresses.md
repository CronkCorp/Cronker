# Addresses name things by a Workspace slug and readable keys

Until #241 every page of the web client named what it showed by its id, such as `/tickets/8e8f5d03-…`, which people can't read, remember or type. Addresses now name things the way people do: `/<workspace>/tickets/RP-12`, `/<workspace>/projects/RP/decisions/3`, `/<workspace>/glossary/Ticket`, `/<workspace>/documents/onboarding-3f9a1b2c`. A Project's key is unique only within its Workspace (ADR 0002 lets an installation hold several), so the address starts with a **Workspace slug**: unique across the installation, made from the Workspace's name or chosen when it is created, and never changed.

Documents, Artifacts and Transcripts have only titles, which change and repeat, so their slug is the words of the title followed by a short id, the first 8 hex digits of the id: the short id finds the page and the words are only for reading, so a stale title still works. While another of the same kind shares those 8 digits the slug carries the whole id, and a short id two records share names neither, rather than one picked at random.

The HTTP API and the MCP tools take the same readable forms wherever they take an id, resolved among what the caller sees; a form that could name more than one thing (the same Ticket key in two of a User's Workspaces) names none, and the Workspace's slug in front (`acme/RP-12`) tells them apart. Old id addresses keep working: the web client looks them up and replaces them with the readable address, so links already in Comments, Documents, GitHub and Transcripts need no rewriting.

## Considered Options

- **Resolve keys within the Workspace the User has open**: no slug, but the same address opens different Tickets for different people, or for one User depending on what they last opened, and can't be shared.
- **Project keys unique across the installation**: shortest addresses, but one Workspace's keys would block another's, which ADR 0002's separate Workspaces shouldn't see.

## Consequences

- Nothing in an address changes once made: a Workspace's slug is immutable, a Project's key is set only at creation, and a Ticket never moves to another Project, so no aliases are kept. Changing any of these would need old addresses to redirect.
- A Term's address is its name, and Documents', Artifacts' and Transcripts' carry their titles' words: renaming a Term breaks the old address (a renamed Document's still works by its short id). An open page moves to its new address when what it shows is renamed.
- A Workspace slug can't be one of the web client's own first address words, such as `runners` or `tickets`.
