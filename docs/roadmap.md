# Roadmap

Cronker is a fresh, simpler rewrite of Cronk (`CronkCorp/Cronk`), built to dogfood quickly and grow later. Vocabulary follows `CONTEXT.md`; hard-to-reverse decisions are in `docs/adr/`. The old Cronk's code, glossary and ADRs are a reference to copy from, not a constraint: where this file or an ADR here says otherwise, this repo wins.

## Settled

Choices from the initial grilling (2026-11-18) that are not ADRs but should not be reopened without reason.

### Foundation

- **Stack.** TypeScript, Fastify, Postgres, Docker Compose, as in the old Cronk; nothing may assume Docker.
- **Workspaces.** One installation holds several Workspaces (ADR 0002). Everyone in a Workspace sees everything in it; nothing crosses Workspaces. Projects sit inside a Workspace, and Workspace knowledge layers under Project knowledge.
- **Users.** Sign in with GitHub or with an email and password. A User exists only once added to a Workspace; the first User is created at server setup. Any User may create a Workspace and becomes its Admin. An Admin adds people by GitHub login, or by email with a one-time link to set a password. There is no role above Admin; server commands handle recovery.
- **Reachability.** Cronk takes its public HTTPS address from configuration: a tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok) in development, a server in real use. Cloud Runs, Managed Agents webhooks and GitHub webhooks all need to reach it.

### Runs

- **Cronk launches Runs** (ADR 0001) through a narrow Runner seam: start a Run with this Brief, model and Repository; tell me when it ends.
- **Runners are per User**, with that User's credentials, so a Run spends the credentials of its Agent's Owner. Each Runner has its own limit on Runs at once (default 2, set by its User); Tickets beyond it wait, highest Priority first.
- **Subscription Runner** (first): Claude Code on the web scheduled tasks fired by API. The model, Repository and connectors are fixed on each task in claude.ai, so a User creates one task per model (for example triage on Haiku, investigate on Sonnet, implement on Opus) and gives Cronk each task's trigger under the model label its Steps use, optionally overridden per Project. A rate limit pauses the Runner's queue until claude.ai's `Retry-After`. Cronk sends the Brief as the fire text, never a secret. The session reaches Cronk through a claude.ai connector authenticated by OAuth.
- **Managed Agents Runner** (second): model per Run from the Step, Repository token from the GitHub App, Cronk's MCP token from a vault, completion from webhooks.
- **Later Runners**: Agent SDK in a rented sandbox (E2B, Daytona, Modal and the like) or on a User's own machine.
- **Agents.** Each User has one or more Agents with tokens. A Run acts as an Agent; so does Claude Code connected by hand. There are no Agent Sessions or Claims: a running Run holds its Ticket.
- **Run end.** A Run finishes when the agent calls `finish` with an Outcome. A Runner that reports the session ended without it makes the Run failed; a Run with no Cronk calls for a set time (default 30 minutes) is lost. Failed and lost Runs wait in the Inbox with Retry; nothing retries on its own.
- **Brief.** Cronk's fixed preamble (how to reach Cronk, the Run's id, call `finish`), then the Step's Markdown brief (per Project, prefilled from Cronk's defaults), then the Ticket key. The agent reads the Ticket, Comments and Reports over MCP.
- **Cost.** Each Run records what it cost where the Runner reports it.

### The loop

- **The board is the pipeline** (ADR 0003). A default board: `Backlog → Triage [Haiku] → Ready → Investigate [Sonnet] → Implement [Opus] → Code review [Sonnet] → In Review → Done`.
- **Outcomes.** A Step lists named Outcomes, each with a target Status, including a *needs you* Outcome. A Run moves its Ticket only by an Outcome. Outcomes that send work back count as rounds; past the Step's round limit (default 2) they go to *needs you*.
- **Label rules.** A Step may require a Label or be skipped by one; a skipped Step passes the Ticket on by its default Outcome. The default Code review Step is skipped by `no-review`, which the triage Step may add to obvious cases such as docs-only fixes.
- **Delegation.** Only delegated Tickets get Runs. Delegating defaults to the delegating User's own Agent and assigns them if the Ticket has no Assignee. A Project sets whether new Tickets start delegated (off by default).
- **Autonomous Delegation and Verification** as in the old Cronk: set per Ticket, defaulting from the Project, inherited by Sub-Tickets; only then may an Outcome lead to Done, and the completion is Unverified until a User Accepts or Reopens it. Unverified counts as finished for blocking; Reopen sends the Ticket back to the Step that completed it.
- **Status kinds.** Backlog, Active, Review, Done, Canceled; at least one of each per Project. Agents never enter Canceled, and Done only under Autonomous Delegation. Done and Canceled Statuses never have a Step, so no Run starts on finished or canceled work; a Status with a Step can't become either kind until its Step is removed. On the default board, Backlog and Ready are Backlog; Triage, Investigate, Implement and Code review are Active; In Review is Review; Done is Done; and a Canceled Status of kind Canceled sits last.
- **Removing a Status** is refused while it holds Tickets, naming how many; they are moved out first. Removing never moves or deletes a Ticket, and renaming, moving or changing a Status's kind leaves its Tickets in it.
- **Questions** end a Run with *needs you*; answering one moves the Ticket back to the asking Step's Status, starting a new Run. Runs never wait.
- **Agents creating Tickets.** A Run may split its Ticket into Sub-Tickets, which inherit the Delegation; a parent gets no Runs while a Sub-Ticket is unfinished. Any other Ticket an agent files is a Discovered Ticket: Backlog, undelegated, assigned to the source Ticket's Assignee, in their Inbox until they delegate, move or dismiss it.
- **Inbox** per User: Questions, *needs you* Outcomes, failed and lost Runs, Unverified completions, Tickets in a Review Status, Discovered Tickets. No shared Triage view.
- **Leaving a Workspace.** Removing a User stops their Agents' Runs there and unassigns and undelegates their Tickets, which go to the Admins' Inbox.
- **Removing an Agent.** Its Owner's removal undelegates each Ticket delegated to it, recorded as their Change; the Tickets keep their Assignee and Status. Its running Runs stop, as on any undelegation, and no Run ever starts for a removed Agent.

### Tickets

- Key `<PROJECT KEY>-<n>`, title, Markdown description, Status, Priority, Labels, Assignee, Delegate, Autonomous Delegation, parent, blocks and relates-to Relations, Linked Documents, Attachments, due date and estimate. No custom fields for now.
- Comments, and a timeline of Changes and Runs.

### GitHub

- **One GitHub App per installation**, created at setup through GitHub's manifest flow: sign-in, Repository access and webhooks. A Project lists Repositories the App is installed on; several Projects may share one.
- **Pull Requests** link to Tickets by key in branch or title.
- A merge by a User completes the Ticket as Verified. A merge by an agent completes it as Unverified. Agents merge only through Cronk's `merge_pull_request` tool (Cronk merges with the App token, recording the Agent and Run), and only on Autonomous Delegation Tickets; as a safety net, a merge by a User's account while that Ticket has a running Run counts as the agent's.
- Failing checks or requested changes on a Ticket in a Review Status send it back to the Step that produced the Pull Request, with a Comment linking the failure; this counts as a round.
- A Pull Request opening or becoming ready doesn't move Tickets; Outcomes do. A Project can turn Pull Request automation off.

### Knowledge

- **Documents** in a page tree per Project and Workspace, with Versions; a save based on an outdated Version is refused. **Reports** are Documents a Run writes on its Ticket.
- **Terms and Decisions** as typed records per Project and Workspace, Project Terms replacing Workspace Terms of the same name, exported as `GLOSSARY.md` and `docs/adr/`. Agents create and edit Terms and propose Decisions; only Users change a Decision's status. No Protected items or Suggestions.
- **Artifacts** with Versions, isolated by the browser sandbox on Cronk's own hostname (ADR 0004).
- **Transcripts.** Managed Agents Runs: Cronk fetches the session's events itself. Subscription Runs and hand-connected Claude Code: a reference Claude Code hook uploads them, its token held as a cloud environment secret. Every Run keeps its claude.ai session link. Known secret patterns are scrubbed on upload.
- **Search.** Postgres full-text across Tickets, Documents, Reports, Terms and Decisions; Artifacts by title and description; Transcripts ranked below the rest. Agents get it over MCP. No AI service required.

### Interfaces

- One documented HTTP API; the UI and the MCP server are its clients. MCP takes OAuth (claude.ai connectors; the consent screen picks one of the User's Agents) and bearer tokens.
- Live updates over server-sent events for the board, the Inbox and Run states.

## Milestones

1. **The loop.** Sign-in, Workspaces, Projects, Admins, Agents and tokens; Tickets with all kept fields; the board with Status kinds, Steps, Briefs, Outcomes, round limits and Label rules; Delegation, Autonomous Delegation, Verification, Questions, the Inbox, Reports, live updates; the HTTP API and MCP with OAuth; the subscription Runner with Run states and limits. Dogfooding starts here.
2. **Code and knowledge.** The GitHub App and Pull Requests, Documents with Versions, Linked Documents, Attachments, Terms and Decisions with export.
3. **More Runners and the rest.** The Managed Agents Runner with fetched Transcripts, the Transcript hook, Artifacts, search.

## Not now

Custom fields, Guidance, Protected items and Suggestions, full Markdown export and import, User and Workspace webhooks, email, a shared Triage view, other Git hosts.
