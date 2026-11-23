import type { Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import type { Live } from "../live/live.js";
import { runningRunOf } from "../work/tickets.js";

/**
 * New knowledge notices (CRONK-110): each Decision, Term, Document or Artifact an Agent creates waits as one New
 * knowledge item in one User's Inbox until they dismiss it, or, for a Decision, until its status leaves proposed.
 */

export type KnowledgeKind = "decision" | "term" | "document" | "artifact";

/** The column of `knowledge_notices` naming each kind of knowledge. */
const subjectColumn: Record<KnowledgeKind, string> = {
  decision: "decision_id",
  term: "term_id",
  document: "document_id",
  artifact: "artifact_id",
};

/**
 * The Agent's running Run the knowledge is created in, when it names one: refused for a User, and for a Run that isn't
 * the Agent's own running one.
 */
export async function creatingRun(
  tx: Tx,
  actor: Caller,
  runId: string | undefined,
  what: string,
): Promise<{ id: string; ticketId: string; assigneeId: string | null } | null> {
  if (runId === undefined) return null;
  if (actor.kind === "user") throw new ApiError(400, "run_for_agents", `Only an Agent names the Run it creates ${what} in.`);
  return runningRunOf(tx, actor, runId, {
    rule: `An Agent creates ${what} in a Run only while that Run of its own is running.`,
    advice: `Name your running Run, as your Brief gives it, or leave the Run out, and the New knowledge item waits for your Owner.`,
  });
}

/**
 * Records the New knowledge item an Agent's creation makes, in the same transaction: for the Assignee of the Ticket of
 * the Run it was created in, or else the Agent's Owner. A User's creation makes none, nor does a Report.
 */
export async function noticeKnowledge(
  tx: Tx,
  live: Live,
  actor: Caller,
  subject: { kind: KnowledgeKind; id: string; workspaceId: string },
  run: { id: string; assigneeId: string | null } | null,
  now: Date,
): Promise<void> {
  if (actor.kind !== "agent") return;
  const userId = run?.assigneeId ?? actor.owner.id;
  await tx.query(
    `insert into knowledge_notices (workspace_id, user_id, agent_id, run_id, ${subjectColumn[subject.kind]}, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [subject.workspaceId, userId, actor.id, run?.id ?? null, subject.id, now],
  );
  live.publish(tx, subject.workspaceId, { type: "inbox.changed" }, { users: [userId] });
}

/** Clears the New knowledge items of a Decision whose status left proposed: acting on it is what they waited for. */
export async function clearDecisionNotices(tx: Tx, live: Live, decision: { id: string; workspaceId: string }, now: Date): Promise<void> {
  const { rows } = await tx.query<{ userId: string }>(
    `update knowledge_notices set dismissed_at = $2 where decision_id = $1 and dismissed_at is null returning user_id as "userId"`,
    [decision.id, now],
  );
  if (rows.length > 0) live.publish(tx, decision.workspaceId, { type: "inbox.changed" }, { users: rows.map((r) => r.userId) });
}
