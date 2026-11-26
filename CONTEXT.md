# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents, Terms and Decisions, and where Cronk itself launches agent runs on delegated Tickets.

## Language

### Structure

**Workspace**:
A group of Users sharing Projects and the knowledge that spans them. An installation may hold several; a User sees only the Workspaces they belong to.
_Avoid_: Organization, tenant, team, space

**Workspace slug**:
A Workspace's name in its web addresses, such as `acme` in `/acme/tickets/RP-12`: lower case letters and digits with dashes between words, unique across the installation, made from the Workspace's name or chosen when it is created, and never changed.
_Avoid_: Workspace key, handle, subdomain

**Readable form**:
What a web address, the HTTP API and the MCP tools name a thing by in place of its id: a Workspace slug, a Project's or Ticket's key, a Decision's number or a Term's name within its Project or the Workspace, or the slug of a Document, Artifact or Transcript, the words of its title then its **short id**, the first 8 hex digits of its id. A readable form that could name more than one thing names none.
_Avoid_: Alias, handle, permalink

**Project**:
The main container of work and its knowledge, usually one product or repository, inside one Workspace. Its knowledge layers on top of the Workspace's. An Admin may **archive** a finished or trial Project, recording when and by whom: it stays readable, its key and addresses keep working, but every write in it is refused for everyone, Admins and Agents included, until an Admin **unarchives** it; archiving a single Ticket is something else (Archived Ticket). GitHub moves no work there either: its Pull Requests stay recorded and linked, but their merges, failing checks, requested changes and conflicts move none of its Tickets, nor are they caught up on after it is unarchived. Meanwhile its Tickets leave the Inbox and its work is left out of search unless the search names the Project. An archived Project spends nothing: archiving stops its running Runs, as Cronk's Change on each Ticket, and its delegated Tickets wait, passed by in their Runners' queues, until unarchiving starts them again in queue order.
_Avoid_: Board, space, repo

### Work

**Ticket**:
A unit of work tracked within a Project.
_Avoid_: Issue, task, card, story

**Status**:
Where a Ticket stands in its Project's workflow, shown as a column of the board. Each Project defines its own.
_Avoid_: State, column, stage

**Status kind**:
What a Status means, whatever its name: Backlog, Active, Review, Done or Canceled. Every Project keeps at least one Status of each kind. Agents without a Full token never move a Ticket to a Canceled Status, and to a Done one only under Autonomous Delegation; a Ticket in a Review Status waits in its Assignee's Inbox.
_Avoid_: Status category, status type, phase

**Priority**:
How urgent a Ticket is: Urgent, High, Medium, Low or None. Waiting Tickets get Runs highest Priority first.
_Avoid_: Severity, importance, rank

**Sub-Ticket**:
A Ticket that splits up part of a parent Ticket's work, in the same Project, inheriting its Delegation. A parent gets no Runs while a Sub-Ticket is unfinished. An Agent makes Sub-Tickets of its Run's Ticket, and of a Discovered Ticket it filed that still waits for a User; while it has a running Run in a Project it may also set or clear the parent of any Ticket there, which keeps its own Delegation.
_Avoid_: Subtask, child issue

**Relation**:
A link between two Tickets: one **blocks** the other, or they **relate to** each other. Blocking never forms a cycle; a blocked Ticket gets no Runs.
_Avoid_: Dependency, link

**Discovered Ticket**:
A Ticket an agent files outside its own Ticket's Sub-Tickets. It starts in Backlog, undelegated, assigned to its source Ticket's Assignee (or, filed outside a Run, the Agent's Owner), recording its source Ticket and Run, and waits in their Inbox until a User delegates, moves or dismisses it. Until then the Agent that filed it may edit it, add blocks from it, link Documents and Artifacts to it and unlink them (such as the spec it was filed from), and split it into Sub-Tickets, which are Discovered Tickets too but wait with it rather than in the Inbox: settling it settles them, and delegating it hands them the Delegation.
_Avoid_: Follow-up, spin-off, finding

**Archived Ticket**:
A Ticket in a Done or Canceled Status that a User, or an Agent with a Full token as its Owner's act, has **archived** to clear it off the board, the Ticket lists, its Release's counts and search, which find it only when asked to include archived Tickets. It stays readable by its key and address with everything it holds, and keeps its Status, Assignee, Delegation, Relations and Runs; it isn't moved or tagged with a Release until a User **unarchives** it, which returns it as it was. Not the same as archiving its Project, which makes the whole Project read-only.
_Avoid_: Hidden, deleted, closed

**Step**:
The agent work a Status asks for: a brief and the model it wants. A delegated Ticket entering a Status with a Step gets a Run; a Status without one waits for a User. Done and Canceled Statuses never have one, so finished or canceled work gets no Runs. Changing a Project's Statuses and Steps needs Write in it; an Agent gives a Status a Step or changes one only when its Owner is an Admin.
_Avoid_: Stage, phase, pipeline step, job

**Merge Step**:
The Step on a Merge Status, where Tickets wait in the Merge Queue. It skips itself, passing the Ticket on by its default Outcome as with a Label rule, unless the Ticket has Autonomous Delegation and its Project has **agents may merge** on, a setting off by default that only an Admin changes, or a User, or an Agent with a Full token, queued it in the Merge Queue. An Autonomous Delegation Ticket joins the Merge Queue as it enters; its Run starts only when it has no open Pull Request to queue. New Projects' boards have one on a Merge Status between Code review and In Review.
_Avoid_: Merge job, auto-merge

**Merge Queue**:
The Tickets waiting in a Merge Status for Cronk to merge their Pull Requests: one queue per Repository and base branch, in the order they joined, never reordered by hand. Cronk merges each queue's head once it is clean and green, one at a time, as the merge of the User who queued it by pressing **Merge** on it in a Review Status, completing it as Verified, or, for a Ticket Autonomous Delegation or an Agent with a Full token queued, as its Agent's, completing it as Unverified. A Ticket with several open Pull Requests queues each in its own queue and stays in Merge until the last of them merges. **Remove from queue** sends it back to its Project's first Review Status, and a Pull Request merged or closed on GitHub leaves its queue.
_Avoid_: merge train, merge list

**Outcome**:
One of the named ways a Step's Run may end, each moving the Ticket to a set Status, such as *approve → In Review* or *changes → Implement*. A Run moves its Ticket only by choosing an Outcome. An Outcome that sends work back counts as a round; past the Step's round limit it goes to the Step's *needs you* Outcome instead.
_Avoid_: Result, verdict, transition

**Assignee**:
The User accountable for a Ticket. Always a User with Write in its Project, never an Agent; losing Write unassigns them, as leaving the Workspace does.
_Avoid_: Owner (reserved for Agents), responsible

**Delegation**:
A User's handing of a Ticket to one of their own Agents, its **Delegate**. Only a delegated Ticket gets Runs; delegating an unassigned Ticket assigns the delegating User. Each Project sets whether new Tickets start delegated, and may name a default Agent for them, which assigns its Owner; without one, or once it is removed or lacks Write in the Project, the creator's first Agent takes them, assigning the creator. A Delegate needs Write in the Ticket's Project, the less of its Agent Access and its Owner's Access; losing it undelegates the Ticket.
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
A free-form tag on a Ticket, matched ignoring case. A Step may require a Label or be skipped by one; a skipped Step sends the Ticket straight on by its default Outcome. One Label means something to Cronk itself: `local-only` marks work that can't run in a cloud session, so the Ticket isn't delegated to an Agent whose Runner runs in the cloud (`subscription` and `managed_agents` do), and gets a refused Run if it reaches one some other way.
_Avoid_: Tag, category

**Comment**:
A Markdown message an Actor, or Cronk itself, writes on a Ticket, an Artifact or a Document (a Report included), possibly as a reply to another Comment on the same one. A Comment on an Artifact linked to a Ticket also shows on that Ticket's timeline; so does a Comment on one of the Ticket's Reports, while a Comment on any other Document shows only with the Document. A Ticket's read also gives, with each of its Reports and Linked Documents, that Document's unresolved threads, so a review written on its spec or a Report reaches those working the Ticket. Cronk writes one when a failing check or a review requesting changes sends a Ticket back, linking it. A merge conflict sends nothing back and writes none: it only marks the Pull Request. A Comment on a Document may **quote** a passage of its current Version, recorded with that Version's number, which anchors its thread there; Cronk places the thread where the quote first appears in each later Version, and once it no longer appears the thread is **outdated**. A Comment without a quote is on the whole Document, and a reply is on its thread's passage. A thread on a Document is one Comment with its replies; a User **Resolves** it, through its first Comment, once its review is dealt with, which records when and by whom and hides it from the Document's read without deleting it, until asked for or unresolved. Only Users resolve and unresolve threads; Agents read them.
_Avoid_: Note, message, post; (for Resolve) close, archive, dismiss

**Change**:
One recorded edit to a Ticket: which field, its value before and after, the Actor who made it (or Cronk itself, such as when it moves a Ticket on past a skipped Step) and when. A Ticket's Changes make up its timeline.
_Avoid_: Event, activity, history entry, audit log

**Inbox**:
A User's list of everything waiting on them: Questions, *needs you* Outcomes, failed and lost Runs and Runs that couldn't start (with Retry), Unverified completions, Tickets waiting for their review, Discovered Tickets and New knowledge: each Decision, Term, Document or Artifact an Agent created (never a User, and never a new Version), waiting for the Assignee of the Ticket of the Run it was created in, or else the Agent's Owner, until they dismiss it, or, for a Decision, until a User accepts or rejects it. An Admin's also holds the Tickets of Users removed from the Workspace or who lost Write in their Project, until someone assigns them.
_Avoid_: Notifications, review queue, to-do

**Webhook**:
A User's own channel for their Inbox in one Workspace: a name, a URL and the Inbox kinds it gets (by default Questions, *needs you* and Runs gone wrong). New knowledge is a kind of its own, off by default. Cronk sends it one JSON delivery per item in its User's own Inbox, never with the Ticket's description or Comments nor knowledge's text, signed with the webhook's secret as Standard Webhooks lays out. Only its User sees or changes it; Agents never do. Removing the User from the Workspace removes their webhooks there.
_Avoid_: Notification, subscription, hook, integration

**Brief**:
The instructions a Run starts from: Cronk's fixed preamble, then the Step's own text, then the Ticket's key. The agent reads the Ticket itself over MCP.
_Avoid_: Prompt, system prompt, instructions

### Knowledge

**Document**:
A piece of written knowledge kept as Markdown, in the page tree of a Project or the Workspace. Only a User, or an Agent with a Full token, may delete one.
_Avoid_: Page, doc, wiki page, note

**Version**:
One saved state of a Document, Term, Decision or Artifact, recording which Actor saved it. A save based on an outdated Version is refused.
_Avoid_: Revision, snapshot

**Section**:
A heading of a Document, of any level, with everything under it up to the next heading of the same or a higher level, its own subsections included. Agents read and replace a Document one Section at a time, naming it by its heading, or by a path such as `Install/Linux` where two headings read alike.
_Avoid_: Block, part, chunk

**Report**:
A Document a Run writes on its Ticket, such as an investigation's findings, listed with the Ticket instead of in a page tree. Later Runs on the Ticket read it.
_Avoid_: Summary, write-up, result

**Linked Document**:
A Document of the Ticket's Project or of the Workspace, linked from the Ticket's side so it is one click away.
_Avoid_: Relation (reserved for Ticket to Ticket), reference

**Mention**:
Text that names a Ticket's key (`WEB-4`), a Decision's key (`WEB-D7`, or `D7` for the Workspace's) or a Term's name, written with its capitalisation as a whole word, outside code and links. The text links to it, and the Ticket, Decision or Term lists what mentions it. A Mention of something the reader can't read stays plain text.
_Avoid_: Reference, backlink, tag

**Embed**:
An Artifact's address alone in its paragraph of Markdown, which shows the Artifact in place, isolated as on its own page: the Version the address names, else the latest.
_Avoid_: Inline Artifact, preview

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
A live, viewable page an Actor builds, such as an HTML prototype, with the files it refers to, kept with Versions in a Project or the Workspace and shown in isolation from Cronk itself. One made during a Run is linked to its Ticket, which may link others as it links Documents. Only a User, or an Agent with a Full token, may delete one, or one of its Versions.
_Avoid_: Prototype (as the general term), preview, app

**Transcript**:
The verbatim record of an agent's conversation that led it to change things in Cronk, linked to the Run or Agent it came from.
_Avoid_: Chat log, conversation, session log

**Redaction**:
A string a User removed from a Transcript because the secret scrubbing missed it: every appearance becomes `[redacted]`, in what Cronk holds and in every later upload or fetch of the session. Cronk keeps the string only to apply it again and never shows it; a Redaction can't be removed, and only a User, or an Agent with a Full token, adds one.
_Avoid_: Scrub (for what a User does), mask, censor

### Code

**Repository**:
A GitHub repository that one or more Projects list as holding their code, reached through the installation's GitHub App.
_Avoid_: Repo (in the product), codebase

**Pull Request**:
A proposed change to a Repository's code, linked to the Tickets whose keys its branch or title contains, and to those a User linked it to by hand, which only a User can unlink; either way it must be of a Repository the Ticket's Project lists, and links the same. A merge by a User of the Ticket's Workspace completes the Ticket as Verified, unless a Run is running on the Ticket: then it counts as that Run's Agent's. Any other merge, by an agent, an outsider or GitHub's automation, completes it as Unverified. A Project can turn this **Pull Request automation** off, so merges complete nothing.
_Avoid_: PR (in the product), merge request, change

**Release**:
A Project's named set of Tickets that ship together, such as `v0.3.0`: its name is a semantic version, unique in the Project ignoring case. It goes from *planned* to *cut* to *released*; only a planned Release is renamed, deleted, or has Tickets tagged with it or untagged from it, and deleting one untags its Tickets. A Ticket has at most one Release, of its own Project. "Version" already means a Document's or Artifact's Version.
_Avoid_: Milestone, version, cycle, sprint

**Release branch**:
`release/<name>` in each of a Release's Project's Repositories, such as `release/v0.3.0`.
_Avoid_: Maintenance branch, stable branch

**Cut**:
Cronk creating a Release's release branches from each Repository's default branch, at a User's word.
_Avoid_: Branch off, freeze

**Backport**:
The second Pull Request, which carries a Ticket's merged change onto its Release's release branch.
_Avoid_: Cherry-pick (for the Pull Request), port

### Actors

**User**:
A human who signs in to Cronk, with GitHub or with an email and password. A User exists only once added to a Workspace, and may belong to several.
_Avoid_: Person, account, member (as the general term)

**Display name**:
The name a User chose to be shown by, in place of their email or GitHub login, wherever Cronk names them. It is only shown: a User still signs in with their email or GitHub account, is added to a Workspace by them, and names Cronk wrote into a Change keep the name they had.
_Avoid_: Nickname, username, handle

**Admin**:
A User who manages one Workspace: who belongs to it and its settings. Whoever creates a Workspace is its first Admin; there is no role above the Workspaces.
_Avoid_: Owner, superuser

**Access**:
What a User may do in a Project: **Write**, **Read**, or nothing. A Project is **open** or **private**, and may list Users with Read or Write; a User it doesn't list has Write in an open Project and nothing in a private one, which answers as if it didn't exist. An Admin has Write in every Project of their Workspace, and only Admins change a Project's Access. In an archived Project everyone who can read it has only Read. The Workspace's own knowledge is Write for all its Users. What a User can't read answers as if it didn't exist, except that a Ticket blocked by one still counts it.
_Avoid_: Permission, role, membership

**Agent Access**:
The most a Project, or the Workspace for its own knowledge, lets Agents do in it: Write (the default), Read or None. An Agent may do the least of its Agent Access, its Owner's Access and its Token access (Full counting as Write), within what its Token access lets Agents do.
_Avoid_: Agent permissions, agent scope

**Token access**:
What one of an Agent's tokens allows: **Read** (only reads), **Write** (the Agent rules: a Run does its Ticket and nothing else) or **Full** (what its Owner may do in the web client, within the same Access, except the human-only acts: Accept and Reopen, Access and Admin settings, a Decision's status and resolving threads). Every token Cronk makes, for a Run, a Runner setup or an OAuth connection, is Write unless the Owner picks Full by hand; a Run never holds a Full token. A Full token's acts are Changes by its Agent with no Run.
_Avoid_: Scope, role, permission

**Agent**:
A non-human account that acts in Cronk on behalf of exactly one User, its Owner. Runs act as an Agent, and so does an agent the Owner connects by hand, such as Claude Code on their laptop. What it may do depends on the Token access of the token it connects with.
_Avoid_: Bot, AI user, integration

**Owner**:
The User an Agent acts for, who sets up its Runners and whose credentials its Runs spend.
_Avoid_: Operator, sponsor

**Agent Record**:
Everything an Agent did across the Workspace, newest first: its Runs, the Changes it made, its Comments, the Versions it saved and its hand-connected Transcripts. Anyone in the Workspace sees what of it they can read, and it stays after the Agent is removed.
_Avoid_: Activity log, audit trail, history

**Actor**:
Either a User or an Agent; whoever performed an action.
_Avoid_: Principal, author

### Runs

**Runner**:
A way for Cronk to start Runs, set up by a User with their own credentials: their Claude subscription (`subscription`), the Claude API (Managed Agents, `managed_agents`), their own Machines (`local`), or later a sandbox provider. Each has its own limit on Runs at once; Tickets beyond it wait, highest Priority first. A `local` Runner isn't a cloud Runner: its Runs run on a Machine serving it, which claims them (ADR 0014). While no Machine serving it is connected it is **offline**: its Tickets wait, as for a rate limit, and start once one connects.
_Avoid_: Provider, backend, executor

**Machine**:
A computer of a User's paired with a Cronk installation, running the `cronk-runner` daemon, which serves some of that User's `local` Runners. The User pairs it by approving the code `cronk-runner login` shows on the Runners page; it then holds a Machine token, which unpairing revokes. A Machine serves only its own User's Runners. Its daemon announces its version, its own limit on Runs at once, across all its Runners, its Machine models and whether it runs Claude, whenever it calls; Cronk refuses a daemon older than it works with (`daemon_too_old`).
_Avoid_: Host, device, worker, node

**Machine model**:
A model a Machine offers the `local` Runners it serves, wherever it is served: on the Machine, on its User's network or by a hosted API, but never Claude. Its Machine keeps its address and key; Cronk knows it by name, and Machines offering the same name offer the same Machine model. A Runner's Owner maps model labels to Machine models on it: a Run of a Step wanting a mapped label is claimed only by a Machine offering that Machine model, and never falls back to Claude (ADR 0015). While none offers it, the label's Tickets wait; once no Machine serving the Runner has it set up, their Runs are refused. A Run on one records it, shown after its label, such as `haiku (qwen)`. A label not mapped stands for its model id in the Workspace.
_Avoid_: Local model, custom model, provider

**Runner setup**:
A one-time, short-lived handoff in which a User's own Claude Code creates a Project's claude.ai routines for their subscription Runner, one per model label its board uses, and reports their trigger ids back to Cronk. Each becomes the Project's trigger for its label, waiting for the token the User pastes. Cronk never holds a claude.ai credential.
_Avoid_: Install, bootstrap

**Run**:
One agent execution Cronk starts for one Ticket, acting as an Agent through one of its Owner's Runners. It is **running** until the agent reports it **finished**, or it becomes **failed** (the Runner says it ended without finishing, or its subscription session ended its turn without `finish` and called nothing for 5 minutes after), **lost** (no call naming it or its Ticket for the Workspace's lost-Run threshold; a later such call by its Agent brings it back while its Ticket hasn't moved on) or **stopped** (a User moved, undelegated or re-delegated its Ticket, or an Admin removed its Agent's Owner from the Workspace, after which Cronk refuses its calls); a Run its Runner wouldn't start is **refused**, and its Ticket *couldn't start*. A rate-limited Runner refuses nothing: the Ticket waits. A Ticket has at most one running Run. After a failed, lost or refused Run, only a User's **Retry** starts the same Step again, except that pasting the token into a trigger waiting for it starts the Tickets whose Runs couldn't start for want of it.
_Avoid_: Session, job, claim, task
