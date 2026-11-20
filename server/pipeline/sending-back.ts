import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { recordChanges } from "../work/changes.js";
import { insertComment } from "../work/comment-writes.js";
import { listsPullRequestsRepository, moveByCronk, type MovedTicket } from "./cronk-moves.js";

/**
 * Pipeline: a failure on a Pull Request sends the Tickets it links back to work. A failing check on its latest commit,
 * or a review requesting changes, whoever wrote it, sends each linked Ticket that is in a Review Status, has a
 * producing Step and is in a Project with Pull Request automation on that still lists the Pull Request's Repository,
 * back to that Step's Status as a move by Cronk. It counts as a round for the Step: past its round limit the Step's *needs you* Outcome applies instead, with
 * Cronk's own Question. Cronk writes a Comment linking the failure. Each head commit and each review sends a
 * Ticket back at most once, so many failing checks on one commit send it back once. A failure that arrived before
 * the Ticket was in a Review Status, such as while its Code review Run was still working, sends it back once an
 * Outcome moves it into one.
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

/** The failure as a `sentBack` Change names it: the check, or the review, with its link. */
const named = (failure: Failure) =>
  failure.kind === "check"
    ? { kind: failure.kind, name: failure.name, url: failure.url }
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
 * transaction that recorded the failure. With `ticketId`, only that Ticket is sent back.
 */
export async function sendBackForFailure(
  context: Context,
  tx: Tx,
  pullRequest: FailedPullRequest,
  failure: Failure,
  ticketId?: string,
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
       and ${listsPullRequestsRepository} and ($2::uuid is null or tickets.id = $2::uuid)
     order by tickets.id
     for update of tickets`,
    [pullRequest.id, ticketId ?? null],
  );
  const failed = describe(failure, pullRequest);
  const cause = {
    pullRequest: { id: pullRequest.id, repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url },
    failure: named(failure),
  };
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
    let movedAt = context.clock.now();
    const decision = await moveByCronk(context, tx, ticket, {
      target: { kind: "sentBack", step: { statusId: stepStatusId, name: stepName } },
      by: { kind: "cronk" },
      stopReason: `${failure.kind === "check" ? "A failing check" : "Requested changes"} sent ${ticket.key} back to ${stepName}.`,
      verification: "unverified",
      // Recorded at the move's time, ahead of the Change moving it.
      beforeMove: async (_decision, now) => {
        movedAt = now;
        await recordChanges(tx, ticket, { kind: "cronk" }, now, [{ field: "sentBack", from: null, to: cause }]);
      },
    });
    const sentWhere = decision.outcome?.needsYou
      ? `That is past ${stepName}'s round limit, so ${ticket.key} comes to its Assignee instead.`
      : `Sent ${ticket.key} back to ${stepName}.`;
    await insertComment(context, tx, ticket, { kind: "cronk" }, `${failed} ${sentWhere}`, null, { at: movedAt });
  }
  return sent;
}

/**
 * Sends the Ticket back for a failure Cronk already knows on one of its open Pull Requests, now that an Outcome has
 * moved it: a failing check on the latest commit, or a review still requesting changes. Failures that sent it back
 * before are passed over, and the first that sends it back ends the search. Call it in the transaction that moved it.
 */
export async function sendBackForKnownFailures(context: Context, tx: Tx, ticketId: string): Promise<void> {
  const { rows: pullRequests } = await tx.query<FailedPullRequest & { id: string; repositoryId: string; sha: string }>(
    `select pull_requests.id, pull_requests.repository_id as "repositoryId", pull_requests.head_sha as sha,
       pull_requests.repository_full_name as repository, pull_requests.number, pull_requests.url
     from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
     where pull_request_links.ticket_id = $1 and pull_requests.state in ('open', 'draft')
     order by pull_request_links.linked_at, pull_requests.id`,
    [ticketId],
  );
  for (const { repositoryId, sha, ...row } of pullRequests) {
    // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
    const pullRequest = { ...row, id: Number(row.id) };
    const failures: Failure[] = [];
    const { rows: checks } = await tx.query<{ name: string; url: string | null }>(
      `select name, url from commit_checks where repository_id = $1 and sha = $2 and state = 'failed'
       order by source_id limit 1`,
      [repositoryId, sha],
    );
    if (checks[0]) failures.push({ kind: "check", sha, ...checks[0] });
    const { rows: reviews } = await tx.query<{ id: string; reviewer: string; url: string | null }>(
      `select review_id as id, reviewer, url from pull_request_reviews
       where pull_request_id = $1 and state = 'changes_requested' order by review_id`,
      [pullRequest.id],
    );
    failures.push(...reviews.map((r) => ({ kind: "review" as const, id: Number(r.id), reviewer: r.reviewer, url: r.url })));
    for (const failure of failures) {
      if (await sendBackForFailure(context, tx, pullRequest, failure, ticketId)) return;
    }
  }
}
