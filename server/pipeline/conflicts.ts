import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { pullRequestOnGitHub } from "../github/client.js";
import { installationCovering, tokenFor } from "../github/installations.js";
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
const askAgainAfterMs = 10_000;

/** How many times Cronk asks about one Pull Request before giving up until the next merge or Outcome asks again. */
const maxTries = 6;

/** What GitHub said, asked whether a Pull Request merges cleanly into its base branch. */
export type Mergeability =
  /** GitHub answered: `mergeable` is null while it is still working it out. */
  | { kind: "answered"; mergeable: boolean | null; base: { ref: string; sha: string } }
  /** GitHub couldn't be reached or refused. */
  | { kind: "unanswered" }
  /** No installation of the App can see the Pull Request. */
  | { kind: "unseen" };

/**
 * Asks GitHub whether the Pull Request, by its Repository's id and `owner/name` and its number, merges cleanly into its
 * base branch. Asking is what starts GitHub working it out, so a first answer is often null. It reads the same
 * `pullRequestOnGitHub` answer through the same installation as the Merge Step's `merge_pull_request` does
 * (`runs/merging.ts`), so both judge a conflict alike.
 */
export async function askMergeability(
  context: Context,
  pullRequest: { repositoryId: number; repository: string; number: number },
): Promise<Mergeability> {
  try {
    const installationId = await installationCovering(context, pullRequest.repositoryId);
    if (installationId === undefined) return { kind: "unseen" };
    const token = await tokenFor(context, installationId);
    const answer = await pullRequestOnGitHub(context.config, token, pullRequest.repository, pullRequest.number);
    if (!answer || typeof answer.base?.ref !== "string" || typeof answer.base.sha !== "string") return { kind: "unseen" };
    return { kind: "answered", mergeable: typeof answer.mergeable === "boolean" ? answer.mergeable : null, base: answer.base };
  } catch {
    return { kind: "unanswered" };
  }
}

/**
 * SQL condition, for a query over `pull_requests`: the Pull Request links a Ticket that a conflict would send back,
 * one in a Review Status with a producing Step, in a Project with Pull Request automation on that lists its Repository.
 * `sendBackForFailure` applies the same rule when the answer comes; this only spares GitHub the other asks.
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
async function queue(context: Context, tx: Tx, where: string, params: unknown[], mergedPullRequestId: number | null): Promise<void> {
  const mergedParam = `$${params.length + 1}`;
  const nowParam = `$${params.length + 2}`;
  await tx.query(
    `insert into mergeability_checks (pull_request_id, merged_pull_request_id, tries, due_at)
     select pull_requests.id, ${mergedParam}::bigint, 0, ${nowParam} from pull_requests
     where pull_requests.state in ('open', 'draft') and ${linksTicketToSendBack} and ${where}
     on conflict (pull_request_id) do update set merged_pull_request_id = excluded.merged_pull_request_id, tries = 0,
       due_at = excluded.due_at, generation = mergeability_checks.generation + 1`,
    [...params, mergedPullRequestId, context.clock.now()],
  );
}

/**
 * After a merge into a base branch, asks for the other open Pull Requests on that branch linking a Ticket a conflict
 * would send back to be checked, and those whose base branch Cronk wasn't told. Call it in the transaction that
 * recorded the merge.
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
    `pull_requests.repository_id = $1 and (pull_requests.base_branch = $2 or pull_requests.base_branch is null)
       and pull_requests.id <> $3`,
    [merged.repositoryId, merged.branch, mergedPullRequestId],
    mergedPullRequestId,
  );
}

/**
 * An Outcome moved the Ticket into a Review Status: a failure Cronk already knows on one of its open Pull Requests
 * sends it back, and this says so; otherwise Cronk is to ask GitHub whether they conflict. Call it in the
 * transaction that moved the Ticket, before a Run starts in the Review Status.
 */
export async function sendBackOnEnteringReview(context: Context, tx: Tx, ticketId: string): Promise<boolean> {
  if (await sendBackForKnownFailures(context, tx, ticketId)) return true;
  await queue(
    context,
    tx,
    "exists (select from pull_request_links where pull_request_id = pull_requests.id and ticket_id = $1)",
    [ticketId],
    null,
  );
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
  /** Its base branch, if Cronk was told it. */
  branch: string | null;
  generation: number;
  tries: number;
  /** The merge that had Cronk ask, if one did. */
  merge: { id: string; repository: string; number: number; url: string; branch: string; sha: string } | null;
}

/**
 * Asks GitHub about each Pull Request waiting to be checked whose time has come. One that conflicts sends the Tickets
 * it links back; one GitHub is still working out, couldn't answer about, or answered for the base before the merge
 * that had Cronk ask, is asked again shortly, until it has been asked `maxTries` times.
 */
export async function checkMergeability(context: Context): Promise<void> {
  const { rows } = await context.db.query<Waiting>(
    `select pull_requests.id, pull_requests.repository_id as "repositoryId",
       coalesce(repositories.full_name, pull_requests.repository_full_name) as repository, pull_requests.number,
       pull_requests.url, pull_requests.base_branch as branch, mergeability_checks.generation, mergeability_checks.tries,
       case when merged.id is null then null else json_build_object('id', merged.id::text,
         'repository', merged.repository_full_name, 'number', merged.number, 'url', merged.url,
         'branch', merged.base_branch, 'sha', merged.merge_commit_sha)
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
    const asked = await askMergeability(context, { ...waiting, repositoryId: Number(waiting.repositoryId) });
    await transaction(context.db, (tx) => settle(context, tx, waiting, asked));
  }
}

/** Applies GitHub's answer about a waiting Pull Request. */
async function settle(context: Context, tx: Tx, waiting: Waiting, asked: Mergeability): Promise<void> {
  // A merge or Outcome asking afresh since this pass read it starts a new generation; this answer is then left for that one.
  const stillThisAsk = "pull_request_id = $1 and generation = $2 and tries = $3";
  const params = [waiting.id, waiting.generation, waiting.tries];
  // A merge into another branch than the one GitHub says the Pull Request targets has nothing to do with it.
  const merge = asked.kind === "answered" && waiting.merge?.branch !== asked.base.ref ? null : waiting.merge;
  if (asked.kind === "answered" && !waiting.branch) {
    await tx.query("update pull_requests set base_branch = $2 where id = $1 and base_branch is null", [waiting.id, asked.base.ref]);
  }
  // Right after a merge GitHub may still answer as it worked mergeability out against the base before it.
  const undecided =
    asked.kind === "unanswered" ||
    (asked.kind === "answered" &&
      (asked.mergeable === null || (asked.mergeable && merge && merge.sha !== asked.base.sha)));
  if (undecided) {
    if (waiting.tries + 1 < maxTries) {
      const due = new Date(context.clock.now().getTime() + askAgainAfterMs);
      await tx.query(`update mergeability_checks set tries = tries + 1, due_at = $4 where ${stillThisAsk}`, [...params, due]);
    } else {
      await tx.query(`delete from mergeability_checks where ${stillThisAsk}`, params);
    }
    return;
  }
  const { rowCount } = await tx.query(`delete from mergeability_checks where ${stillThisAsk}`, params);
  if (!rowCount || asked.kind !== "answered" || asked.mergeable) return;
  // Without a merge that had Cronk ask, the merge named is one whose commit GitHub compared against, if Cronk knows it.
  const named =
    merge ??
    (
      await tx.query<{ repository: string; number: number; url: string; sha: string }>(
        `select repository_full_name as repository, number, url, merge_commit_sha as sha from pull_requests
         where repository_id = $1 and state = 'merged' and merge_commit_sha = $2 order by id limit 1`,
        [waiting.repositoryId, asked.base.sha],
      )
    ).rows[0];
  const pullRequest = { id: Number(waiting.id), repository: waiting.repository, number: waiting.number, url: waiting.url };
  const sent = await sendBackForFailure(context, tx, pullRequest, {
    kind: "conflict",
    branch: asked.base.ref,
    sha: named?.sha ?? asked.base.sha,
    merge: named ? { repository: named.repository, number: named.number, url: named.url } : null,
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
