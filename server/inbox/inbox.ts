import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { ticketColumns, TicketSummary, ticketSummary, type TicketRow } from "../work/tickets.js";

/**
 * A User's Inbox in one Workspace: everything waiting on them. It is worked out from
 * current state on every read rather than stored, so an item leaves as soon as the
 * state that put it there changes.
 */

/** A Ticket in a Review Status, waiting for its Assignee's review. */
export const ReviewItem = Type.Object({
  kind: Type.Literal("review"),
  ticket: TicketSummary,
  status: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
});

/** A Ticket whose latest Run failed, was lost or couldn't start, waiting where it is for the Delegate's Owner to Retry. */
export const RunItem = Type.Object({
  kind: Type.Literal("run"),
  ticket: TicketSummary,
  run: Type.Object({
    id: Type.String({ format: "uuid" }),
    state: Type.Union([Type.Literal("failed"), Type.Literal("lost"), Type.Literal("refused")]),
    step: Type.Object({ statusId: Type.String({ format: "uuid" }), name: Type.String() }),
    endReason: Type.Union([Type.String(), Type.Null()]),
  }),
});

export const InboxItem = Type.Union([ReviewItem, RunItem]);
export type InboxItem = Static<typeof InboxItem>;

export const Inbox = Type.Object({
  count: Type.Integer({ description: "How many items are in the Inbox." }),
  items: Type.Array(InboxItem),
});
export type Inbox = Static<typeof Inbox>;

/** The User's Inbox in the Workspace; the caller checks they belong to it. */
export async function inboxOf(db: Db, userId: string, workspaceId: string): Promise<Inbox> {
  const { rows } = await db.query<TicketRow & { statusName: string }>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId", statuses.name as "statusName"
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2 and statuses.kind = 'review'
     order by projects.key, tickets.number`,
    [workspaceId, userId],
  );
  const items: InboxItem[] = rows.map(({ statusName, ...row }) => ({
    kind: "review",
    ticket: ticketSummary(row),
    status: { id: row.statusId, name: statusName },
  }));
  // A Ticket still in the Status of its latest Run, which went wrong, delegated to one of the User's Agents.
  const { rows: wentWrong } = await db.query<TicketRow & { run: Static<typeof RunItem>["run"] }>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId",
       json_build_object('id', runs.id, 'state', runs.state,
         'step', json_build_object('statusId', runs.status_id, 'name', runs.status_name), 'endReason', runs.end_reason) as run
     from tickets join projects on projects.id = tickets.project_id
     join agents on agents.id = tickets.delegate_id
     join lateral (select * from runs where runs.ticket_id = tickets.id order by runs.seq desc limit 1) runs on true
     where tickets.workspace_id = $1 and agents.owner_id = $2
       and runs.state in ('failed', 'lost', 'refused') and runs.status_id = tickets.status_id
     order by projects.key, tickets.number`,
    [workspaceId, userId],
  );
  for (const { run, ...row } of wentWrong) items.push({ kind: "run", ticket: ticketSummary(row), run });
  return { count: items.length, items };
}

