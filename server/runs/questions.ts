import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { insertComment } from "../work/comment-writes.js";
import { statusesOf } from "../work/projects.js";
import { startRunIfNeeded, startUnblocked } from "./runs.js";

/**
 * Questions: what a Run asks a User when it finishes with its Step's *needs you* Outcome. A Question is
 * shown on its Ticket as a Comment from the Run's Agent, and waits in the Assignee's Inbox until a User
 * answers it with a reply to that Comment or dismisses it.
 */

export const Question = Type.Object({
  id: Type.String({ format: "uuid" }),
  commentId: Type.String({ format: "uuid", description: "The Comment that asks it, which a User answers by replying to." }),
  body: Type.String({ description: "Markdown." }),
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
  step: Type.Object(
    {
      statusId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Null once the Status is removed." }),
      name: Type.String({ description: "The Status's name when the Question was asked." }),
    },
    { description: "The Step that asked, by the Status it sits on, where answering sends the Ticket back." },
  ),
  askedAt: Type.String({ format: "date-time" }),
});
export type Question = Static<typeof Question>;

/** Asks the Run's Question on its Ticket, as a Comment from its Agent; call it in the transaction finishing the Run. */
export async function askQuestion(
  context: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string },
  run: { id: string; agentId: string; statusId: string | null; stepName: string },
  body: string,
  now: Date,
): Promise<void> {
  const commentId = await insertComment(context, tx, ticket, { kind: "agent", id: run.agentId }, body, null);
  await tx.query(
    `insert into questions (workspace_id, ticket_id, run_id, comment_id, step_status_id, step_status_name, asked_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [ticket.workspaceId, ticket.id, run.id, commentId, run.statusId, run.stepName, now],
  );
}

/** The Questions waiting on the User in the Workspace: unanswered and undismissed, on Tickets assigned to them. */
export async function openQuestionsFor(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<(Question & { ticketId: string })[]> {
  const { rows } = await db.query<Omit<Question, "askedAt"> & { ticketId: string; askedAt: Date }>(
    `select questions.id, questions.ticket_id as "ticketId", questions.comment_id as "commentId", comments.body,
       json_build_object('id', agents.id, 'name', agents.name) as agent,
       json_build_object('statusId', questions.step_status_id, 'name', questions.step_status_name) as step,
       questions.asked_at as "askedAt"
     from questions join tickets on tickets.id = questions.ticket_id
     join comments on comments.id = questions.comment_id
     join agents on agents.id = comments.actor_agent_id
     where questions.workspace_id = $1 and tickets.assignee_id = $2
       and questions.answered_at is null and questions.dismissed_at is null
     order by questions.asked_at, questions.id`,
    [workspaceId, userId],
  );
  return rows.map(({ askedAt, ...row }) => ({ ...row, askedAt: askedAt.toISOString() }));
}

/**
 * Answers the Question a User's reply is to, if it is the first User's reply to one. Should the Ticket
 * still sit where the Question's *needs you* Outcome moved it, it moves back to the Status of the Step
 * that asked, starting a new Run that reads the answer in the Comments; otherwise the answer is just a
 * Comment. Call it in the transaction that wrote the reply, holding the Ticket's lock.
 */
export async function answerQuestion(
  context: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string; statusId: string },
  userId: string,
  replyToId: string,
  answerId: string,
): Promise<void> {
  const now = context.clock.now();
  const { rows } = await tx.query<{ runId: string; stepStatusId: string | null; needsYouRunId: string | null }>(
    `update questions set answer_comment_id = $2, answered_at = $3
     from tickets where questions.comment_id = $1 and questions.answered_at is null and tickets.id = questions.ticket_id
     returning questions.run_id as "runId", questions.step_status_id as "stepStatusId",
       tickets.needs_you_run_id as "needsYouRunId"`,
    [replyToId, answerId, now],
  );
  const question = rows[0];
  if (!question) return;
  context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  if (question.needsYouRunId !== question.runId || !question.stepStatusId) return;

  // The User moves it back, as moving it by hand would: entering the Status resets its rounds.
  await tx.query("update tickets set status_id = $2, status_entered_at = $3, needs_you_run_id = null where id = $1", [
    ticket.id,
    question.stepStatusId,
    now,
  ]);
  const statuses = await statusesOf(tx, ticket.projectId);
  const named = (id: string) => ({ id, name: statuses.find((s) => s.id === id)!.name });
  await recordChanges(tx, ticket, userId, now, [
    { field: "status", from: named(ticket.statusId), to: named(question.stepStatusId) },
  ]);
  await tx.query("delete from round_counts where ticket_id = $1", [ticket.id]);
  await startRunIfNeeded(context, tx, ticket.id, now);
  await startUnblocked(context, tx, [ticket.id]);
}

/**
 * Dismisses a Question from the Inbox of its Ticket's Assignee, moving nothing. It stays on the Ticket,
 * where a User's reply still answers it.
 */
export async function dismissQuestion({ db, clock, live }: Context, viewer: Viewer & { kind: "user" }, questionId: string): Promise<void> {
  await transaction(db, async (tx) => {
    const view = inView(viewer, "questions.workspace_id", "$2");
    const { rows } = await tx.query<{ workspaceId: string; projectId: string; ticketId: string }>(
      `select questions.workspace_id as "workspaceId", tickets.project_id as "projectId", tickets.id as "ticketId"
       from questions join tickets on tickets.id = questions.ticket_id
       where questions.id = $1 and ${view.sql}`,
      [isUuid(questionId) ? questionId : null, view.value],
    );
    const question = rows[0];
    if (!question) throw new ApiError(404, "not_found", "No such Question.");
    await tx.query(
      "update questions set dismissed_at = $2, dismissed_by = $3 where id = $1 and dismissed_at is null",
      [questionId, clock.now(), viewer.id],
    );
    live.publish(tx, question.workspaceId, { type: "ticket.changed", projectId: question.projectId, ticketId: question.ticketId });
  });
}
