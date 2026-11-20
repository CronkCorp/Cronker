import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { startRunIfNeeded, startUnblocked, stopRunningRun } from "../runs/runs.js";
import { recordChanges, type ChangeActor } from "../work/changes.js";
import { statusesOf } from "../work/projects.js";
import type { Outcome } from "../work/steps.js";
import { sendBackOnEnteringReview } from "./conflicts.js";

/**
 * Pipeline: a Ticket moved by Cronk, on a Run's behalf or with none, applying the loop's rules in one place.
 * Cronk records the Change, stops a Run still running on the Ticket, counts a round for a Step whose Outcome sends
 * work back (applying that Step's *needs you* Outcome instead, with Cronk's own Question, past its round limit),
 * completes the Ticket as Verified or Unverified when it moves to a Done Status, and starts the next Run. An Outcome
 * moving the Ticket into a Review Status sends it back for a failure already known on its Pull Request, and has Cronk
 * ask GitHub whether its Pull Requests conflict.
 */

/**
 * SQL condition, for a query over `tickets` whose `$1` is a Pull Request's id: the Ticket's Project lists that Pull
 * Request's Repository. A Project that removed the Repository since keeps its links, so its Tickets still show the
 * Pull Request, but its merges and failures no longer move them.
 */
export const listsPullRequestsRepository = `exists (
  select from pull_requests join project_repositories on project_repositories.repository_id = pull_requests.repository_id
  where pull_requests.id = $1 and project_repositories.project_id = tickets.project_id)`;

/** The Ticket a move by Cronk moves, locked by the caller's transaction. */
export interface MovedTicket {
  id: string;
  key: string;
  workspaceId: string;
  projectId: string;
  statusId: string;
  verification: "unverified" | "verified" | null;
}

/**
 * Where a move by Cronk sends the Ticket: by an Outcome of a Step, back to the Status of the Step that produced its
 * work (as a failing check or requested changes do, counting as a round), or straight to a Status.
 */
export type CronkMoveTarget =
  | {
      kind: "outcome";
      /** The Step whose Outcome it is, by its Status, with its name as shown in Cronk's Question. */
      step: { statusId: string; name: string };
      outcome: Outcome;
    }
  | {
      kind: "sentBack";
      /** The Step that produced the work, by its Status, with its name as shown in Cronk's Question. */
      step: { statusId: string; name: string };
    }
  | {
      kind: "status";
      statusId: string;
      /** The Status of the Step that produced the work, where Reopen sends a completed Ticket; null for none. */
      completedFrom: string | null;
      /**
       * Whether no Step produced the work, as with a Pull Request a User opened: Reopen then leaves the completed
       * Ticket where it is. Otherwise a null `completedFrom` means that Step's Status is gone, and Reopen is refused.
       */
      withoutStep?: boolean;
    };

export interface CronkMove {
  target: CronkMoveTarget;
  /** Who the Changes are by: the Agent of the Run finishing, during it, or Cronk itself. */
  by: ChangeActor;
  /** The Run that ended with the Outcome, if one did: a *needs you* Outcome names it as the Run that handed the Ticket back. */
  runId?: string;
  /** Why a Run still running on the Ticket stops, as a User's move stops it; it is left alone without one. */
  stopReason?: string;
  /** How a move to a Done Status completes the Ticket. */
  verification: "unverified" | "verified";
  /** The merged Pull Request completing the Ticket, by GitHub's id, when a merge moves it. */
  pullRequestId?: number;
  /**
   * Called once the rounds have decided the Outcome that applies, before the Ticket moves, at the time the move
   * records: a finishing Run ends here. Cronk's Question is set when it applied the Step's *needs you* Outcome
   * past the round limit.
   */
  beforeMove?: (decision: CronkMoveDecision, now: Date) => Promise<void>;
}

/** What a move by Cronk applied: the Outcome, null for a move straight to a Status, and Cronk's own Question, if it asked one. */
export interface CronkMoveDecision {
  outcome: Outcome | null;
  question: string | null;
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** Moves the Ticket as Cronk, as `CronkMove` says. Call it in the transaction that locked the Ticket. */
export async function moveByCronk(context: Context, tx: Tx, ticket: MovedTicket, move: CronkMove): Promise<CronkMoveDecision> {
  const now = context.clock.now();
  const statuses = await statusesOf(tx, ticket.projectId);
  const { target } = move;
  const decision: CronkMoveDecision = { outcome: target.kind === "outcome" ? target.outcome : null, question: null };
  if (target.kind === "outcome" || target.kind === "sentBack") {
    const step = statuses.find((s) => s.id === target.step.statusId)?.step;
    // An Outcome counting as a round, or work sent back, adds one for this Ticket and Step, until the count has
    // reached the Step's round limit: then *needs you* applies instead, with Cronk's own Question.
    if ((target.kind === "sentBack" || target.outcome.countsAsRound) && step) {
      const { rows } = await tx.query<{ stepId: string; count: number | null }>(
        `select steps.id as "stepId", round_counts.count from steps
         left join round_counts on round_counts.step_id = steps.id and round_counts.ticket_id = $2
         where steps.status_id = $1`,
        [target.step.statusId, ticket.id],
      );
      const { stepId, count } = rows[0]!;
      if ((count ?? 0) >= step.roundLimit) {
        decision.outcome = step.outcomes.find((o) => o.needsYou)!;
        decision.question =
          target.kind === "outcome"
            ? `${target.step.name} sent ${ticket.key} back by ${target.outcome.name} ${times(step.roundLimit)}, its round limit, ` +
              "so it comes to you instead. Read the latest Reports, then move it on yourself."
            : `Failing checks, requested changes and merge conflicts sent ${ticket.key} back to ${target.step.name} ${times(step.roundLimit)}, ` +
              "its round limit, so it comes to you instead. Read the latest Comments, then move it on yourself.";
      } else {
        await tx.query(
          `insert into round_counts (workspace_id, ticket_id, step_id, count) values ($1, $2, $3, 1)
           on conflict (ticket_id, step_id) do update set count = round_counts.count + 1`,
          [ticket.workspaceId, ticket.id, stepId],
        );
      }
    }
  }
  await move.beforeMove?.(decision, now);

  if (move.stopReason !== undefined) await stopRunningRun(context, tx, ticket.id, move.stopReason, now);
  const to =
    decision.outcome?.statusId ??
    (target.kind === "status" ? target.statusId : target.kind === "sentBack" ? target.step.statusId : ticket.statusId);
  if (to !== ticket.statusId) {
    await tx.query("update tickets set status_id = $2, status_entered_at = $3 where id = $1", [ticket.id, to, now]);
    // A Ticket moved by needs you waits in its Assignee's Inbox until it moves again.
    await tx.query("delete from needs_you where ticket_id = $1", [ticket.id]);
    if (decision.outcome?.needsYou && target.kind !== "status") {
      await tx.query(
        `insert into needs_you (ticket_id, workspace_id, run_id, outcome, step_status_id, step_status_name, question)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [ticket.id, ticket.workspaceId, move.runId ?? null, decision.outcome.name, target.step.statusId, target.step.name, decision.question],
      );
    }
    const named = (id: string) => ({ id, name: statuses.find((s) => s.id === id)!.name });
    await recordChanges(tx, ticket, move.by, now, [{ field: "status", from: named(ticket.statusId), to: named(to) }]);
    await startUnblocked(context, tx, [ticket.id]);
    // A failure known before an Outcome moved it into a Review Status sends it back, before a Run starts there:
    // that move tells the Workspace and starts the next Run. Otherwise Cronk asks GitHub whether it conflicts.
    if (target.kind === "outcome" && statuses.find((s) => s.id === to)!.kind === "review") {
      if (await sendBackOnEnteringReview(context, tx, ticket.id)) return decision;
    }
  }
  if (statuses.find((s) => s.id === to)!.kind === "done") {
    // A completion by Cronk is Unverified until a User Accepts or Reopens it, unless it comes Verified.
    const completedFrom = target.kind === "status" ? target.completedFrom : target.step.statusId;
    const withoutStep = target.kind === "status" && target.withoutStep === true;
    await tx.query(
      `update tickets set verification = $2, completed_from_status_id = $3, completed_without_step = $4,
         completed_by_pull_request_id = $5
       where id = $1`,
      [ticket.id, move.verification, completedFrom, withoutStep, move.pullRequestId ?? null],
    );
    await recordChanges(tx, ticket, move.by, now, [{ field: "verification", from: ticket.verification, to: move.verification }]);
  }
  context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  // Moving into a Status counts as entering it.
  await startRunIfNeeded(context, tx, ticket.id, now);
  return decision;
}
