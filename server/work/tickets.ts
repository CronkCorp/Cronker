import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { inView, userViewer, type Viewer } from "../identity/viewers.js";
import type { AgentCaller, Caller } from "../identity/callers.js";
import { ownerName } from "../agents/tokens.js";
import { recordChanges, type ChangeActor, type NewChange } from "./changes.js";
import { findProject, projectNotFound } from "./projects.js";
import { startRunIfNeeded, startUnblocked, stopRunningRun } from "../runs/runs.js";
import { RunState } from "../runs/states.js";
import { Waiting, waitingColumn } from "../runs/waiting.js";

/** How urgent a Ticket is. */
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof priorities)[number];
export const Priority = Type.Union([
  Type.Literal("urgent"),
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
  Type.Literal("none"),
]);

/** A Ticket key written in Markdown that names a Ticket of the Workspace. */
export const Mention = Type.Object({
  text: Type.String({ description: "The key as written, such as `cronk-12`." }),
  key: Type.String({ description: "The Ticket's key, such as `CRONK-12`." }),
  ticketId: Type.String({ format: "uuid" }),
});
export type Mention = Static<typeof Mention>;

/** A Ticket as another Ticket's Relations, parent, Sub-Tickets and Changes name it. */
export const TicketRef = Type.Object({
  id: Type.String({ format: "uuid" }),
  projectId: Type.String({ format: "uuid" }),
  key: Type.String(),
  title: Type.String(),
});
export type TicketRef = Static<typeof TicketRef>;

/** Where a Discovered Ticket came from, and whether it still waits for a User. */
export const Discovery = Type.Object({
  agentId: Type.String({ format: "uuid", description: "The Agent that filed it." }),
  sourceTicket: Type.Union([TicketRef, Type.Null()], {
    description: "The Ticket of the Run it was filed in; null for one filed outside a Run.",
  }),
  runId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "The Run it was filed in." }),
  waiting: Type.Boolean({
    description:
      "True until a User delegates, moves or dismisses it: meanwhile it waits in its Assignee's Inbox, and the " +
      "Agent that filed it may edit it and add blocks from it.",
  }),
});
export type Discovery = Static<typeof Discovery>;

export const TicketSummary = Type.Object({
  id: Type.String({ format: "uuid" }),
  projectId: Type.String({ format: "uuid" }),
  key: Type.String(),
  title: Type.String(),
  description: Type.String({ description: "Markdown." }),
  statusId: Type.String({ format: "uuid" }),
  priority: Priority,
  labels: Type.Array(Type.String()),
  assigneeId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  delegateId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Assignee's Agent the Ticket is delegated to; only a delegated Ticket gets Runs.",
  }),
  parentId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Ticket this is a Sub-Ticket of, in the same Project.",
  }),
  discovered: Type.Union([Discovery, Type.Null()], {
    description: "For a Discovered Ticket, one an Agent filed outside its own Ticket's Sub-Tickets: who filed it and from where.",
  }),
  dueDate: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  estimate: Type.Union([Type.Number(), Type.Null()]),
  createdBy: Type.String({
    format: "uuid",
    description: "The User who created the Ticket, or whose Agent filed it; its timeline names the Agent and Run.",
  }),
  createdAt: Type.String({ format: "date-time" }),
  lastRun: Type.Union(
    [
      Type.Object({
        id: Type.String({ format: "uuid" }),
        state: RunState,
      }),
      Type.Null(),
    ],
    { description: "The Ticket's latest Run, for marking the board's card; its Runs list them all." },
  ),
  waiting: Waiting,
});
export type TicketSummary = Static<typeof TicketSummary>;

/** A Ticket with the Ticket keys its description mentions. */
export const Ticket = Type.Object({
  ...TicketSummary.properties,
  mentions: Type.Array(Mention),
});
export type Ticket = Static<typeof Ticket>;

/** Selects a Ticket as a TicketRef, from `tickets` and its `projects` joined as the given aliases. */
export const ticketRefColumn = (tickets: string, projects: string) =>
  `json_build_object('id', ${tickets}.id, 'projectId', ${tickets}.project_id,
     'key', ${projects}.key || '-' || ${tickets}.number, 'title', ${tickets}.title)`;

/** The columns of a Ticket as stored, for queries joining `tickets` to `projects`. */
export const ticketColumns = `tickets.id, tickets.project_id as "projectId", projects.key || '-' || tickets.number as key,
  tickets.title, tickets.description, tickets.status_id as "statusId", tickets.priority, tickets.labels,
  tickets.assignee_id as "assigneeId", tickets.delegate_id as "delegateId", tickets.parent_id as "parentId",
  to_char(tickets.due_date, 'YYYY-MM-DD') as "dueDate",
  tickets.estimate::float8 as estimate, tickets.created_by as "createdBy", tickets.created_at as "createdAt",
  (select json_build_object('id', runs.id, 'state', runs.state) from runs
   where runs.ticket_id = tickets.id order by runs.seq desc limit 1) as "lastRun",
  ${waitingColumn("tickets")} as waiting,
  case when tickets.discovered_by_agent_id is null then null else json_build_object(
    'agentId', tickets.discovered_by_agent_id,
    'sourceTicket', (select ${ticketRefColumn("sources", "source_projects")} from tickets sources
      join projects source_projects on source_projects.id = sources.project_id
      where sources.id = tickets.discovered_from_ticket_id),
    'runId', tickets.discovered_in_run_id,
    'waiting', tickets.discovery_waits) end as discovered`;

/** A Ticket as stored, with the Workspace it belongs to. */
export type TicketRow = Omit<TicketSummary, "createdAt"> & { createdAt: Date; workspaceId: string };
type Row = TicketRow;

export const ticketSummary = ({ workspaceId: _, createdAt, ...row }: Row): TicketSummary => ({
  ...row,
  createdAt: createdAt.toISOString(),
});

/** A Ticket of the Workspace as a TicketRef, if there is one with that id. */
export async function findTicketRef(
  db: Db | Tx,
  workspaceId: string,
  ticketId: string,
): Promise<TicketRef | undefined> {
  if (!isUuid(ticketId)) return undefined;
  return findRef(db, "tickets.id = $2", [workspaceId, ticketId]);
}

/** A Ticket of the Workspace as a TicketRef, if there is one with that key, matched ignoring case. */
export async function findTicketRefByKey(
  db: Db | Tx,
  workspaceId: string,
  key: string,
): Promise<TicketRef | undefined> {
  const [projectKey, number] = key.trim().split("-");
  if (!projectKey || !number || !/^[1-9][0-9]{0,8}$/.test(number)) return undefined;
  return findRef(db, "lower(projects.key) = lower($2) and tickets.number = $3", [
    workspaceId,
    projectKey,
    Number(number),
  ]);
}

async function findRef(db: Db | Tx, where: string, params: unknown[]): Promise<TicketRef | undefined> {
  const { rows } = await db.query<{ ref: TicketRef }>(
    `select ${ticketRefColumn("tickets", "projects")} as ref
     from tickets join projects on projects.id = tickets.project_id
     where tickets.workspace_id = $1 and ${where}`,
    params,
  );
  return rows[0]?.ref;
}

export function unknownTicket(): ApiError {
  return new ApiError(400, "unknown_ticket", "That Ticket isn't in this Workspace.");
}

export function ticketNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Ticket.");
}

/** A Ticket in the Viewer's view; otherwise nothing, as if it didn't exist. */
export async function findTicketRow(
  db: Db | Tx,
  viewer: Viewer,
  ticketId: string,
  { lock = false } = {},
): Promise<TicketRow | undefined> {
  if (!isUuid(ticketId)) return undefined;
  const view = inView(viewer, "tickets.workspace_id", "$2");
  const { rows } = await db.query<Row>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId"
     from tickets join projects on projects.id = tickets.project_id
     where tickets.id = $1 and ${view.sql} ${lock ? "for update of tickets" : ""}`,
    [ticketId, view.value],
  );
  return rows[0];
}

export async function findTicket(db: Db | Tx, viewer: Viewer, ticketId: string): Promise<Ticket | undefined> {
  const row = await findTicketRow(db, viewer, ticketId);
  return row && withMentions(db, row);
}

/** A Ticket of a Workspace in the Viewer's view, by its key, ignoring case. */
export async function findTicketByKey(
  db: Db,
  viewer: Viewer,
  workspaceId: string,
  key: string,
): Promise<Ticket | undefined> {
  const [mention] = isUuid(workspaceId) ? await mentionsIn(db, workspaceId, key) : [];
  return mention && mention.text === key ? findTicket(db, viewer, mention.ticketId) : undefined;
}

async function withMentions(db: Db | Tx, row: Row): Promise<Ticket> {
  return { ...ticketSummary(row), mentions: await mentionsIn(db, row.workspaceId, row.description) };
}

const writtenKey = /\b[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}\b/g;

/** Ticket keys as written in Markdown, each once, in order of first mention. */
const keysWritten = (markdown: string) => [...new Set([...markdown.matchAll(writtenKey)].map((m) => m[0]))];

/** Ticket keys in Markdown that name Tickets of the Workspace, each once, in order of first mention. */
export async function mentionsIn(db: Db | Tx, workspaceId: string, markdown: string): Promise<Mention[]> {
  return (await mentionsInEach(db, workspaceId, [markdown]))[0]!;
}

/** The mentions in each of several Markdown texts, looked up together. */
export async function mentionsInEach(db: Db | Tx, workspaceId: string, texts: string[]): Promise<Mention[][]> {
  const written = texts.map(keysWritten);
  const all = [...new Set(written.flat())];
  if (all.length === 0) return texts.map(() => []);
  const { rows } = await db.query<Mention>(
    `select written.text, projects.key || '-' || tickets.number as key, tickets.id as "ticketId"
     from unnest($2::text[]) as written (text)
     join projects on projects.workspace_id = $1
       and lower(projects.key) = lower(split_part(written.text, '-', 1))
     join tickets on tickets.project_id = projects.id
       and tickets.number = split_part(written.text, '-', 2)::integer`,
    [workspaceId, all],
  );
  const found = new Map(rows.map((mention) => [mention.text, mention]));
  return written.map((keys) => keys.flatMap((text) => found.get(text) ?? []));
}

/** What a new Ticket starts from: its title and description, and for a Sub-Ticket its parent. */
export interface NewTicket {
  title: string;
  description?: string;
  /** Makes it a Sub-Ticket of this Ticket of the same Project, with the parent's Assignee and Delegation. */
  parentId?: string;
  /** For an Agent filing a Discovered Ticket: its running Run, whose Ticket is the source. */
  runId?: string;
}

/**
 * Creates a Ticket in the Project's first Backlog Status. A Sub-Ticket takes its parent's Assignee and Delegation;
 * an Agent creates one only under the Ticket of its own running Run. Any other Ticket an Agent files is a
 * Discovered Ticket: undelegated, assigned to the Assignee of the Ticket of the Run it names (or, naming none, to
 * the Agent's Owner) and waiting in their Inbox. Otherwise a User's new Ticket starts delegated to their first
 * Agent where the Project says so.
 */
export async function createTicket(
  context: Context,
  creator: Caller,
  projectId: string,
  input: NewTicket,
): Promise<Ticket> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const project = await findProject(tx, creator, projectId, { lock: true });
    if (!project) throw projectNotFound();
    if (input.parentId !== undefined && input.runId !== undefined) {
      throw new ApiError(400, "parent_or_run", "Give a parent for a Sub-Ticket or a Run for a Discovered Ticket, not both.");
    }
    if (input.runId !== undefined && creator.kind === "user") {
      throw new ApiError(400, "run_for_agents", "Only an Agent names the Run it files a Ticket from.");
    }
    const backlog = project.statuses.find((s) => s.kind === "backlog")!;
    const now = clock.now();
    const createdBy = creator.kind === "user" ? creator.id : creator.owner.id;
    let actor: ChangeActor = creator.id;
    let assigneeId: string | null = null;
    let delegateId: string | null = null;
    let discovery: { runId: string | null; sourceTicketId: string | null } | null = null;
    let parent: TicketRow | undefined;
    if (input.parentId !== undefined) {
      parent = await findTicketRow(tx, creator, input.parentId);
      if (!parent) throw unknownTicket();
      if (parent.projectId !== project.id) {
        throw new ApiError(400, "parent_in_other_project", "A parent must be a Ticket of the same Project.");
      }
      if (creator.kind === "agent") actor = { kind: "agent", id: creator.id, runId: await runOfAgent(tx, creator, parent) };
      // A Sub-Ticket inherits its parent's Delegation, and so its Assignee, whose Agent the Delegate is.
      assigneeId = parent.assigneeId;
      delegateId = parent.delegateId;
    } else if (creator.kind === "agent") {
      const run = input.runId === undefined ? null : await runningRunOf(tx, creator, input.runId);
      actor = { kind: "agent", id: creator.id, runId: run?.id ?? null };
      assigneeId = run?.assigneeId ?? creator.owner.id;
      discovery = { runId: run?.id ?? null, sourceTicketId: run?.ticketId ?? null };
    } else if (project.newTicketsDelegated) {
      // In a Project whose new Tickets start delegated, the creator's first Agent takes it, assigning them.
      delegateId = await firstAgentOf(tx, creator.id, project.workspaceId);
      if (delegateId) assigneeId = creator.id;
    }
    const { rows } = await tx.query<{ id: string }>(
      `with numbered as (
         update projects set next_ticket_number = next_ticket_number + 1 where id = $2
         returning next_ticket_number - 1 as number
       )
       insert into tickets (workspace_id, project_id, number, title, description, status_id, created_by, created_at,
         assignee_id, delegate_id, status_entered_at, parent_id, discovered_by_agent_id, discovered_from_ticket_id,
         discovered_in_run_id, discovery_waits)
       select $1, $2, number, $3, $4, $5, $6, $7, $8, $9, $7, $10, $11, $12, $13, $14 from numbered
       returning id`,
      [
        project.workspaceId,
        project.id,
        input.title.trim(),
        input.description ?? "",
        backlog.id,
        createdBy,
        now,
        assigneeId,
        delegateId,
        parent?.id ?? null,
        discovery ? creator.id : null,
        discovery?.sourceTicketId ?? null,
        discovery?.runId ?? null,
        discovery !== null,
      ],
    );
    const ticket = (await findTicketRow(tx, creator, rows[0]!.id))!;
    await recordChanges(tx, ticket, actor, now, [{ field: "created", from: null, to: null }]);
    live.publish(tx, ticket.workspaceId, { type: "ticket.created", projectId: ticket.projectId, ticketId: ticket.id });
    if (parent) {
      // The parent's timeline shows the Sub-Ticket it gained.
      const self = (await findTicketRef(tx, ticket.workspaceId, ticket.id))!;
      await recordChanges(tx, parent, actor, now, [{ field: "subTicket", from: null, to: self }]);
      live.publish(tx, parent.workspaceId, { type: "ticket.changed", projectId: parent.projectId, ticketId: parent.id });
    }
    await startRunIfNeeded(context, tx, ticket.id, now);
    return withMentions(tx, ticket);
  });
}

/** The Agent's running Run of that id, with its Ticket and the Ticket's Assignee; refused if it has none. */
async function runningRunOf(
  tx: Tx,
  agent: AgentCaller,
  runId: string,
): Promise<{ id: string; ticketId: string; assigneeId: string | null }> {
  const { rows } = isUuid(runId)
    ? await tx.query<{ id: string; ticketId: string; assigneeId: string | null }>(
        `select runs.id, runs.ticket_id as "ticketId", tickets.assignee_id as "assigneeId"
         from runs join tickets on tickets.id = runs.ticket_id
         where runs.id = $1 and runs.agent_id = $2 and runs.state = 'running'`,
        [runId, agent.id],
      )
    : { rows: [] };
  if (rows[0]) return rows[0];
  throw new ApiError(403, "no_running_run", `${agent.name} has no running Run with that id.`, {
    rule: "An Agent files a Ticket from a Run only while that Run of its own is running.",
    advice: "Name your running Run, as your Brief gives it, or leave the Run out to file the Ticket for your Owner.",
  });
}

/** The User's first Agent still in use in the Workspace, by when it was created, if they have one. */
async function firstAgentOf(tx: Tx, userId: string, workspaceId: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `select id from agents where owner_id = $1 and workspace_id = $2 and removed_at is null
     order by created_at, id limit 1`,
    [userId, workspaceId],
  );
  return rows[0]?.id ?? null;
}

/** Narrows a list of Tickets; every filter given must match. */
export interface TicketFilter {
  statusId?: string;
  /** A User's id, or `none` for Tickets without an Assignee. */
  assigneeId?: string;
  priority?: Priority;
  /** Matched ignoring case. */
  label?: string;
}

export async function listTickets(
  db: Db,
  viewer: Viewer,
  projectId: string,
  filter: TicketFilter = {},
): Promise<TicketSummary[]> {
  const project = await findProject(db, viewer, projectId);
  if (!project) throw projectNotFound();
  const params: unknown[] = [project.id];
  const where = ["tickets.project_id = $1"];
  const match = (condition: (param: string) => string, value: unknown) => {
    params.push(value);
    where.push(condition(`$${params.length}`));
  };
  const { statusId, assigneeId, priority, label } = filter;
  // An id that can't be a record's id matches nothing, like one of another Project.
  const unknownStatus = statusId !== undefined && !isUuid(statusId);
  const unknownAssignee = assigneeId !== undefined && assigneeId !== "none" && !isUuid(assigneeId);
  if (unknownStatus || unknownAssignee) return [];
  if (statusId !== undefined) match((p) => `tickets.status_id = ${p}`, statusId);
  if (assigneeId === "none") where.push("tickets.assignee_id is null");
  else if (assigneeId !== undefined) match((p) => `tickets.assignee_id = ${p}`, assigneeId);
  if (priority !== undefined) match((p) => `tickets.priority = ${p}`, priority);
  if (label !== undefined) {
    match((p) => `exists (select 1 from unnest(tickets.labels) as l where lower(l) = lower(${p}))`, label.trim());
  }
  const { rows } = await db.query<Row>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId"
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     where ${where.join(" and ")}
     order by statuses.position, tickets.number`,
    params,
  );
  return rows.map(ticketSummary);
}

export interface TicketEdit {
  title?: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  assigneeId?: string | null;
  delegateId?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  statusId?: string;
  parentId?: string | null;
}

/** The fields of a Ticket an Agent may edit, during its running Run on it. */
const agentEditable = new Set<keyof TicketEdit>(["description", "priority", "labels", "dueDate", "estimate"]);

/**
 * Changes whichever of a Ticket's fields are given, recording a Change for each that differs. A User may
 * edit any field; an Agent only those it may, and only during its own running Run on the Ticket, which
 * each of its Changes names.
 */
export async function editTicket(
  context: Context,
  editor: Caller,
  ticketId: string,
  edit: TicketEdit,
): Promise<Ticket> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const ticket = await findTicketRow(tx, editor, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    let actor: ChangeActor = editor.id;
    if (editor.kind === "agent") {
      // The Agent that filed a Discovered Ticket edits it, outside any Run, until a User takes it up.
      const filed = filedByAgent(editor, ticket);
      checkAgentFields(editor, edit, filed);
      actor = { kind: "agent", id: editor.id, runId: filed ? null : await runOfAgent(tx, editor, ticket) };
    }
    // Only Users get this far with fields that name a User.
    const userId = editor.id;
    const next = { ...ticket };
    const changes: NewChange[] = [];
    /** Sets a field and records the Change, if the value differs; `shown` gives how the Change shows a value. */
    const change = async <K extends keyof Row & keyof TicketEdit>(
      key: K,
      field: NewChange["field"],
      value: Row[K],
      shown: (value: Row[K]) => unknown = (v) => v,
    ) => {
      if (JSON.stringify(value) === JSON.stringify(ticket[key])) return;
      next[key] = value;
      changes.push({ field, from: await shown(ticket[key]), to: await shown(value) });
    };
    const statusNamed = (id: string) => named(tx, "select id, name from statuses where id = $1", id);
    const userNamed = (id: string | null) => named(tx, "select id, email as name from users where id = $1", id);
    const agentNamed = (id: string | null) => named(tx, "select id, name from agents where id = $1", id);
    const ticketRef = (id: string) => findTicketRef(tx, ticket.workspaceId, id);

    if (edit.title !== undefined) await change("title", "title", edit.title.trim());
    if (edit.description !== undefined) await change("description", "description", edit.description);
    if (edit.statusId !== undefined) {
      await checkStatus(tx, ticket.projectId, edit.statusId);
      await change("statusId", "status", edit.statusId, statusNamed);
    }
    if (edit.priority !== undefined) await change("priority", "priority", edit.priority);
    if (edit.labels !== undefined) await change("labels", "labels", distinctLabels(edit.labels));
    if (edit.assigneeId !== undefined) {
      if (edit.assigneeId !== null) await checkMember(tx, ticket.workspaceId, edit.assigneeId);
      await change("assigneeId", "assignee", edit.assigneeId, userNamed);
    }
    if (edit.delegateId !== undefined && edit.delegateId !== null) {
      const delegate = await checkDelegate(tx, ticket, userId, edit.delegateId, next.assigneeId);
      // Delegating an unassigned Ticket assigns the delegating User.
      if (next.assigneeId === null) await change("assigneeId", "assignee", userId, userNamed);
      await change("delegateId", "delegate", delegate.id, agentNamed);
    } else if (edit.delegateId === null) {
      await change("delegateId", "delegate", null, agentNamed);
    } else if (next.delegateId !== null && next.assigneeId !== ticket.assigneeId) {
      // A new Assignee who doesn't own the Delegate removes it.
      const owner = await ownerOf(tx, next.delegateId);
      if (owner !== next.assigneeId) await change("delegateId", "delegate", null, agentNamed);
    }
    if (edit.parentId !== undefined) {
      const parent = edit.parentId === null ? null : await checkParent(tx, ticket, edit.parentId);
      await change("parentId", "parent", parent?.id ?? null, (id) => (id === null ? null : ticketRef(id)));
    }
    if (edit.dueDate !== undefined) await change("dueDate", "dueDate", edit.dueDate);
    if (edit.estimate !== undefined) await change("estimate", "estimate", edit.estimate);
    if (changes.length === 0) return withMentions(tx, ticket);

    const now = clock.now();
    await tx.query(
      `update tickets set title = $2, description = $3, priority = $4, labels = $5, assignee_id = $6,
       due_date = $7, estimate = $8, status_id = $9, parent_id = $10, delegate_id = $11,
       status_entered_at = case when status_id = $9 then status_entered_at else $12 end where id = $1`,
      [
        ticket.id,
        next.title,
        next.description,
        next.priority,
        next.labels,
        next.assigneeId,
        next.dueDate,
        next.estimate,
        next.statusId,
        next.parentId,
        next.delegateId,
        now,
      ],
    );
    await recordChanges(tx, ticket, actor, now, changes);
    live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    if (next.parentId !== ticket.parentId) {
      // Each parent's timeline shows the Sub-Ticket it gained or lost, as the Sub-Ticket is now.
      const self = (await findTicketRef(tx, ticket.workspaceId, ticket.id))!;
      const subTicketChange = async (parentId: string | null, change: NewChange) => {
        if (parentId === null) return;
        await recordChanges(tx, { id: parentId, workspaceId: ticket.workspaceId }, actor, now, [change]);
        live.publish(tx, ticket.workspaceId, {
          type: "ticket.changed",
          projectId: ticket.projectId,
          ticketId: parentId,
        });
      };
      await subTicketChange(ticket.parentId, { field: "subTicket", from: self, to: null });
      await subTicketChange(next.parentId, { field: "subTicket", from: null, to: self });
    }
    // A User moving, undelegating or re-delegating the Ticket stops its running Run: their action wins.
    // Only Users get here with either change: Agents set neither a Status nor a Delegate.
    const entered = next.statusId !== ticket.statusId;
    const delegateChanged = next.delegateId !== ticket.delegateId;
    if (entered || delegateChanged) {
      const { rows } = await tx.query<{ name: string }>(
        "select coalesce(email, '@' || github_login) as name from users where id = $1",
        [userId],
      );
      const who = rows[0]!.name;
      const moved = changes.find((c) => c.field === "status")?.to as { name: string } | undefined;
      const delegate = changes.find((c) => c.field === "delegate")?.to as { name: string } | null | undefined;
      const reason = moved
        ? `${who} moved ${ticket.key} to ${moved.name}.`
        : delegate
          ? `${who} delegated ${ticket.key} to ${delegate.name}.`
          : `${who} undelegated ${ticket.key}.`;
      await stopRunningRun(context, tx, ticket.id, reason, now);
    }
    // Entering a Status, or being delegated where it is, gets a delegated Ticket a Run if the Status has a Step;
    // leaving it, or losing its Delegate, ends its wait for one.
    // A User moving the Ticket by hand starts its rounds afresh at every Step.
    if (entered) await tx.query("delete from round_counts where ticket_id = $1", [ticket.id]);
    if (entered || delegateChanged) await startRunIfNeeded(context, tx, ticket.id, now);
    // Moving may finish what blocks other Tickets or the last Sub-Ticket of a parent; so may leaving a parent.
    const leftParent = next.parentId !== ticket.parentId && ticket.parentId !== null ? [ticket.parentId] : [];
    if (entered || leftParent.length > 0) await startUnblocked(context, tx, entered ? [ticket.id] : [], leftParent);
    return withMentions(tx, next);
  });
}

/** Whether the Ticket is a Discovered Ticket the Agent filed that still waits for a User. */
export function filedByAgent(agent: AgentCaller, ticket: TicketRow): boolean {
  return ticket.discovered?.waiting === true && ticket.discovered.agentId === agent.id;
}

/** Refuses an Agent's edit of a field only Users edit; the Agent that filed a waiting Discovered Ticket also edits its title. */
function checkAgentFields(agent: AgentCaller, edit: TicketEdit, filed: boolean): void {
  const refused = (Object.keys(edit) as (keyof TicketEdit)[]).filter(
    (field) => edit[field] !== undefined && !agentEditable.has(field) && !(filed && field === "title"),
  );
  if (refused.length === 0) return;
  throw new ApiError(
    403,
    "agent_field_not_allowed",
    `${agent.name} is an Agent, and Agents don't edit a Ticket's ${refused.join(", ")}.`,
    {
      rule:
        "During its running Run, an Agent may edit its Ticket's description, Priority, Labels, due date and estimate, " +
        "and the title too of a Discovered Ticket it filed, until a User takes that up; " +
        "a Ticket's Assignee, Delegation, parent and Status are for Users to change.",
      advice:
        `Edit only the fields you may, or leave a Comment asking ${ownerName(agent)}, ${agent.name}'s Owner, ` +
        "to change the rest; a Run moves its Ticket with `finish`.",
    },
  );
}

/** The Agent's running Run on the Ticket, which locked the Ticket; refused if it has none. */
export async function runOfAgent(tx: Tx, agent: AgentCaller, ticket: TicketRow): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    "select id from runs where ticket_id = $1 and agent_id = $2 and state = 'running'",
    [ticket.id, agent.id],
  );
  if (rows[0]) return rows[0].id;
  throw new ApiError(403, "no_running_run", `${agent.name} has no running Run on ${ticket.key}.`, {
    rule: "An Agent changes a Ticket, and writes Reports on it, only during its own running Run on that Ticket.",
    advice: `Read ${ticket.key} and leave a Comment on it instead; changing it is for its Users, or a Run of its own.`,
  });
}

/** A Status or User, looked up by the query, as `{ id, name }` as it is named now; or null for no id. */
async function named(tx: Tx, query: string, id: string | null): Promise<{ id: string; name: string } | null> {
  if (id === null) return null;
  const { rows } = await tx.query<{ id: string; name: string }>(query, [id]);
  return rows[0] ?? null;
}

/** Labels are matched ignoring case: one of each, kept as first written. */
function distinctLabels(labels: string[]): string[] {
  const seen = new Map<string, string>();
  for (const label of labels) {
    const trimmed = label.trim();
    if (!seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
  }
  return [...seen.values()];
}

/**
 * Checks a User may delegate the Ticket to the Agent: only to one of their own Agents still in use in the
 * Ticket's Workspace, and only a Ticket that is theirs or unassigned, so a Delegate is always the Assignee's.
 */
async function checkDelegate(
  tx: Tx,
  ticket: TicketRow,
  userId: string,
  agentId: string,
  assigneeId: string | null,
): Promise<{ id: string }> {
  const { rows } = await tx.query<{ id: string; name: string; ownerId: string; owner: string }>(
    `select agents.id, agents.name, agents.owner_id as "ownerId", coalesce(owners.email, '@' || owners.github_login) as owner
     from agents join users owners on owners.id = agents.owner_id
     where agents.id = $1 and agents.workspace_id = $2 and agents.removed_at is null`,
    [agentId, ticket.workspaceId],
  );
  const agent = rows[0];
  if (!agent) throw new ApiError(400, "unknown_agent", "That Agent isn't in use in this Workspace.");
  if (agent.ownerId !== userId) {
    throw new ApiError(
      403,
      "not_your_agent",
      `You can delegate only to your own Agents, and ${agent.name} is ${agent.owner}'s.`,
    );
  }
  if (assigneeId !== null && assigneeId !== userId) {
    const assignee = await named(tx, "select id, coalesce(email, '@' || github_login) as name from users where id = $1", assigneeId);
    throw new ApiError(
      409,
      "delegate_not_assignees",
      `${ticket.key} is assigned to ${assignee?.name}: only its Assignee delegates it, to one of their own Agents. ` +
        "Assign it to yourself to delegate it.",
    );
  }
  return agent;
}

async function ownerOf(tx: Tx, agentId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ ownerId: string }>(`select owner_id as "ownerId" from agents where id = $1`, [agentId]);
  return rows[0]?.ownerId;
}

async function checkMember(tx: Tx, workspaceId: string, userId: string): Promise<void> {
  const { rowCount } = isUuid(userId)
    ? await tx.query("select 1 from memberships where workspace_id = $1 and user_id = $2", [workspaceId, userId])
    : { rowCount: 0 };
  if (rowCount === 0) throw new ApiError(400, "assignee_not_member", "An Assignee must be a member of this Workspace.");
}

/** Checks the Status is on the Project's board, and keeps the board from changing until the move commits. */
async function checkStatus(tx: Tx, projectId: string, statusId: string): Promise<void> {
  await tx.query("select 1 from projects where id = $1 for share", [projectId]);
  const { rowCount } = isUuid(statusId)
    ? await tx.query("select 1 from statuses where project_id = $1 and id = $2", [projectId, statusId])
    : { rowCount: 0 };
  if (rowCount === 0) throw new ApiError(400, "unknown_status", "That Status isn't on this Ticket's board.");
}

/**
 * Checks a parent is a Ticket of the same Project that isn't the Ticket itself or one of its Sub-Tickets,
 * however deep. Holds the Workspace's parents still until the transaction ends, so two parents set at once
 * can't close a cycle between them.
 */
async function checkParent(tx: Tx, ticket: TicketRow, parentId: string): Promise<TicketRef> {
  const parent = await findTicketRef(tx, ticket.workspaceId, parentId);
  if (!parent) throw unknownTicket();
  if (parent.projectId !== ticket.projectId) {
    throw new ApiError(400, "parent_in_other_project", "A parent must be a Ticket of the same Project.");
  }
  await tx.query("select pg_advisory_xact_lock(hashtext('parents'), hashtext($1))", [ticket.workspaceId]);
  const { rowCount } = await tx.query(
    `with recursive ancestors (id) as (
       select $1::uuid
       union
       select tickets.parent_id from tickets join ancestors on tickets.id = ancestors.id
       where tickets.parent_id is not null
     )
     select 1 from ancestors where id = $2`,
    [parent.id, ticket.id],
  );
  if (rowCount) throw new ApiError(400, "parent_cycle", "A Ticket can't sit under itself or one of its Sub-Tickets.");
  return parent;
}
