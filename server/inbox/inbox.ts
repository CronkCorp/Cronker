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

const StatusRef = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() });

/** A Ticket a Run completed, Unverified until its Assignee Accepts or Reopens it. */
export const UnverifiedItem = Type.Object({
  kind: Type.Literal("unverified"),
  ticket: TicketSummary,
  status: Type.Object(StatusRef.properties, { description: "The Done Status the Run completed it to." }),
  completedBy: Type.Union([StatusRef, Type.Null()], {
    description: "The Step that completed it, by its Status, where Reopen sends it; null once that Status is removed.",
  }),
});

export const InboxItem = Type.Union([ReviewItem, UnverifiedItem]);
export type InboxItem = Static<typeof InboxItem>;

export const Inbox = Type.Object({
  count: Type.Integer({ description: "How many items are in the Inbox." }),
  items: Type.Array(InboxItem),
});
export type Inbox = Static<typeof Inbox>;

/** The User's Inbox in the Workspace; the caller checks they belong to it. */
export async function inboxOf(db: Db, userId: string, workspaceId: string): Promise<Inbox> {
  const { rows } = await db.query<
    TicketRow & { statusName: string; completedBy: { id: string; name: string } | null }
  >(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId", statuses.name as "statusName",
       case when completed_by.id is null then null
         else json_build_object('id', completed_by.id, 'name', completed_by.name) end as "completedBy"
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     left join statuses completed_by on completed_by.id = tickets.completed_from_status_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2
       and (statuses.kind = 'review' or tickets.verification = 'unverified')
     order by projects.key, tickets.number`,
    [workspaceId, userId],
  );
  const items: InboxItem[] = rows.map(({ statusName, completedBy, ...row }) => {
    const ticket = ticketSummary(row);
    const status = { id: row.statusId, name: statusName };
    return row.verification === "unverified"
      ? { kind: "unverified", ticket, status, completedBy }
      : { kind: "review", ticket, status };
  });
  return { count: items.length, items };
}
