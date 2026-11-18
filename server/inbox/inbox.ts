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

/** A Ticket a Run's *needs you* Outcome moved, handing it back to its Assignee, until it moves again. */
export const NeedsYouItem = Type.Object({
  kind: Type.Literal("needsYou"),
  ticket: TicketSummary,
  status: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }, { description: "Where the Outcome moved it." }),
  outcome: Type.String({ description: "The name of the needs you Outcome the Run finished with." }),
  step: Type.Object(
    {
      statusId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Null once the Status is removed." }),
      name: Type.String({ description: "The Status's name when the Run started." }),
    },
    { description: "The Step whose Run handed the Ticket back, by the Status it sits on." },
  ),
});

export const InboxItem = Type.Union([QuestionItem, NeedsYouItem, ReviewItem]);
export type InboxItem = Static<typeof InboxItem>;

export const Inbox = Type.Object({
  count: Type.Integer({ description: "How many items are in the Inbox." }),
  items: Type.Array(InboxItem),
});
export type Inbox = Static<typeof Inbox>;

/** The User's Inbox in the Workspace; the caller checks they belong to it. */
export async function inboxOf(db: Db, userId: string, workspaceId: string): Promise<Inbox> {
  const questions = await openQuestionsFor(db, userId, workspaceId);
  type Row = TicketRow & {
    statusName: string;
    inReview: boolean;
    handedBack: { outcome: string; step: { statusId: string | null; name: string } } | null;
  };
  const { rows } = await db.query<Row>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId", statuses.name as "statusName",
       statuses.kind = 'review' as "inReview",
       case when runs.id is not null then json_build_object(
         'outcome', runs.outcome, 'step', json_build_object('statusId', runs.status_id, 'name', runs.status_name)
       ) end as "handedBack"
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     left join runs on runs.id = tickets.handed_back_by_run_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2
       and (statuses.kind = 'review' or runs.id is not null or tickets.id = any($3))
     order by projects.key, tickets.number`,
    [workspaceId, userId, questions.map((q) => q.ticketId)],
  );
  const summary = ({ statusName: _s, inReview: _r, handedBack: _h, ...row }: Row) => ticketSummary(row);
  const tickets = new Map(rows.map((row) => [row.id, summary(row)]));
  const items: InboxItem[] = [
    ...questions.map(({ ticketId, ...question }): InboxItem => ({ kind: "question", ticket: tickets.get(ticketId)!, question })),
    ...rows.flatMap((row): InboxItem[] =>
      row.handedBack
        ? [{ kind: "needsYou", ticket: summary(row), status: { id: row.statusId, name: row.statusName }, ...row.handedBack }]
        : [],
    ),
    ...rows.flatMap((row): InboxItem[] =>
      row.inReview ? [{ kind: "review", ticket: summary(row), status: { id: row.statusId, name: row.statusName } }] : [],
    ),
  ];
  return { count: items.length, items };
}

