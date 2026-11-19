import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { User } from "../identity/user.js";
import { openQuestionsFor, Question } from "../runs/questions.js";
import { WentWrongState, wentWrongStates } from "../runs/states.js";
import { ticketColumns, TicketSummary, ticketSummary, type TicketRow } from "../work/tickets.js";

/**
 * A User's Inbox in one Workspace: everything waiting on them. It is worked out from
 * current state on every read rather than stored, so an item leaves as soon as the
 * state that put it there changes.
 */

/** When an item began waiting on the User; `when` says what that is for its kind. */
const Since = (when: string) => Type.String({ format: "date-time", description: `When it began waiting: ${when}.` });

/** The Ticket's latest Report, for the Inbox to show its title. */
const LatestReport = Type.Union(
  [Type.Object({ id: Type.String({ format: "uuid" }), title: Type.String({ description: "Its current Version's." }) }), Type.Null()],
  { description: "The Ticket's latest Report, or null when it has none." },
);

/** A Ticket in a Review Status, waiting for its Assignee's review. */
export const ReviewItem = Type.Object({
  kind: Type.Literal("review"),
  ticket: TicketSummary,
  status: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
  report: LatestReport,
  since: Since("when the Ticket entered its Review Status"),
});

/** A Question a Run asked on a Ticket assigned to the User, until a User answers or dismisses it. */
export const QuestionItem = Type.Object({
  kind: Type.Literal("question"),
  ticket: TicketSummary,
  question: Question,
  since: Since("when the Run asked the Question"),
});

/**
 * A Ticket a Step's *needs you* Outcome moved, handing it back to its Assignee, until it moves again: a Run
 * finished with it, or Cronk applied it past the Step's round limit, with or without a Run.
 */
export const NeedsYouItem = Type.Object({
  kind: Type.Literal("needsYou"),
  ticket: TicketSummary,
  status: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }, { description: "Where the Outcome moved it." }),
  outcome: Type.String({ description: "The name of the needs you Outcome that applied." }),
  step: Type.Object(
    {
      statusId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Null once the Status is removed." }),
      name: Type.String({ description: "The Status's name when its Run started, or when Cronk applied the Outcome without one." }),
    },
    { description: "The Step whose Outcome handed the Ticket back, by the Status it sits on." },
  ),
  question: Type.Optional(
    Type.String({
      description:
        "Cronk's own Question, when it applied the Step's needs you Outcome past its round limit. An Agent's Question " +
        "is an Inbox item of its own.",
    }),
  ),
  since: Since("when the needs you Outcome moved the Ticket"),
});

/** A Ticket whose latest Run failed, was lost or couldn't start, waiting where it is for the Delegate's Owner to Retry. */
export const RunItem = Type.Object({
  kind: Type.Literal("run"),
  ticket: TicketSummary,
  run: Type.Object({
    id: Type.String({ format: "uuid" }),
    state: WentWrongState,
    step: Type.Object({ statusId: Type.String({ format: "uuid" }), name: Type.String() }),
    endReason: Type.Union([Type.String(), Type.Null()]),
  }),
  since: Since("when the Run ended, or was refused"),
});

const StatusRef = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() });

/** A Ticket a Run or a merge completed, Unverified until its Assignee Accepts or Reopens it. */
export const UnverifiedItem = Type.Object({
  kind: Type.Literal("unverified"),
  ticket: TicketSummary,
  status: Type.Object(StatusRef.properties, { description: "The Done Status the Run completed it to." }),
  completedBy: Type.Union([StatusRef, Type.Null()], {
    description:
      "The Step that completed it (or produced the merged Pull Request), by its Status, where Reopen sends it; null once that Status is removed, or when no Step did.",
  }),
  completedWithoutStep: Type.Boolean({
    description: "Whether no Step produced the work, as with a merge of a Pull Request a User opened: Reopen then leaves it where it is.",
  }),
  report: LatestReport,
  since: Since("when the Ticket was completed, by a Run or a merge, moving it to its Done Status"),
});

/** A Discovered Ticket an Agent filed, waiting for its Assignee to delegate, move or dismiss it. */
export const DiscoveredItem = Type.Object({
  kind: Type.Literal("discovered"),
  ticket: TicketSummary,
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }, { description: "The Agent that filed it." }),
  since: Since("when the Agent filed the Ticket"),
});

/** A Ticket whose Assignee was removed from the Workspace, waiting for an Admin to assign it to someone. */
export const ReassignItem = Type.Object({
  kind: Type.Literal("reassign"),
  ticket: TicketSummary,
  formerAssignee: User,
  since: Since("when the Assignee of the Ticket was removed from the Workspace"),
});

export const InboxItem = Type.Union([QuestionItem, NeedsYouItem, ReviewItem, UnverifiedItem, RunItem, DiscoveredItem, ReassignItem]);
export type InboxItem = Static<typeof InboxItem>;

export const Inbox = Type.Object({
  count: Type.Integer({ description: "How many items are in the Inbox." }),
  items: Type.Array(InboxItem),
});
export type Inbox = Static<typeof Inbox>;

/** The User's Inbox in the Workspace; the caller checks they belong to it, and whether they are its Admin. */
export async function inboxOf(db: Db, userId: string, workspace: { id: string; isAdmin: boolean }): Promise<Inbox> {
  const workspaceId = workspace.id;
  const questions = await openQuestionsFor(db, userId, workspaceId);
  type Row = TicketRow & {
    statusName: string;
    statusEnteredAt: Date;
    inReview: boolean;
    completedBy: { id: string; name: string } | null;
    completedWithoutStep: boolean;
    handedBack: { outcome: string; step: { statusId: string | null; name: string }; question?: string } | null;
    report: { id: string; title: string } | null;
  };
  const { rows } = await db.query<Row>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId", statuses.name as "statusName",
       tickets.status_entered_at as "statusEnteredAt", statuses.kind = 'review' as "inReview",
       case when completed_by.id is not null then json_build_object('id', completed_by.id, 'name', completed_by.name)
         end as "completedBy", tickets.completed_without_step as "completedWithoutStep",
       case when needs_you.ticket_id is not null then json_build_object(
         'outcome', needs_you.outcome,
         'step', json_build_object('statusId', needs_you.step_status_id, 'name', needs_you.step_status_name)
       )::jsonb || case when needs_you.question is null then '{}' else jsonb_build_object('question', needs_you.question) end
       end as "handedBack",
       (select json_build_object('id', documents.id, 'title', versions.title)
          from documents join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
          where documents.ticket_id = tickets.id order by documents.seq desc limit 1) as report
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     left join needs_you on needs_you.ticket_id = tickets.id
     left join statuses completed_by on completed_by.id = tickets.completed_from_status_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2
       and (statuses.kind = 'review' or needs_you.ticket_id is not null or tickets.id = any($3) or tickets.verification = 'unverified')
     order by projects.key, tickets.number`,
    [workspaceId, userId, questions.map((q) => q.ticketId)],
  );
  const summary = ({ statusName: _s, statusEnteredAt: _e, inReview: _r, completedBy: _c, completedWithoutStep: _w, handedBack: _h, report: _p, ...row }: Row) =>
    ticketSummary(row);
  const tickets = new Map(rows.map((row) => [row.id, summary(row)]));
  /** The Ticket, the Status it waits in, and when it entered it. */
  const inStatus = (row: Row) => ({
    ticket: summary(row),
    status: { id: row.statusId, name: row.statusName },
    since: row.statusEnteredAt.toISOString(),
  });
  const items: InboxItem[] = [
    // A Ticket reassigned between the two reads drops out with its Question.
    ...questions.flatMap(({ ticketId, ...question }): InboxItem[] => {
      const ticket = tickets.get(ticketId);
      return ticket ? [{ kind: "question", ticket, question, since: question.askedAt }] : [];
    }),
    ...rows.flatMap((row): InboxItem[] => (row.handedBack ? [{ kind: "needsYou", ...inStatus(row), ...row.handedBack }] : [])),
    ...rows.flatMap((row): InboxItem[] => (row.inReview ? [{ kind: "review", ...inStatus(row), report: row.report }] : [])),
    ...rows.flatMap((row): InboxItem[] =>
      row.verification === "unverified"
        ? [{ kind: "unverified", ...inStatus(row), completedBy: row.completedBy, completedWithoutStep: row.completedWithoutStep, report: row.report }]
        : [],
    ),
  ];
  // A Ticket still in the Status of its latest Run, which went wrong, delegated to one of the User's Agents,
  // unless it already waits for its next Run (after a Retry, while its Runner is full).
  const { rows: wentWrong } = await db.query<TicketRow & { run: Static<typeof RunItem>["run"]; endedAt: Date }>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId", runs.ended_at as "endedAt",
       json_build_object('id', runs.id, 'state', runs.state,
         'step', json_build_object('statusId', runs.status_id, 'name', runs.status_name), 'endReason', runs.end_reason) as run
     from tickets join projects on projects.id = tickets.project_id
     join agents on agents.id = tickets.delegate_id
     join lateral (select * from runs where runs.ticket_id = tickets.id order by runs.seq desc limit 1) runs on true
     where tickets.workspace_id = $1 and agents.owner_id = $2 and not tickets.waits_for_run
       and runs.state = any($3::run_state[]) and runs.status_id = tickets.status_id
     order by projects.key, tickets.number`,
    [workspaceId, userId, wentWrongStates],
  );
  for (const { run, endedAt, ...row } of wentWrong) {
    items.push({ kind: "run", ticket: ticketSummary(row), run, since: endedAt.toISOString() });
  }
  const { rows: discovered } = await db.query<TicketRow & { agent: { id: string; name: string } }>(
    `select ${ticketColumns}, tickets.workspace_id as "workspaceId",
       json_build_object('id', agents.id, 'name', agents.name) as agent
     from tickets join projects on projects.id = tickets.project_id
     join agents on agents.id = tickets.discovered_by_agent_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2 and tickets.discovery_waits
     order by projects.key, tickets.number`,
    [workspaceId, userId],
  );
  for (const { agent, ...row } of discovered) {
    items.push({ kind: "discovered", ticket: ticketSummary(row), agent, since: row.createdAt.toISOString() });
  }
  if (workspace.isAdmin) {
    // Removing its Assignee recorded its latest assignee Change: assigning it again takes it out of the Inbox.
    const { rows: toReassign } = await db.query<TicketRow & { formerAssignee: User; removedAt: Date }>(
      `select ${ticketColumns}, tickets.workspace_id as "workspaceId",
         json_build_object('id', users.id, 'email', users.email, 'githubLogin', users.github_login) as "formerAssignee",
         (select max(changes.at) from changes where changes.ticket_id = tickets.id and changes.field = 'assignee') as "removedAt"
       from tickets join projects on projects.id = tickets.project_id
       join users on users.id = tickets.former_assignee_id
       where tickets.workspace_id = $1 and tickets.assignee_id is null
       order by projects.key, tickets.number`,
      [workspaceId],
    );
    for (const { formerAssignee, removedAt, ...row } of toReassign) {
      items.push({ kind: "reassign", ticket: ticketSummary(row), formerAssignee, since: removedAt.toISOString() });
    }
  }
  return { count: items.length, items };
}

