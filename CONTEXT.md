# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents, Terms and Decisions, and where Cronk itself launches agent runs on delegated Tickets.

## Language

### Structure

**Workspace**:
A group of Users sharing Projects and the knowledge that spans them. An installation may hold several; a User sees only the Workspaces they belong to.
_Avoid_: Organization, tenant, team, space

**Project**:
The main container of work and its knowledge, usually one product or repository, inside one Workspace. Its knowledge layers on top of the Workspace's.
_Avoid_: Board, space, repo

### Work

**Ticket**:
A unit of work tracked within a Project.
_Avoid_: Issue, task, card, story

**Status**:
Where a Ticket stands in its Project's workflow, shown as a column of the board. Each Project defines its own.
_Avoid_: State, column, stage

**Status kind**:
What a Status means, whatever its name: Backlog, Active, Review, Done or Canceled. Every Project keeps at least one Status of each kind. Agents never move a Ticket to a Canceled Status, and to a Done one only under Autonomous Delegation; a Ticket in a Review Status waits in its Assignee's Inbox.
_Avoid_: Status category, status type, phase

**Priority**:
How urgent a Ticket is: Urgent, High, Medium, Low or None. Waiting Tickets get Runs highest Priority first.
_Avoid_: Severity, importance, rank

**Sub-Ticket**:
A Ticket that splits up part of a parent Ticket's work, in the same Project, inheriting its Delegation. A parent gets no Runs while a Sub-Ticket is unfinished.
_Avoid_: Subtask, child issue

**Relation**:
A link between two Tickets: one **blocks** the other, or they **relate to** each other. Blocking never forms a cycle; a blocked Ticket gets no Runs.
_Avoid_: Dependency, link

**Discovered Ticket**:
A Ticket an agent files outside its own Ticket's Sub-Tickets. It starts in Backlog, undelegated, assigned to its source Ticket's Assignee (or, filed outside a Run, the Agent's Owner), recording its source Ticket and Run, and waits in their Inbox until a User delegates, moves or dismisses it. Until then the Agent that filed it may edit it and add blocks from it.
_Avoid_: Follow-up, spin-off, finding

**Step**:
The agent work a Status asks for: a brief and the model it wants. A delegated Ticket entering a Status with a Step gets a Run; a Status without one waits for a User. Done and Canceled Statuses never have one, so finished or canceled work gets no Runs.
_Avoid_: Stage, phase, pipeline step, job

**Outcome**:
One of the named ways a Step's Run may end, each moving the Ticket to a set Status, such as *approve → In Review* or *changes → Implement*. A Run moves its Ticket only by choosing an Outcome. An Outcome that sends work back counts as a round; past the Step's round limit it goes to the Step's *needs you* Outcome instead.
_Avoid_: Result, verdict, transition

**Assignee**:
The User accountable for a Ticket. Always a User, never an Agent.
_Avoid_: Owner (reserved for Agents), responsible

**Delegation**:
A User's handing of a Ticket to one of their own Agents, its **Delegate**. Only a delegated Ticket gets Runs; delegating an unassigned Ticket assigns the delegating User. Each Project sets whether new Tickets start delegated.
_Avoid_: Agent assignment, hand-off, dispatch

**Autonomous Delegation**:
A Delegation in which a Step may complete the Ticket itself instead of stopping for a User. Set per Ticket, defaulting from the Project and inherited by Sub-Tickets.
_Avoid_: Auto mode, unattended mode, YOLO mode

**Verification**:
A User's after-the-fact judgement on a Ticket an agent or a merge completed: **Unverified** until a User **Accepts** it (Verified) or **Reopens** it with a Comment saying why, sending it back to the Status of the Step that completed it (for a merge, the Step whose Run opened the Pull Request), or, when no Step produced the work, leaving it where it is. An Unverified Ticket counts as finished for what it blocks.
_Avoid_: Approval, sign-off, QA

**Question**:
What a Run asks a User when it ends with its *needs you* Outcome. Answering it with a Comment reply moves the Ticket back to the Status of the Step that asked, so a new Run picks the answer up. Runs never wait for an answer. Past a Step's round limit Cronk applies *needs you* itself, with its own Question, whether or not a Run ended there; it waits with the Ticket in the Assignee's Inbox until a User moves it.
_Avoid_: Prompt, clarification, blocker

**Label**:
A free-form tag on a Ticket, matched ignoring case. A Step may require a Label or be skipped by one; a skipped Step sends the Ticket straight on by its default Outcome.
_Avoid_: Tag, category

**Comment**:
A Markdown message an Actor writes on a Ticket, possibly as a reply to another Comment on the same Ticket. Cronk itself writes one when a failing check or a review requesting changes sends a Ticket back, linking it.
_Avoid_: Note, message, post

**Change**:
One recorded edit to a Ticket: which field, its value before and after, the Actor who made it (or Cronk itself, such as when it moves a Ticket on past a skipped Step) and when. A Ticket's Changes make up its timeline.
_Avoid_: Event, activity, history entry, audit log

**Inbox**:
A User's list of everything waiting on them: Questions, *needs you* Outcomes, failed and lost Runs and Runs that couldn't start (with Retry), Unverified completions, Tickets waiting for their review and Discovered Tickets. An Admin's also holds the Tickets of Users removed from the Workspace, until someone assigns them.
_Avoid_: Notifications, review queue, to-do

**Brief**:
The instructions a Run starts from: Cronk's fixed preamble, then the Step's own text, then the Ticket's key. The agent reads the Ticket itself over MCP.
_Avoid_: Prompt, system prompt, instructions

### Knowledge

**Document**:
A piece of written knowledge kept as Markdown, in the page tree of a Project or the Workspace. Only a User may delete one.
_Avoid_: Page, doc, wiki page, note

**Version**:
One saved state of a Document, Term, Decision or Artifact, recording which Actor saved it. A save based on an outdated Version is refused.
_Avoid_: Revision, snapshot

**Report**:
A Document a Run writes on its Ticket, such as an investigation's findings, listed with the Ticket instead of in a page tree. Later Runs on the Ticket read it.
_Avoid_: Summary, write-up, result

**Linked Document**:
A Document of the Ticket's Project or of the Workspace, linked from the Ticket's side so it is one click away.
_Avoid_: Relation (reserved for Ticket to Ticket), reference

**Attachment**:
A plain file, such as an image or log, attached to a Ticket, Document or Comment and readable by whoever can read that.
_Avoid_: Upload, asset, file

**Term**:
One concept named in a glossary: its name, definition and the words to avoid. A Project Term replaces a Workspace Term of the same name.
_Avoid_: Glossary entry, definition

**Decision**:
A recorded choice with its reasoning and a status: proposed, accepted, rejected, deprecated or superseded. Agents may propose one; only a User changes its status. Never deleted.
_Avoid_: ADR (in the product), RFC

**Artifact**:
A live, viewable thing an Actor builds, such as an HTML prototype, kept with Versions in a Project or the Workspace and shown in isolation from Cronk itself.
_Avoid_: Prototype (as the general term), preview, app

**Transcript**:
The verbatim record of an agent's conversation that led it to change things in Cronk, linked to the Run or Agent it came from.
_Avoid_: Chat log, conversation, session log

### Code

**Repository**:
A GitHub repository that one or more Projects list as holding their code, reached through the installation's GitHub App.
_Avoid_: Repo (in the product), codebase

**Pull Request**:
A proposed change to a Repository's code, linked to the Tickets whose keys its branch or title contains. A merge by a User of the Ticket's Workspace completes the Ticket as Verified; any other merge, by an agent, an outsider or GitHub's automation, completes it as Unverified. A Project can turn this **Pull Request automation** off, so merges complete nothing.
_Avoid_: PR (in the product), merge request, change

### Actors

**User**:
A human who signs in to Cronk, with GitHub or with an email and password. A User exists only once added to a Workspace, and may belong to several.
_Avoid_: Person, account, member (as the general term)

**Admin**:
A User who manages one Workspace: who belongs to it and its settings. Whoever creates a Workspace is its first Admin; there is no role above the Workspaces.
_Avoid_: Owner, superuser

**Agent**:
A non-human account that acts in Cronk on behalf of exactly one User, its Owner. Runs act as an Agent, and so does an agent the Owner connects by hand, such as Claude Code on their laptop.
_Avoid_: Bot, AI user, integration

**Owner**:
The User an Agent acts for, who sets up its Runners and whose credentials its Runs spend.
_Avoid_: Operator, sponsor

**Actor**:
Either a User or an Agent; whoever performed an action.
_Avoid_: Principal, author

### Runs

**Runner**:
A way for Cronk to start Runs, set up by a User with their own credentials: their Claude subscription, the Claude API (Managed Agents), or later a sandbox provider. Each has its own limit on Runs at once; Tickets beyond it wait, highest Priority first.
_Avoid_: Provider, backend, executor

**Run**:
One agent execution Cronk starts for one Ticket, acting as an Agent through one of its Owner's Runners. It is **running** until the agent reports it **finished**, or it becomes **failed** (the Runner says it ended without finishing), **lost** (no call naming it or its Ticket for the Workspace's lost-Run threshold) or **stopped** (a User moved, undelegated or re-delegated its Ticket, or an Admin removed its Agent's Owner from the Workspace, after which Cronk refuses its calls); a Run its Runner wouldn't start is **refused**, and its Ticket *couldn't start*. A rate-limited Runner refuses nothing: the Ticket waits. A Ticket has at most one running Run. After a failed, lost or refused Run, only a User's **Retry** starts the same Step again.
_Avoid_: Session, job, claim, task
