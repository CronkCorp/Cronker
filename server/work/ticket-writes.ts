import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { userName } from "../identity/user.js";
import { recordChanges, type ChangeActor, type ChangeField, type NewChange } from "./changes.js";
import type { TicketRow } from "./tickets.js";

/**
 * The Ticket write module: the one place a Ticket's fields are written. It compares a patch with the row the caller
 * locked, runs one UPDATE of what differs, keeps the bookkeeping that follows from it in step, records a Change for
 * each field that has a Change kind and publishes `ticket.changed`, all in the caller's transaction. Starting and
 * stopping Runs stays with the callers.
 */

/** New values for some of a Ticket's fields. */
export interface TicketPatch {
  title?: string;
  description?: string;
  statusId?: string;
  priority?: TicketRow["priority"];
  labels?: string[];
  assigneeId?: string | null;
  delegateId?: string | null;
  autonomousDelegation?: boolean | null;
  verification?: TicketRow["verification"];
  parentId?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  // Bookkeeping, with no Change kind: written and published, never recorded.
  /** Whether a Discovered Ticket still waits for a User. */
  discoveryWaits?: boolean;
  /** Whether the Ticket waits for a Run. */
  waitsForRun?: boolean;
  /** The Status a Run completed the Ticket from. */
  completedFromStatusId?: string | null;
  /** Whether a Run completed the Ticket without a Step. */
  completedWithoutStep?: boolean;
  /** The merged Pull Request that completed the Ticket, by GitHub's id. */
  completedByPullRequestId?: number | null;
  /**
   * The User the Ticket remembers as its former Assignee, for the Admins' Inbox. Giving an Assignee forgets it
   * without this; a caller clearing the Assignee for good, as releasing a member does, gives it.
   */
  formerAssigneeId?: string | null;
  /** The Repository, by GitHub's id, whose issue the Ticket was imported from, so `#123` resolves to it. */
  githubRepositoryId?: number | null;
  /** The number of the issue the Ticket was imported from. */
  githubIssueNumber?: number | null;
}

/**
 * The Ticket as its caller locked it: its fields as a TicketRow has them. Bookkeeping fields the caller didn't read
 * are read here, when a patch gives them.
 */
export type LockedTicket = Pick<
  TicketRow,
  | "id"
  | "workspaceId"
  | "projectId"
  | "title"
  | "description"
  | "statusId"
  | "priority"
  | "labels"
  | "assigneeId"
  | "delegateId"
  | "autonomousDelegation"
  | "verification"
  | "parentId"
  | "dueDate"
  | "estimate"
> & {
  discovered?: { waiting: boolean } | null;
  waitsForRun?: boolean;
  completedFromStatusId?: string | null;
  completedWithoutStep?: boolean;
  completedByPullRequestId?: number | null;
  formerAssigneeId?: string | null;
  githubRepositoryId?: number | null;
  githubIssueNumber?: number | null;
};

type Shown = (tx: Tx, workspaceId: string, value: unknown) => Promise<unknown>;

interface Column {
  column: string;
  /** Its Change kind; bookkeeping has none. */
  field?: ChangeField;
  /** How a Change shows a value, as named then. */
  shown?: Shown;
  /** The Postgres type to cast the parameter to, where pg can't tell. */
  cast?: string;
}

const named =
  (query: string): Shown =>
  async (tx, _workspaceId, id) => {
    if (id === null) return null;
    const { rows } = await tx.query<{ id: string; name: string }>(query, [id]);
    return rows[0] ?? null;
  };

const ticketRef: Shown = async (tx, workspaceId, id) => {
  if (id === null) return null;
  const { rows } = await tx.query<{ ref: unknown }>(
    `select json_build_object('id', tickets.id, 'projectId', tickets.project_id,
       'key', projects.key || '-' || tickets.number, 'title', tickets.title) as ref
     from tickets join projects on projects.id = tickets.project_id where tickets.workspace_id = $1 and tickets.id = $2`,
    [workspaceId, id],
  );
  return rows[0]?.ref ?? null;
};

/** Each field a patch may give, in the order its Changes are recorded. */
const columns: { [K in keyof Required<TicketPatch>]: Column } = {
  title: { column: "title", field: "title" },
  description: { column: "description", field: "description" },
  statusId: { column: "status_id", field: "status", shown: named("select id, name from statuses where id = $1") },
  verification: { column: "verification", field: "verification", cast: "verification" },
  priority: { column: "priority", field: "priority" },
  labels: { column: "labels", field: "labels" },
  assigneeId: {
    column: "assignee_id",
    field: "assignee",
    shown: named(`select id, ${userName()} as name from users where id = $1`),
  },
  delegateId: { column: "delegate_id", field: "delegate", shown: named("select id, name from agents where id = $1") },
  parentId: { column: "parent_id", field: "parent", shown: ticketRef },
  autonomousDelegation: { column: "autonomous_delegation", field: "autonomousDelegation" },
  dueDate: { column: "due_date", field: "dueDate" },
  estimate: { column: "estimate", field: "estimate" },
  discoveryWaits: { column: "discovery_waits" },
  waitsForRun: { column: "waits_for_run" },
  completedFromStatusId: { column: "completed_from_status_id" },
  completedWithoutStep: { column: "completed_without_step" },
  completedByPullRequestId: { column: "completed_by_pull_request_id" },
  formerAssigneeId: { column: "former_assignee_id" },
  githubRepositoryId: { column: "github_repository_id" },
  githubIssueNumber: { column: "github_issue_number" },
};

/** Bookkeeping a LockedTicket may lack, read when a patch gives it. */
const bookkeeping = {
  waitsForRun: `waits_for_run as "waitsForRun"`,
  completedFromStatusId: `completed_from_status_id as "completedFromStatusId"`,
  completedWithoutStep: `completed_without_step as "completedWithoutStep"`,
  // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
  completedByPullRequestId: `completed_by_pull_request_id::float8 as "completedByPullRequestId"`,
  formerAssigneeId: `former_assignee_id as "formerAssigneeId"`,
  githubRepositoryId: `github_repository_id::float8 as "githubRepositoryId"`,
  githubIssueNumber: `github_issue_number as "githubIssueNumber"`,
} as const;

/** What a write wrote and recorded. */
export interface TicketWrite {
  /** Whether it wrote anything; false for a patch that changes nothing and no Changes given. */
  written: boolean;
  /** The Changes it recorded, those given first. */
  changes: NewChange[];
}

/**
 * Writes the patch to the Ticket the caller locked in `tx`: only the fields that differ from the locked row, in one
 * UPDATE. It records a Change for each of them that has a Change kind, after any `changes` given for what isn't a
 * Ticket field (such as `dismissed`), and publishes `ticket.changed` once. A Status change sets `status_entered_at`
 * and ends the Ticket's waiting from a needs you Outcome; giving an Assignee forgets the former one, while clearing
 * it keeps whom it remembers; clearing `verification` forgets the Status the Ticket was completed from. A patch that
 * changes nothing, with no `changes`, writes and publishes nothing. A write that is part of making the Ticket, such as
 * an import rewriting `#123` to a key, gives `unrecorded` and records no Change of its own.
 */
export async function writeTicket(
  { live }: Pick<Context, "live">,
  tx: Tx,
  ticket: LockedTicket,
  actor: ChangeActor,
  patch: TicketPatch,
  { at, changes: given = [], unrecorded = false }: { at: Date; changes?: NewChange[]; unrecorded?: boolean },
): Promise<TicketWrite> {
  const current = await currentValues(tx, ticket, patch);
  const differs = (Object.keys(columns) as (keyof TicketPatch)[]).filter(
    (key) => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(current[key]),
  );
  if (differs.length === 0 && given.length === 0) return { written: false, changes: [] };

  const sets: string[] = [];
  const params: unknown[] = [ticket.id];
  const set = (column: string, value: unknown, cast?: string) => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast ? `::${cast}` : ""}`);
  };
  for (const key of differs) set(columns[key].column, patch[key], columns[key].cast);
  const statusChanged = differs.includes("statusId");
  if (statusChanged) set("status_entered_at", at);
  if (differs.includes("assigneeId") && patch.assigneeId !== null && !differs.includes("formerAssigneeId")) {
    set("former_assignee_id", null);
  }
  if (differs.includes("verification") && patch.verification === null && !differs.includes("completedFromStatusId")) {
    set("completed_from_status_id", null);
  }
  if (sets.length > 0) await tx.query(`update tickets set ${sets.join(", ")} where id = $1`, params);
  if (statusChanged) await tx.query("delete from needs_you where ticket_id = $1", [ticket.id]);
  // Leaving the Merge Status its Pull Requests were queued in takes them out of the Merge Queue. Completing it for a
  // merge records the merge instead, so it shows no leaving.
  const left = statusChanged ? await leaveMergeQueue(tx, ticket.id, patch.statusId!) : [];

  const changes = [...given, ...left];
  for (const key of unrecorded ? [] : differs) {
    const { field, shown } = columns[key];
    if (!field) continue;
    const show = (value: unknown) => (shown ? shown(tx, ticket.workspaceId, value) : value);
    changes.push({ field, from: await show(current[key] ?? null), to: await show(patch[key]) });
  }
  await recordChanges(tx, ticket, actor, at, changes);
  live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  return { written: true, changes };
}

/**
 * Takes the Ticket's Pull Requests out of the Merge Queue unless they wait in the Status it now enters, returning a
 * `queueLeft` Change for each, unless that Status is a Done one.
 */
async function leaveMergeQueue(tx: Tx, ticketId: string, statusId: string): Promise<NewChange[]> {
  const { rows } = await tx.query<{ pullRequest: unknown; done: boolean }>(
    `with left_queue as (
       delete from merge_queue where ticket_id = $1 and status_id <> $2 returning pull_request_id
     )
     select json_build_object('id', pull_requests.id, 'repository', pull_requests.repository_full_name,
         'number', pull_requests.number, 'url', pull_requests.url) as "pullRequest",
       (select kind = 'done' from statuses where id = $2) as done
     from left_queue join pull_requests on pull_requests.id = left_queue.pull_request_id
     order by pull_requests.id`,
    [ticketId, statusId],
  );
  return rows.filter((row) => !row.done).map((row) => ({ field: "queueLeft", from: { pullRequest: row.pullRequest }, to: null }));
}

/** The Ticket's current value of each field, from the locked row, reading the bookkeeping it lacks that the patch gives. */
async function currentValues(tx: Tx, ticket: LockedTicket, patch: TicketPatch): Promise<TicketPatch> {
  const values: Record<string, unknown> = { ...ticket, discoveryWaits: ticket.discovered?.waiting ?? false };
  const missing = (Object.keys(bookkeeping) as (keyof typeof bookkeeping)[]).filter(
    (key) => patch[key] !== undefined && ticket[key] === undefined,
  );
  if (missing.length > 0) {
    const { rows } = await tx.query(`select ${missing.map((key) => bookkeeping[key]).join(", ")} from tickets where id = $1`, [
      ticket.id,
    ]);
    Object.assign(values, rows[0]);
  }
  return values as TicketPatch;
}

/**
 * Locks Tickets for writing, by id, in id order so that concurrent writers wait rather than deadlock, with their
 * fields and bookkeeping as `writeTicket` compares them.
 */
export async function lockTickets(tx: Tx, ids: string[]): Promise<Required<LockedTicket>[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.query<Required<LockedTicket> & { discoveryWaits: boolean }>(
    `select id, workspace_id as "workspaceId", project_id as "projectId", title, description, status_id as "statusId",
       priority, labels, assignee_id as "assigneeId", delegate_id as "delegateId",
       autonomous_delegation as "autonomousDelegation", verification, parent_id as "parentId",
       to_char(due_date, 'YYYY-MM-DD') as "dueDate", estimate::float8 as estimate,
       discovery_waits as "discoveryWaits", ${Object.values(bookkeeping).join(", ")}
     from tickets where id = any($1::uuid[]) order by id for update`,
    [ids],
  );
  return rows.map(({ discoveryWaits, ...row }) => ({ ...row, discovered: { waiting: discoveryWaits } }));
}
