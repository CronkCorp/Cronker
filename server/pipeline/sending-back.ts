import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { recordChanges } from "../work/changes.js";
import { insertComment } from "../work/comment-writes.js";
import { statusesOf } from "../work/projects.js";
import { inUnarchivedProject, listsPullRequestsRepository, moveByCronk, type MovedTicket } from "./cronk-moves.js";

/**
 * Pipeline: a failure on a Pull Request sends the Tickets it links back to work. A failing check on its latest commit
 * (a check run, a commit status, or a check suite, which fails too when its workflow fails before running any check run),
 * or a review requesting changes, whoever wrote it, sends each linked Ticket that is in a Review Status and has a producing Step, or that waits
 * in the Merge Queue with the Pull Request, in a Project with Pull Request automation on that still lists the Pull Request's Repository,
 * back to that Step's Status as a move by Cronk. It counts as a round for the Step: past its round limit the Step's *needs you* Outcome applies instead, with
 * Cronk's own Question. A queued Ticket with no producing Step goes to its Project's first Review Status instead, not as a
 * round; either move takes it out of the queue. Cronk writes a Comment linking the failure. Each head commit and each review sends a
 * Ticket back at most once, so many failing checks on one commit send it back once. A failure that arrived before
 * the Ticket was in a Review Status, such as while its Code review Run was still working, sends it back once an
 * Outcome moves it into one. A conflict with the base branch sends nothing back: it only marks the Pull Request (see
 * `conflicts.ts`).
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

const causeOf = (failure: Failure) =>
  failure.kind === "check" ? `commit:${failure.sha}` : `review:${failure.id}`;

/** The failure as reading the Ticket shows it, without the time it sent the Ticket back. */
const shown = (failure: Failure) =>
  failure.kind === "check"
    ? { kind: failure.kind, name: failure.name, sha: failure.sha, url: failure.url }
    : { kind: failure.kind, reviewer: failure.reviewer, url: failure.url };

/** The failure as a `sentBack` Change names it: the check or the review, with its link. */
const named = (failure: Failure) =>
  failure.kind === "check"
    ? { kind: failure.kind, name: failure.name, url: failure.url }
    : { kind: failure.kind, reviewer: failure.reviewer, url: failure.url };

/** What sent the Ticket back, as a Run it stops is told. */
const stopsFor: Record<Failure["kind"], string> = { check: "A failing check", review: "Requested changes" };

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
 * transaction that recorded the failure. With `ticketId`, only that Ticket is sent back; with `again`, even when this
 * failure sent it back before, as when a User queued it again on the same commit.
 */
export async function sendBackForFailure(
  context: Context,
  tx: Tx,
  pullRequest: FailedPullRequest,
  failure: Failure,
  { ticketId, again = false }: { ticketId?: string; again?: boolean } = {},
): Promise<boolean> {
  const { rows: tickets } = await tx.query<MovedTicket & { stepStatusId: string | null; stepName: string | null }>(
    `select tickets.id, projects.key || '-' || tickets.number as key, tickets.workspace_id as "workspaceId",
       tickets.project_id as "projectId", tickets.status_id as "statusId", tickets.verification,
       producing.id as "stepStatusId", producing.name as "stepName"
     from pull_request_links
     join tickets on tickets.id = pull_request_links.ticket_id
     join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     -- A Status that has lost its Step since produces nothing to send back to.
     left join (runs join statuses producing on producing.id = runs.status_id join steps on steps.status_id = producing.id)
       on runs.id = pull_request_links.producing_run_id
     where pull_request_links.pull_request_id = $1 and projects.pull_request_automation
       and ((statuses.kind = 'review' and producing.id is not null)
         -- A queued Ticket leaves the queue, unless Cronk is merging it already.
         or exists (select from merge_queue where merge_queue.pull_request_id = $1 and merge_queue.ticket_id = tickets.id
           and merge_queue.state = 'queued'))
       and ${listsPullRequestsRepository} and ${inUnarchivedProject} and ($2::uuid is null or tickets.id = $2::uuid)
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
    // Each head commit, each review and each base commit sends a Ticket back once.
    const { rowCount: first } = await tx.query(
      `insert into sent_back (pull_request_id, ticket_id, workspace_id, cause, failure, sent_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (pull_request_id, ticket_id, cause) do ${again ? "update set failure = excluded.failure, sent_at = excluded.sent_at" : "nothing"}`,
      [pullRequest.id, ticket.id, ticket.workspaceId, causeOf(failure), JSON.stringify(shown(failure)), context.clock.now()],
    );
    if (!first) continue;
    sent = true;
    let movedAt = context.clock.now();
    // A queued Ticket no Step produced goes to its Project's first Review Status, not as a round.
    const review = stepStatusId === null ? (await statusesOf(tx, ticket.projectId)).find((s) => s.kind === "review")! : null;
    const toName = stepName ?? review!.name;
    const decision = await moveByCronk(context, tx, ticket, {
      target:
        stepStatusId !== null
          ? { kind: "sentBack", step: { statusId: stepStatusId, name: toName } }
          : { kind: "status", statusId: review!.id, completedFrom: null, withoutStep: true },
      by: { kind: "cronk" },
      stopReason: `${stopsFor[failure.kind]} sent ${ticket.key} back to ${toName}.`,
      verification: "unverified",
      // Recorded at the move's time, ahead of the Change moving it.
      beforeMove: async (_decision, now) => {
        movedAt = now;
        await recordChanges(tx, ticket, { kind: "cronk" }, now, [{ field: "sentBack", from: null, to: cause }]);
      },
    });
    const sentWhere = decision.outcome?.needsYou
      ? `That is past ${toName}'s round limit, so ${ticket.key} comes to its Assignee instead.`
      : `Sent ${ticket.key} back to ${toName}.`;
    await insertComment(context, tx, ticket, { kind: "cronk" }, `${failed} ${sentWhere}`, null, { at: movedAt });
  }
  return sent;
}

/**
 * A failed check on the commit, if Cronk knows one, as the commit's failure: a failed check run or status, the first
 * GitHub reported, or else a failed check suite.
 */
export async function failingCheckOn(tx: Tx, repositoryId: number | string, sha: string): Promise<Failure | null> {
  const { rows } = await tx.query<{ name: string; url: string | null }>(
    // A failing check run or status names the failure better than its suite does, so comes first.
    `select name, url from (
       (select name, url, 0 as source, source_id from commit_checks where repository_id = $1 and sha = $2 and state = 'failed')
       union all
       (select app_name, url, 1, id from commit_check_suites where repository_id = $1 and sha = $2 and failed)
       order by source, source_id limit 1) as failed`,
    [repositoryId, sha],
  );
  return rows[0] ? { kind: "check", sha, ...rows[0] } : null;
}

/**
 * Sends the Ticket back for a failure Cronk already knows on one of its open Pull Requests, now that an Outcome has
 * moved it into a Review Status: a failing check on the latest commit, or a review still requesting changes. Failures
 * that sent it back before are passed over, and the first that sends it back ends the search. Says whether one did.
 * Call it in the transaction that moved the Ticket, before a Run starts in the Review Status.
 */
export async function sendBackForKnownFailures(context: Context, tx: Tx, ticketId: string): Promise<boolean> {
  const { rows: pullRequests } = await tx.query<{
    id: string;
    repositoryId: string;
    sha: string;
    repository: string;
    number: number;
    url: string;
    workspaceId: string;
    projectId: string;
  }>(
    `select pull_requests.id, pull_requests.repository_id as "repositoryId", pull_requests.head_sha as sha,
       pull_requests.repository_full_name as repository, pull_requests.number, pull_requests.url,
       tickets.workspace_id as "workspaceId", tickets.project_id as "projectId"
     from pull_request_links
     join pull_requests on pull_requests.id = pull_request_links.pull_request_id
     join tickets on tickets.id = pull_request_links.ticket_id
     where pull_request_links.ticket_id = $1 and pull_requests.state in ('open', 'draft')
     order by pull_request_links.linked_at, pull_requests.id`,
    [ticketId],
  );
  for (const { id, repositoryId, sha, repository, number, url, workspaceId, projectId } of pullRequests) {
    // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
    const pullRequest = { id: Number(id), repository, number, url };
    const failures: Failure[] = [];
    const check = await failingCheckOn(tx, repositoryId, sha);
    if (check) failures.push(check);
    const { rows: reviews } = await tx.query<{ id: string; reviewer: string; url: string | null }>(
      `select review_id as id, reviewer, url from pull_request_reviews
       where pull_request_id = $1 and state = 'changes_requested' order by review_id`,
      [id],
    );
    for (const review of reviews) failures.push({ kind: "review", id: Number(review.id), reviewer: review.reviewer, url: review.url });
    for (const failure of failures) {
      if (await sendBackForFailure(context, tx, pullRequest, failure, { ticketId })) {
        // What last sent the Ticket back shows on its Pull Request.
        context.live.publish(tx, workspaceId, { type: "pull_requests.changed", projectId, ticketId });
        return true;
      }
    }
  }
  return false;
}
