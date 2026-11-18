import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
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
  tickets.assignee_id as "assigneeId", to_char(tickets.due_date, 'YYYY-MM-DD') as "dueDate",
  tickets.estimate::float8 as estimate, tickets.created_by as "createdBy", tickets.created_at as "createdAt"`;

type Row = Omit<TicketSummary, "createdAt"> & { createdAt: Date; workspaceId: string };

const summary = ({ workspaceId: _, createdAt, ...row }: Row): TicketSummary => ({
  ...row,
  createdAt: createdAt.toISOString(),
});

export function ticketNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Ticket.");
}

/** A Ticket, if the User belongs to its Workspace; otherwise nothing, as if it didn't exist. */
async function findRow(db: Db | Tx, userId: string, ticketId: string, { lock = false } = {}) {
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
  const row = await findRow(db, userId, ticketId);
  return row && withMentions(db, row);
}

async function withMentions(db: Db | Tx, row: Row): Promise<Ticket> {
  return { ...summary(row), mentions: await mentionsIn(db, row.workspaceId, row.description) };
}

/** Ticket keys in Markdown that name Tickets of the Workspace, each once, in order of first mention. */
export async function mentionsIn(db: Db | Tx, workspaceId: string, markdown: string): Promise<Mention[]> {
  const written = [...new Set([...markdown.matchAll(/\b[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}\b/g)].map((m) => m[0]))];
  if (written.length === 0) return [];
  const { rows } = await db.query<Mention>(
    `select written.text, projects.key || '-' || tickets.number as key, tickets.id as "ticketId"
     from unnest($2::text[]) with ordinality as written (text, n)
     join projects on projects.workspace_id = $1
       and lower(projects.key) = lower(split_part(written.text, '-', 1))
     join tickets on tickets.project_id = projects.id
       and tickets.number = split_part(written.text, '-', 2)::integer
     order by written.n`,
    [workspaceId, written],
  );
  return rows;
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
    const { rows } = await tx.query<{ id: string }>(
      `with numbered as (
         update projects set next_ticket_number = next_ticket_number + 1 where id = $2
         returning next_ticket_number - 1 as number
       )
       insert into tickets (workspace_id, project_id, number, title, description, status_id, created_by, created_at)
       select $1, $2, number, $3, $4, $5, $6, $7 from numbered
       returning id`,
      [project.workspaceId, project.id, input.title.trim(), input.description ?? "", backlog.id, userId, clock.now()],
    );
    return withMentions(tx, (await findRow(tx, userId, rows[0]!.id))!);
  });
}

export async function listTickets(db: Db, userId: string, projectId: string): Promise<TicketSummary[]> {
  const project = await findProject(db, userId, projectId);
  if (!project) throw projectNotFound();
  const { rows } = await db.query<Row>(
    `select ${columns}, tickets.workspace_id as "workspaceId"
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     where tickets.project_id = $1
     order by statuses.position, tickets.number`,
    [project.id],
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
}

/** Changes whichever of a Ticket's fields are given. */
export async function editTicket(
  db: Db,
  userId: string,
  ticketId: string,
  edit: TicketEdit,
): Promise<Ticket> {
  return transaction(db, async (tx) => {
    const ticket = await findRow(tx, userId, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    const next = { ...ticket };
    if (edit.title !== undefined) next.title = edit.title.trim();
    if (edit.description !== undefined) next.description = edit.description;
    if (edit.priority !== undefined) next.priority = edit.priority;
    if (edit.labels !== undefined) next.labels = distinctLabels(edit.labels);
    if (edit.assigneeId !== undefined) {
      if (edit.assigneeId !== null) await checkMember(tx, ticket.workspaceId, edit.assigneeId);
      next.assigneeId = edit.assigneeId;
    }
    if (edit.dueDate !== undefined) next.dueDate = edit.dueDate;
    if (edit.estimate !== undefined) next.estimate = edit.estimate;

    await tx.query(
      `update tickets set title = $2, description = $3, priority = $4, labels = $5, assignee_id = $6,
       due_date = $7, estimate = $8 where id = $1`,
      [ticket.id, next.title, next.description, next.priority, next.labels, next.assigneeId, next.dueDate, next.estimate],
    );
    return withMentions(tx, next);
  });
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
