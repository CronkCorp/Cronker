import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { recordChanges, type NewChange } from "./changes.js";
import { findProject, projectNotFound } from "./projects.js";

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
  parentId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Ticket this is a Sub-Ticket of, in the same Project.",
  }),
  dueDate: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  estimate: Type.Union([Type.Number(), Type.Null()]),
  createdBy: Type.String({ format: "uuid" }),
  createdAt: Type.String({ format: "date-time" }),
});
export type TicketSummary = Static<typeof TicketSummary>;

/** A Ticket with the Ticket keys its description mentions. */
export const Ticket = Type.Object({
  ...TicketSummary.properties,
  mentions: Type.Array(Mention),
});
export type Ticket = Static<typeof Ticket>;

const columns = `tickets.id, tickets.project_id as "projectId", projects.key || '-' || tickets.number as key,
  tickets.title, tickets.description, tickets.status_id as "statusId", tickets.priority, tickets.labels,
  tickets.assignee_id as "assigneeId", tickets.parent_id as "parentId", to_char(tickets.due_date, 'YYYY-MM-DD') as "dueDate",
  tickets.estimate::float8 as estimate, tickets.created_by as "createdBy", tickets.created_at as "createdAt"`;

/** A Ticket as stored, with the Workspace it belongs to. */
export type TicketRow = Omit<TicketSummary, "createdAt"> & { createdAt: Date; workspaceId: string };
type Row = TicketRow;

const summary = ({ workspaceId: _, createdAt, ...row }: Row): TicketSummary => ({
  ...row,
  createdAt: createdAt.toISOString(),
});

/** A Ticket as another Ticket's Relations, parent, Sub-Tickets and Changes name it. */
export const TicketRef = Type.Object({
  id: Type.String({ format: "uuid" }),
  projectId: Type.String({ format: "uuid" }),
  key: Type.String(),
  title: Type.String(),
});
export type TicketRef = Static<typeof TicketRef>;

/** Selects a Ticket as a TicketRef, from `tickets` and its `projects` joined as the given aliases. */
export const ticketRefColumn = (tickets: string, projects: string) =>
  `json_build_object('id', ${tickets}.id, 'projectId', ${tickets}.project_id,
     'key', ${projects}.key || '-' || ${tickets}.number, 'title', ${tickets}.title)`;

/** A Ticket of the Workspace as a TicketRef, with its Workspace, if there is one with that id. */
export async function findTicketRef(db: Db | Tx, workspaceId: string, ticketId: string): Promise<TicketRef | undefined> {
  if (!isUuid(ticketId)) return undefined;
  const { rows } = await db.query<{ ref: TicketRef }>(
    `select ${ticketRefColumn("tickets", "projects")} as ref
     from tickets join projects on projects.id = tickets.project_id
     where tickets.id = $1 and tickets.workspace_id = $2`,
    [ticketId, workspaceId],
  );
  return rows[0]?.ref;
}

export function unknownTicket(): ApiError {
  return new ApiError(400, "unknown_ticket", "That Ticket isn't in this Workspace.");
}

export function ticketNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Ticket.");
}

/** A Ticket, if the User belongs to its Workspace; otherwise nothing, as if it didn't exist. */
export async function findTicketRow(
  db: Db | Tx,
  userId: string,
  ticketId: string,
  { lock = false } = {},
): Promise<TicketRow | undefined> {
  if (!isUuid(ticketId)) return undefined;
  const { rows } = await db.query<Row>(
    `select ${columns}, tickets.workspace_id as "workspaceId"
     from tickets join projects on projects.id = tickets.project_id
     join memberships on memberships.workspace_id = tickets.workspace_id and memberships.user_id = $2
     where tickets.id = $1 ${lock ? "for update of tickets" : ""}`,
    [ticketId, userId],
  );
  return rows[0];
}

export async function findTicket(db: Db, userId: string, ticketId: string): Promise<Ticket | undefined> {
  const row = await findTicketRow(db, userId, ticketId);
  return row && withMentions(db, row);
}

async function withMentions(db: Db | Tx, row: Row): Promise<Ticket> {
  return { ...summary(row), mentions: await mentionsIn(db, row.workspaceId, row.description) };
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

export async function createTicket(
  db: Db,
  clock: Clock,
  userId: string,
  projectId: string,
  input: { title: string; description?: string },
): Promise<Ticket> {
  return transaction(db, async (tx) => {
    const project = await findProject(tx, userId, projectId, { lock: true });
    if (!project) throw projectNotFound();
    const backlog = project.statuses.find((s) => s.kind === "backlog")!;
    const now = clock.now();
    const { rows } = await tx.query<{ id: string }>(
      `with numbered as (
         update projects set next_ticket_number = next_ticket_number + 1 where id = $2
         returning next_ticket_number - 1 as number
       )
       insert into tickets (workspace_id, project_id, number, title, description, status_id, created_by, created_at)
       select $1, $2, number, $3, $4, $5, $6, $7 from numbered
       returning id`,
      [project.workspaceId, project.id, input.title.trim(), input.description ?? "", backlog.id, userId, now],
    );
    const ticket = (await findTicketRow(tx, userId, rows[0]!.id))!;
    await recordChanges(tx, ticket, userId, now, [{ field: "created", from: null, to: null }]);
    return withMentions(tx, ticket);
  });
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
  userId: string,
  projectId: string,
  filter: TicketFilter = {},
): Promise<TicketSummary[]> {
  const project = await findProject(db, userId, projectId);
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
    `select ${columns}, tickets.workspace_id as "workspaceId"
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     where ${where.join(" and ")}
     order by statuses.position, tickets.number`,
    params,
  );
  return rows.map(summary);
}

export interface TicketEdit {
  title?: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  assigneeId?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  statusId?: string;
  parentId?: string | null;
}

/** Changes whichever of a Ticket's fields are given, recording a Change for each that differs. */
export async function editTicket(
  db: Db,
  clock: Clock,
  userId: string,
  ticketId: string,
  edit: TicketEdit,
): Promise<Ticket> {
  return transaction(db, async (tx) => {
    const ticket = await findTicketRow(tx, userId, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
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
    const parentRef = (id: string) => findTicketRef(tx, ticket.workspaceId, id);

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
    if (edit.parentId !== undefined) {
      const parent = edit.parentId === null ? null : await checkParent(tx, ticket, edit.parentId);
      await change("parentId", "parent", parent?.id ?? null, (id) => (id === null ? null : parentRef(id)));
    }
    if (edit.dueDate !== undefined) await change("dueDate", "dueDate", edit.dueDate);
    if (edit.estimate !== undefined) await change("estimate", "estimate", edit.estimate);
    if (changes.length === 0) return withMentions(tx, ticket);

    await tx.query(
      `update tickets set title = $2, description = $3, priority = $4, labels = $5, assignee_id = $6,
       due_date = $7, estimate = $8, status_id = $9, parent_id = $10 where id = $1`,
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
      ],
    );
    await recordChanges(tx, ticket, userId, clock.now(), changes);
    return withMentions(tx, next);
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
