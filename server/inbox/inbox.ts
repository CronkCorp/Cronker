import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { User, userJson } from "../identity/user.js";
import { latestReportOf, ReportRef } from "../knowledge/reports.js";
import { openQuestionsFor, Question } from "../runs/questions.js";
import { WentWrongState, wentWrongStates } from "../runs/states.js";
import { inReach, userViewer } from "../identity/viewers.js";
import { ticketColumns, TicketSummary, ticketSummary, type TicketRow } from "../work/tickets.js";

/**
 * A User's Inbox in one Workspace: everything waiting on them. It is worked out from
 * current state on every read rather than stored, so an item leaves as soon as the
 * state that put it there changes.
 */

/** When an item began waiting on the User; `when` says what that is for its kind. */
const Since = (when: string) => Type.String({ format: "date-time", description: `When it began waiting: ${when}.` });

/** The Ticket's latest Report, for the Inbox to show its title. */
const LatestReport = Type.Union([ReportRef, Type.Null()], { description: "The Ticket's latest Report, or null when it has none." });

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

/** A Ticket whose Assignee was removed from the Workspace or lost Write in its Project, waiting for an Admin to assign it to someone. */
export const ReassignItem = Type.Object({
  kind: Type.Literal("reassign"),
  ticket: TicketSummary,
  formerAssignee: User,
  since: Since("when the Assignee of the Ticket was taken off it, by leaving the Workspace or losing Write in its Project"),
});

/**
 * A Ticket its Project's Agent Access dropping below Write undelegated, stopping its Run, waiting for its Assignee
 * until a User moves, reassigns or delegates it.
 */
export const UndelegatedItem = Type.Object({
  kind: Type.Literal("undelegated"),
  ticket: TicketSummary,
  since: Since("when an Admin dropped its Project's Agent Access below Write"),
});

export const InboxItem = Type.Union([
  QuestionItem,
  NeedsYouItem,
  ReviewItem,
  UnverifiedItem,
  RunItem,
  DiscoveredItem,
  ReassignItem,
  UndelegatedItem,
]);
export type InboxItem = Static<typeof InboxItem>;

export const Inbox = Type.Object({
  count: Type.Integer({ description: "How many items are in the Inbox." }),
  items: Type.Array(InboxItem),
});
export type Inbox = Static<typeof Inbox>;

/**
 * The User's Inbox in the Workspace; the caller checks they belong to it, and whether they are its Admin. It holds
 * only Tickets of Projects the User may read.
 */
export async function inboxOf(db: Db, userId: string, workspace: { id: string; isAdmin: boolean }): Promise<Inbox> {
  const workspaceId = workspace.id;
  const viewer = userViewer(userId);
  /** The Ticket's columns as the User sees them and the condition that they may read it, both bound to `param`. */
  const seen = (param: string) => ({
    columns: ticketColumns(viewer, param).sql,
    readable: inReach(viewer, { project: "tickets.project_id", workspace: "tickets.workspace_id" }, param).sql,
    value: inReach(viewer, { project: "tickets.project_id", workspace: "tickets.workspace_id" }, param).value,
  });
  const questions = await openQuestionsFor(db, userId, workspaceId);
  type Row = TicketRow & {
    statusName: string;
    statusEnteredAt: Date;
    inReview: boolean;
    completedBy: { id: string; name: string } | null;
    completedWithoutStep: boolean;
    handedBack: { outcome: string; step: { statusId: string | null; name: string }; question?: string } | null;
    report: ReportRef | null;
  };
  const mine = seen("$4");
  const { rows } = await db.query<Row>(
    `select ${mine.columns}, tickets.workspace_id as "workspaceId", statuses.name as "statusName",
       tickets.status_entered_at as "statusEnteredAt", statuses.kind = 'review' as "inReview",
       case when completed_by.id is not null then json_build_object('id', completed_by.id, 'name', completed_by.name)
         end as "completedBy", tickets.completed_without_step as "completedWithoutStep",
       case when needs_you.ticket_id is not null then json_build_object(
         'outcome', needs_you.outcome,
         'step', json_build_object('statusId', needs_you.step_status_id, 'name', needs_you.step_status_name)
       )::jsonb || case when needs_you.question is null then '{}' else jsonb_build_object('question', needs_you.question) end
       end as "handedBack",
       ${latestReportOf("tickets.id")} as report
     from tickets join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     left join needs_you on needs_you.ticket_id = tickets.id
     left join statuses completed_by on completed_by.id = tickets.completed_from_status_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2
       and (statuses.kind = 'review' or needs_you.ticket_id is not null or tickets.id = any($3) or tickets.verification = 'unverified')
       and ${mine.readable}
     order by projects.key, tickets.number`,
    [workspaceId, userId, questions.map((q) => q.ticketId), mine.value],
  );
  const summary = ({
    statusName: _s,
    statusEnteredAt: _e,
    inReview: _r,
    completedBy: _c,
    completedWithoutStep: _w,
    handedBack: _h,
    report: _report,
    ...row
  }: Row) => ticketSummary(row);
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
        ? [
            {
              kind: "unverified",
              ...inStatus(row),
              completedBy: row.completedBy,
              completedWithoutStep: row.completedWithoutStep,
              report: row.report,
            },
          ]
        : [],
    ),
  ];
  // A Ticket still in the Status of its latest Run, which went wrong, delegated to one of the User's Agents,
  // unless it already waits for its next Run (after a Retry, while its Runner is full).
  const wrong = seen("$4");
  const { rows: wentWrong } = await db.query<TicketRow & { run: Static<typeof RunItem>["run"]; endedAt: Date }>(
    `select ${wrong.columns}, tickets.workspace_id as "workspaceId", runs.ended_at as "endedAt",
       json_build_object('id', runs.id, 'state', runs.state,
         'step', json_build_object('statusId', runs.status_id, 'name', runs.status_name), 'endReason', runs.end_reason) as run
     from tickets join projects on projects.id = tickets.project_id
     join agents on agents.id = tickets.delegate_id
     join lateral (select * from runs where runs.ticket_id = tickets.id order by runs.seq desc limit 1) runs on true
     where tickets.workspace_id = $1 and agents.owner_id = $2 and not tickets.waits_for_run
       and runs.state = any($3::run_state[]) and runs.status_id = tickets.status_id and ${wrong.readable}
     order by projects.key, tickets.number`,
    [workspaceId, userId, wentWrongStates, wrong.value],
  );
  for (const { run, endedAt, ...row } of wentWrong) {
    items.push({ kind: "run", ticket: ticketSummary(row), run, since: endedAt.toISOString() });
  }
  const filed = seen("$3");
  const { rows: discovered } = await db.query<TicketRow & { agent: { id: string; name: string } }>(
    `select ${filed.columns}, tickets.workspace_id as "workspaceId",
       json_build_object('id', agents.id, 'name', agents.name) as agent
     from tickets join projects on projects.id = tickets.project_id
     join agents on agents.id = tickets.discovered_by_agent_id
     left join tickets parents on parents.id = tickets.parent_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2 and tickets.discovery_waits
       -- A Sub-Ticket the Agent split its waiting Discovered Ticket into waits with its parent, not on its own.
       and (parents.discovery_waits and parents.discovered_by_agent_id = tickets.discovered_by_agent_id) is not true
       and ${filed.readable}
     order by projects.key, tickets.number`,
    [workspaceId, userId, filed.value],
  );
  for (const { agent, ...row } of discovered) {
    items.push({ kind: "discovered", ticket: ticketSummary(row), agent, since: row.createdAt.toISOString() });
  }
  const undelegated = seen("$3");
  const { rows: undelegatedRows } = await db.query<TicketRow & { undelegatedAt: Date }>(
    `select ${undelegated.columns}, tickets.workspace_id as "workspaceId", tickets.undelegated_at as "undelegatedAt"
     from tickets join projects on projects.id = tickets.project_id
     where tickets.workspace_id = $1 and tickets.assignee_id = $2 and tickets.undelegated_at is not null
       and ${undelegated.readable}
     order by projects.key, tickets.number`,
    [workspaceId, userId, undelegated.value],
  );
  for (const { undelegatedAt, ...row } of undelegatedRows) {
    items.push({ kind: "undelegated", ticket: ticketSummary(row), since: undelegatedAt.toISOString() });
  }
  if (workspace.isAdmin) {
    // Removing its Assignee recorded its latest assignee Change: assigning it again takes it out of the Inbox.
    const unassigned = seen("$2");
    const { rows: toReassign } = await db.query<TicketRow & { formerAssignee: User; removedAt: Date }>(
      `select ${unassigned.columns}, tickets.workspace_id as "workspaceId",
         ${userJson("users")} as "formerAssignee",
         (select max(changes.at) from changes where changes.ticket_id = tickets.id and changes.field = 'assignee') as "removedAt"
       from tickets join projects on projects.id = tickets.project_id
       join users on users.id = tickets.former_assignee_id
       where tickets.workspace_id = $1 and tickets.assignee_id is null and ${unassigned.readable}
       order by projects.key, tickets.number`,
      [workspaceId, unassigned.value],
    );
    for (const { formerAssignee, removedAt, ...row } of toReassign) {
      items.push({ kind: "reassign", ticket: ticketSummary(row), formerAssignee, since: removedAt.toISOString() });
    }
  }
  return { count: items.length, items };
}

