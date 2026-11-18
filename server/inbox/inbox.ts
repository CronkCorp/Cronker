import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { openQuestionsFor, Question } from "../runs/questions.js";
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

/** A Question a Run asked on a Ticket assigned to the User, until a User answers or dismisses it. */
export const QuestionItem = Type.Object({
  kind: Type.Literal("question"),
  ticket: TicketSummary,
  question: Question,
});

export const InboxItem = Type.Union([QuestionItem, ReviewItem]);
export type InboxItem = Static<typeof InboxItem>;

export const Inbox = Type.Object({
  count: Type.Integer({ description: "How many items are in the Inbox." }),
  items: Type.Array(InboxItem),
});
export type Inbox = Static<typeof Inbox>;

/** The User's Inbox in the Workspace; the caller checks they belong to it. */
export async function inboxOf(db: Db, userId: string, workspaceId: string): Promise<Inbox> {
  const questions = await openQuestionsFor(db, userId, workspaceId);
  const { rows } = await db.query<TicketRow & { statusName: string; inReview: boolean }>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId", statuses.name as "statusName",
       statuses.kind = 'review' as "inReview"
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2
       and (statuses.kind = 'review' or tickets.id = any($3))
     order by projects.key, tickets.number`,
    [workspaceId, userId, questions.map((q) => q.ticketId)],
  );
  const tickets = new Map(rows.map(({ statusName: _s, inReview: _r, ...row }) => [row.id, row]));
  const items: InboxItem[] = [
    ...questions.map(({ ticketId, ...question }): InboxItem => ({
      kind: "question",
      ticket: ticketSummary(tickets.get(ticketId)!),
      question,
    })),
    ...rows
      .filter((row) => row.inReview)
      .map(({ statusName, inReview: _r, ...row }): InboxItem => ({
        kind: "review",
        ticket: ticketSummary(row),
        status: { id: row.statusId, name: statusName },
      })),
  ];
  return { count: items.length, items };
}

