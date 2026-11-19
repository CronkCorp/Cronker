import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { insertComment } from "../work/comment-writes.js";
import { moveByCronk, type MovedTicket } from "./cronk-moves.js";

/**
 * Pipeline: a failure on a Pull Request sends the Tickets it links back to work. A failing check on its latest commit,
 * or a review requesting changes, whoever wrote it, sends each linked Ticket that is in a Review Status, has a
 * producing Step and is in a Project with Pull Request automation on, back to that Step's Status as a move by Cronk.
 * It counts as a round for the Step: past its round limit the Step's *needs you* Outcome applies instead, with
 * Cronk's own Question. Cronk writes a Comment linking the failure. Each head commit and each review sends a
 * Ticket back at most once, so many failing checks on one commit send it back once.
 */

/** What failed, as reading the Ticket shows it. */
export type Failure =
  | {
      kind: "check";
      /** The check run's name, or the commit status's context. */
      name: string;
      /** The commit it failed on. */
      sha: string;
      url: string | null;
    }
  | {
      kind: "review";
      /** GitHub's id for the review. */
      id: number;
      /** The login of the GitHub account that wrote it, if GitHub named one. */
      reviewer: string | null;
      url: string | null;
    };

/** The Pull Request the failure is on. */
export interface FailedPullRequest {
  id: number;
  repository: string;
  number: number;
  url: string;
}

const causeOf = (failure: Failure) => (failure.kind === "check" ? `commit:${failure.sha}` : `review:${failure.id}`);

/** The failure as reading the Ticket shows it, without the time it sent the Ticket back. */
const shown = (failure: Failure) =>
  failure.kind === "check"
    ? { kind: failure.kind, name: failure.name, sha: failure.sha, url: failure.url }
    : { kind: failure.kind, reviewer: failure.reviewer, url: failure.url };

const linked = (text: string, url: string | null) => (url ? `[${text}](${url})` : text);

function describe(failure: Failure, pullRequest: FailedPullRequest): string {
  const name = linked(`${pullRequest.repository}#${pullRequest.number}`, pullRequest.url);
  if (failure.kind === "check") {
    return `The check ${linked(`**${failure.name}**`, failure.url)} failed on ${name}'s latest commit \`${failure.sha.slice(0, 7)}\`.`;
  }
  const by = failure.reviewer ? `@${failure.reviewer}` : "A reviewer";
  return `${by} ${linked("requested changes", failure.url)} on ${name}.`;
}

/**
 * Sends the Tickets the Pull Request links back for the failure, and says whether it sent any. Call it in the
 * transaction that recorded the failure.
 */
export async function sendBackForFailure(
  context: Context,
  tx: Tx,
  pullRequest: FailedPullRequest,
  failure: Failure,
): Promise<boolean> {
  const { rows: tickets } = await tx.query<MovedTicket & { stepStatusId: string; stepName: string }>(
    `select tickets.id, projects.key || '-' || tickets.number as key, tickets.workspace_id as "workspaceId",
       tickets.project_id as "projectId", tickets.status_id as "statusId", tickets.verification,
       producing.id as "stepStatusId", producing.name as "stepName"
     from pull_request_links
     join tickets on tickets.id = pull_request_links.ticket_id
     join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     join runs on runs.id = pull_request_links.producing_run_id
     join statuses producing on producing.id = runs.status_id
     -- A Status that has lost its Step since produces nothing to send back to.
     join steps on steps.status_id = producing.id
     where pull_request_links.pull_request_id = $1 and projects.pull_request_automation and statuses.kind = 'review'
     order by tickets.id
     for update of tickets`,
    [pullRequest.id],
  );
  const failed = describe(failure, pullRequest);
  let sent = false;
  for (const { stepStatusId, stepName, ...ticket } of tickets) {
    // Each head commit and each review sends a Ticket back once.
    const { rowCount: first } = await tx.query(
      `insert into sent_back (pull_request_id, ticket_id, workspace_id, cause, failure, sent_at) values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing`,
      [pullRequest.id, ticket.id, ticket.workspaceId, causeOf(failure), JSON.stringify(shown(failure)), context.clock.now()],
    );
    if (!first) continue;
    sent = true;
    const decision = await moveByCronk(context, tx, ticket, {
      target: { kind: "sentBack", step: { statusId: stepStatusId, name: stepName } },
      by: { kind: "cronk" },
      stopReason: `${failure.kind === "check" ? "A failing check" : "Requested changes"} sent ${ticket.key} back to ${stepName}.`,
      verification: "unverified",
    });
    const sentWhere = decision.outcome?.needsYou
      ? `That is past ${stepName}'s round limit, so ${ticket.key} comes to its Assignee instead.`
      : `Sent ${ticket.key} back to ${stepName}.`;
    await insertComment(context, tx, ticket, { kind: "cronk" }, `${failed} ${sentWhere}`, null);
  }
  return sent;
}
