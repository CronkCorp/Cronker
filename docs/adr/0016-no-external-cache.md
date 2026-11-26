# Postgres is Cronk's only datastore, with no external cache

Cronk keeps everything in Postgres and adds no cache service such as Redis. Its reads are single indexed queries (the board's `listTickets` joins `statuses` and filters on indexed columns rather than querying once per Ticket), search is Postgres full-text with GIN indexes, and the one kind of data worth caching, what Cronk fetches from GitHub, is already held in memory with an expiry (`server/github/installations.ts`). No read has been measured as slow. A cache service would be one more thing every installation runs, configures, backs up and monitors, and its invalidation would have to follow Access: a stale entry could show a User a Ticket or Document they may no longer read.

## Considered Options

- **Redis as a read cache** for the board, the Inbox or MCP reads: saves little on single indexed queries, at the cost of a second service and invalidation across per-Project Access.
- **Redis for live updates** across several server processes: Cronk runs as one process, and live delivery is in-process (`server/live/live.ts`). If it ever runs several, Postgres `LISTEN`/`NOTIFY` carries the small events (record ids) without a new service.
- **An in-process cache with a lifetime**, as for GitHub's answers: kept as the tool for data from outside Cronk, and for a Postgres read only once a measurement shows it slow.

## Consequences

- An installation stays Postgres and Cronk, by Docker Compose or Node (`docs/setup.md`).
- A slow read is measured first (`pg_stat_statements`, or request timings against a large seeded Workspace), then fixed by an index or a better query, and only then by an in-process cache invalidated from the same path that publishes live events.
- Running several server processes needs live delivery across them, by `LISTEN`/`NOTIFY` first. Bringing in Redis or another service takes a new ADR superseding this one.
