import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { pullRequestMergeability, type MergeabilityOnGitHub } from "../github/client.js";
import { tokenForRepository } from "../github/installations.js";
import { listsPullRequestsRepository } from "./cronk-moves.js";
import { sendBackForFailure, sendBackForKnownFailures } from "./sending-back.js";

/**
 * Pipeline: a Pull Request conflicting with its base branch sends the Tickets it links back to work, as a failing
 * check does (`sending-back.ts`). GitHub sends no event when a Pull Request becomes conflicting, so Cronk asks it:
 * after a merge into a Repository, about the other open Pull Requests on that base branch linking a Ticket in a
 * Review Status, and once an Outcome moves a Ticket into a Review Status, about its open Pull Requests. Each ask
 * waits in `mergeability_checks` until `checkMergeability` asks GitHub; while GitHub answers that it is still
 * working mergeability out, it is asked again shortly, a bounded number of times. Direct pushes to a base branch
 * aren't watched.
 */

/** How long Cronk waits before asking again about a Pull Request whose mergeability GitHub is still working out. */
export const askAgainAfterMs = 10_000;

/** How many times Cronk asks about one Pull Request before giving up until the next merge or Outcome asks again. */
export const maxTries = 6;

/**
 * SQL condition, for a query over `pull_requests`: the Pull Request links a Ticket that a conflict would send back,
 * one in a Review Status with a producing Step, in a Project with Pull Request automation on that lists its Repository.
 */
const linksTicketToSendBack = `exists (
  select from pull_request_links
  join tickets on tickets.id = pull_request_links.ticket_id
  join projects on projects.id = tickets.project_id
  join statuses on statuses.id = tickets.status_id
  join runs on runs.id = pull_request_links.producing_run_id
  join steps on steps.status_id = runs.status_id
  join project_repositories on project_repositories.project_id = tickets.project_id
    and project_repositories.repository_id = pull_requests.repository_id
  where pull_request_links.pull_request_id = pull_requests.id and projects.pull_request_automation
    and statuses.kind = 'review')`;

/** Asks for the Pull Requests chosen by `where` over `pull_requests` to be checked, now, naming the merge, if any. */
async function queue(context: Context, tx: Tx, where: string, params: unknown[], mergedPullRequestId: string | null): Promise<void> {
  const mergedParam = `$${params.length + 1}`;
  const nowParam = `$${params.length + 2}`;
  await tx.query(
    `insert into mergeability_checks (pull_request_id, merged_pull_request_id, tries, due_at)
     select pull_requests.id, ${mergedParam}::bigint, 0, ${nowParam} from pull_requests
     where pull_requests.state in ('open', 'draft') and pull_requests.base_branch is not null and ${linksTicketToSendBack}
       and ${where}
     on conflict (pull_request_id) do update set merged_pull_request_id = excluded.merged_pull_request_id, tries = 0,
       due_at = excluded.due_at`,
    [...params, mergedPullRequestId, context.clock.now()],
  );
}

/**
 * After a merge into a base branch, asks for the other open Pull Requests on that branch linking a Ticket a conflict
 * would send back to be checked. Call it in the transaction that recorded the merge.
 */
export async function checkAfterMerge(context: Context, tx: Tx, mergedPullRequestId: number): Promise<void> {
  const { rows } = await tx.query<{ repositoryId: string; branch: string | null; sha: string | null }>(
    `select repository_id as "repositoryId", base_branch as branch, merge_commit_sha as sha from pull_requests where id = $1`,
    [mergedPullRequestId],
  );
  const merged = rows[0];
  if (!merged?.branch || !merged.sha) return;
  await queue(
    context,
    tx,
    "pull_requests.repository_id = $1 and pull_requests.base_branch = $2 and pull_requests.id <> $3",
    [merged.repositoryId, merged.branch, mergedPullRequestId],
    String(mergedPullRequestId),
  );
}

/**
 * Once an Outcome moved the Ticket into a Review Status, asks for its open Pull Requests to be checked, naming the
 * latest merge Cronk knows into each one's base branch. Call it in the transaction that moved the Ticket.
 */
async function checkTicketsPullRequests(context: Context, tx: Tx, ticketId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string; merged: string | null }>(
    `select pull_requests.id,
       (select merged.id from pull_requests merged
        where merged.repository_id = pull_requests.repository_id and merged.base_branch = pull_requests.base_branch
          and merged.state = 'merged' and merged.merge_commit_sha is not null
        order by merged.updated_at desc, merged.id desc limit 1) as merged
     from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
     where pull_request_links.ticket_id = $1 and pull_requests.state in ('open', 'draft')
     order by pull_requests.id`,
    [ticketId],
  );
  for (const { id, merged } of rows) await queue(context, tx, "pull_requests.id = $1", [id], merged);
}

/**
 * An Outcome moved the Ticket into a Review Status: a failure Cronk already knows on one of its open Pull Requests
 * sends it back; otherwise Cronk asks GitHub whether they conflict. Says whether a known failure sent it back. Call it
 * in the transaction that moved the Ticket, before a Run starts in the Review Status.
 */
export async function enteredReview(context: Context, tx: Tx, ticketId: string): Promise<boolean> {
  if (await sendBackForKnownFailures(context, tx, ticketId)) return true;
  await checkTicketsPullRequests(context, tx, ticketId);
  return false;
}

/** One Pull Request waiting to be asked about, as the pass that asks found it. */
interface Waiting {
  id: string;
  repositoryId: string;
  /** The Repository's `owner/name` as Cronk knows it now. */
  repository: string;
  number: number;
  url: string;
  tries: number;
  merge: { id: string; repository: string; number: number; url: string; sha: string } | null;
}

/**
 * Asks GitHub about each Pull Request waiting to be checked whose time has come. One that conflicts sends the Tickets
 * it links back; one GitHub is still working out, or couldn't answer about, is asked again shortly, until it has
 * been asked `maxTries` times.
 */
export async function checkMergeability(context: Context): Promise<void> {
  const { rows } = await context.db.query<Waiting>(
    `select pull_requests.id, pull_requests.repository_id as "repositoryId",
       coalesce(repositories.full_name, pull_requests.repository_full_name) as repository, pull_requests.number,
       pull_requests.url, mergeability_checks.tries,
       case when merged.id is null then null else json_build_object('id', merged.id::text,
         'repository', merged.repository_full_name, 'number', merged.number, 'url', merged.url, 'sha', merged.merge_commit_sha)
       end as merge
     from mergeability_checks
     join pull_requests on pull_requests.id = mergeability_checks.pull_request_id
     left join repositories on repositories.id = pull_requests.repository_id
     left join pull_requests merged on merged.id = mergeability_checks.merged_pull_request_id
     where mergeability_checks.due_at <= $1
     order by mergeability_checks.due_at, pull_requests.id`,
    [context.clock.now()],
  );
  for (const waiting of rows) {
    let answer: MergeabilityOnGitHub | undefined | null = null;
    try {
      const token = await tokenForRepository(context, Number(waiting.repositoryId));
      answer = token ? await pullRequestMergeability(context.config, token, waiting.repository, waiting.number) : undefined;
    } catch {
      // GitHub couldn't answer: asked again like an answer still being worked out.
    }
    await transaction(context.db, (tx) => settle(context, tx, waiting, answer));
  }
}

/** Applies GitHub's answer about a waiting Pull Request: `null` when it had none, `undefined` when it can't see it. */
async function settle(context: Context, tx: Tx, waiting: Waiting, answer: MergeabilityOnGitHub | undefined | null): Promise<void> {
  // A merge or Outcome asking afresh since this pass read it restarts it; this answer is then left for that one.
  const same = "pull_request_id = $1 and tries = $2 and merged_pull_request_id is not distinct from $3::bigint";
  const params = [waiting.id, waiting.tries, waiting.merge?.id ?? null];
  if (answer === null || answer?.mergeable === null) {
    if (waiting.tries + 1 < maxTries) {
      const due = new Date(context.clock.now().getTime() + askAgainAfterMs);
      await tx.query(`update mergeability_checks set tries = tries + 1, due_at = $4 where ${same}`, [...params, due]);
    } else {
      await tx.query(`delete from mergeability_checks where ${same}`, params);
    }
    return;
  }
  const { rowCount } = await tx.query(`delete from mergeability_checks where ${same}`, params);
  if (!rowCount || !answer || answer.mergeable) return;
  const pullRequest = { id: Number(waiting.id), repository: waiting.repository, number: waiting.number, url: waiting.url };
  const { merge } = waiting;
  const sent = await sendBackForFailure(context, tx, pullRequest, {
    kind: "conflict",
    branch: answer.base.ref,
    sha: merge?.sha ?? answer.base.sha,
    merge: merge && { repository: merge.repository, number: merge.number, url: merge.url },
  });
  if (!sent) return;
  // What last sent the Ticket back shows on its Pull Request.
  const { rows } = await tx.query<{ ticketId: string; projectId: string; workspaceId: string }>(
    `select tickets.id as "ticketId", tickets.project_id as "projectId", tickets.workspace_id as "workspaceId"
     from pull_request_links join tickets on tickets.id = pull_request_links.ticket_id
     where pull_request_links.pull_request_id = $1 and ${listsPullRequestsRepository}`,
    [waiting.id],
  );
  for (const { ticketId, projectId, workspaceId } of rows) {
    context.live.publish(tx, workspaceId, { type: "pull_requests.changed", projectId, ticketId });
  }
}
