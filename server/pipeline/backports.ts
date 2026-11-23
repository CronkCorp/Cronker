import type { Context } from "../context.js";
import type { Db, Tx } from "../db.js";
import { recordChanges } from "../work/changes.js";
import { insertComment } from "../work/comment-writes.js";
import { statusesOf, type Status } from "../work/projects.js";
import type { Outcome, Step } from "../work/steps.js";
import { moveByCronk } from "./cronk-moves.js";
import { compareCommits } from "../github/client.js";
import { installationCovering, tokenFor } from "../github/installations.js";
import { ApiError } from "../http/errors.js";

/**
 * Pipeline: Backports (the Releases spec). A Ticket tagged with a cut Release whose Pull Request merges into another
 * branch than the release branch after the Cut, in a Repository the Release was cut in, doesn't complete: it waits in
 * its Merge Status (`merges.ts`), and a Run of the Merge Step starts whatever the Step's rule says, as for a conflict
 * (`runs.ts`). Its Brief names the Release, the release branch and the merge commit. The Run cherry-picks the merge
 * onto a branch off `release/<name>`, opens a Pull Request against it naming the Ticket's key, and finishes with
 * *backported*. Once that Pull Request links, it joins the release branch's Merge Queue as queued by whoever queued
 * the first one, so its merge completes the Ticket Verified or Unverified as before; with nobody to queue it, the first
 * having merged on GitHub outside the queue, the Ticket goes to its first Review Status for a User to press Merge.
 *
 * A Ticket of a cut Release completes only once it has a merged Pull Request on its release branch and one on another
 * branch, whichever merges last. A User tagging a completed Ticket with a cut Release likewise moves it into its Merge
 * Status to backport its merge, when GitHub says that merge isn't in the release branch's cut commit
 * (`backportOnTagging`), as queued by that User. Leaving the Merge Status, as completing it, sending it back or a User's move do, drops
 * the Backport's record, as it does queue entries (`ticket-writes.ts`).
 */

export type BackportState = "backporting" | "backported";

/** What a Ticket waiting in its Merge Status for a Backport waits for. */
export interface Backport {
  state: BackportState;
  release: { id: string; name: string };
  branch: string;
  statusId: string;
  /** The merge to backport. */
  pullRequest: { id: number; repository: string; number: number; url: string };
  /** The merge commit, once GitHub named it. */
  mergeCommit: string | null;
  queuedBy: { userId: string | null; agentId: string | null };
}

/** The Ticket's Backport, if it waits for one. */
export async function backportOf(tx: Db | Tx, ticketId: string): Promise<Backport | null> {
  const { rows } = await tx.query<Backport>(
    `select b.state, json_build_object('id', releases.id, 'name', releases.name) as release,
       'release/' || releases.name as branch, b.status_id as "statusId",
       json_build_object('id', pull_requests.id, 'repository', pull_requests.repository_full_name,
         'number', pull_requests.number, 'url', pull_requests.url) as "pullRequest",
       coalesce(pull_requests.merge_commit_sha, pull_requests.answered_merge_sha) as "mergeCommit",
       json_build_object('userId', b.queued_by_user_id, 'agentId', b.queued_by_agent_id) as "queuedBy"
     from ticket_backports b join releases on releases.id = b.release_id
     join pull_requests on pull_requests.id = b.pull_request_id
     where b.ticket_id = $1`,
    [ticketId],
  );
  return rows[0] ?? null;
}

/**
 * The Merge Step's Outcome a Run backporting a merge finishes with once it opened the Backport: the one named
 * *backported* that leaves the Ticket in the Merge Status.
 */
export function backportingOutcome(status: Pick<Status, "id"> & { step: Step | null }): Outcome | undefined {
  if (status.step?.kind !== "merge") return undefined;
  return status.step.outcomes.find((o) => o.statusId === status.id && o.name.toLowerCase() === "backported");
}

/** What Cronk knows of a Ticket's Release and Pull Requests, deciding whether a merge completes it. */
export interface ReleaseMerge {
  release: { id: string; name: string; branch: string };
  /** Whether the merged Pull Request is on the release branch. */
  onReleaseBranch: boolean;
  /** Whether the merged Pull Request's Repository was cut, and its merge came after the Cut. */
  afterCut: boolean;
  /** Whether the Ticket has a merged Pull Request on the release branch, this one included. */
  mergedOnReleaseBranch: boolean;
  /** Whether the Ticket has a merged Pull Request on another branch, this one included. */
  mergedElsewhere: boolean;
}

/**
 * The Ticket's cut Release and how the merged Pull Request stands to it; null when it has none, so the merge completes
 * it as it would any Ticket. `mergedAt` is when GitHub merged it.
 */
export async function releaseMerge(tx: Tx, ticketId: string, pullRequestId: number, mergedAt: Date): Promise<ReleaseMerge | null> {
  const { rows } = await tx.query<ReleaseMerge>(
    `select json_build_object('id', releases.id, 'name', releases.name, 'branch', 'release/' || releases.name) as release,
       coalesce(merged.base_branch = 'release/' || releases.name, false) as "onReleaseBranch",
       (releases.cut_at < $3 and exists (select from release_repositories
          where release_repositories.release_id = releases.id and release_repositories.repository_id = merged.repository_id))
         as "afterCut",
       exists (select from pull_request_links join pull_requests linked on linked.id = pull_request_links.pull_request_id
         where pull_request_links.ticket_id = tickets.id and linked.state = 'merged'
           and linked.base_branch = 'release/' || releases.name) as "mergedOnReleaseBranch",
       exists (select from pull_request_links join pull_requests linked on linked.id = pull_request_links.pull_request_id
         where pull_request_links.ticket_id = tickets.id and linked.state = 'merged'
           and linked.base_branch <> 'release/' || releases.name) as "mergedElsewhere"
     from tickets join releases on releases.id = tickets.release_id
     join pull_requests merged on merged.id = $2
     where tickets.id = $1 and releases.state = 'cut'`,
    [ticketId, pullRequestId, mergedAt],
  );
  return rows[0] ?? null;
}

/**
 * Records that the Ticket waits in its Merge Status `statusId` for a Backport of the merged Pull Request, queued by
 * whoever queued that one, if anyone did, taking it out of the queue, or by `queuedBy` when given. Call it in the
 * transaction that locked the Ticket, once it is in the Merge Status or just before it moves there by Cronk.
 */
export async function awaitBackport(
  tx: Tx,
  ticket: { id: string; workspaceId: string },
  releaseId: string,
  statusId: string,
  pullRequestId: number,
  now: Date,
  queuedBy?: { userId: string },
): Promise<void> {
  const { rows: queued } = await tx.query<{ userId: string | null; agentId: string | null }>(
    `delete from merge_queue where ticket_id = $1 and pull_request_id = $2
     returning queued_by_user_id as "userId", queued_by_agent_id as "agentId"`,
    [ticket.id, pullRequestId],
  );
  const rows = queuedBy ? [{ userId: queuedBy.userId, agentId: null }] : queued;
  await tx.query(
    `insert into ticket_backports (ticket_id, workspace_id, release_id, status_id, pull_request_id, queued_by_user_id,
       queued_by_agent_id, state, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'backporting', $8)
     on conflict (ticket_id) do update set release_id = excluded.release_id, status_id = excluded.status_id,
       pull_request_id = excluded.pull_request_id, queued_by_user_id = excluded.queued_by_user_id,
       queued_by_agent_id = excluded.queued_by_agent_id, state = 'backporting', created_at = excluded.created_at`,
    [ticket.id, ticket.workspaceId, releaseId, statusId, pullRequestId, rows[0]?.userId ?? null, rows[0]?.agentId ?? null, now],
  );
}

/** The merge a completed Ticket just tagged with a cut Release needs backported, and the Merge Status it waits in. */
export interface TaggedBackport {
  release: { id: string; name: string; branch: string };
  pullRequestId: number;
  mergeCommit: string;
  mergeStatus: { id: string; name: string };
}

/**
 * Whether a completed Ticket tagged with the cut Release needs a Backport: its merged Pull Request on another branch
 * than the release branch, in a Repository the Release was cut in, whose merge commit GitHub's compare says isn't in
 * the release branch's cut commit. Null, for a tag only, when the Project's Pull Request automation is off, it has no
 * Merge Status, the Ticket already merged onto the release branch, or has no such merge, or every merge is in the Cut.
 * Asks GitHub as the App, in the transaction that locked the Ticket; GitHub failing refuses the tag, so the User tries
 * again rather than the backport being skipped.
 */
export async function backportOnTagging(
  context: Context,
  tx: Tx,
  ticket: { id: string; key: string; projectId: string },
  releaseId: string,
): Promise<TaggedBackport | null> {
  const { rows: releases } = await tx.query<{ name: string; automation: boolean }>(
    `select releases.name, projects.pull_request_automation as automation from releases
     join projects on projects.id = releases.project_id where releases.id = $1 and releases.state = 'cut'`,
    [releaseId],
  );
  const release = releases[0];
  if (!release?.automation) return null;
  const mergeStatus = (await statusesOf(tx, ticket.projectId)).find((s) => s.step?.kind === "merge");
  if (!mergeStatus) return null;
  const branch = `release/${release.name}`;
  const { rows: merges } = await tx.query<{
    id: string;
    repositoryId: string;
    fullName: string;
    sha: string | null;
    cutSha: string | null;
    onReleaseBranch: boolean;
  }>(
    `select pull_requests.id::text, pull_requests.repository_id::text as "repositoryId",
       pull_requests.repository_full_name as "fullName",
       coalesce(pull_requests.merge_commit_sha, pull_requests.answered_merge_sha) as sha,
       release_repositories.cut_sha as "cutSha", pull_requests.base_branch = $3 as "onReleaseBranch"
     from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
     left join release_repositories on release_repositories.release_id = $2
       and release_repositories.repository_id = pull_requests.repository_id
     where pull_request_links.ticket_id = $1 and pull_requests.state = 'merged'
     order by pull_requests.updated_at desc, pull_requests.id desc`,
    [ticket.id, releaseId, branch],
  );
  // Already merged onto the release branch: the change is in the Release.
  if (merges.some((m) => m.onReleaseBranch)) return null;
  for (const merge of merges) {
    if (!merge.sha || !merge.cutSha) continue;
    const repositoryId = Number(merge.repositoryId);
    const installationId = await installationCovering(context, repositoryId);
    if (installationId === undefined) {
      throw new ApiError(409, "repository_not_installed", `The GitHub App can't reach ${merge.fullName}, so Cronk can't tell whether ${ticket.key}'s merge is in ${branch}.`, {
        rule: "Tagging a completed Ticket with a cut Release asks GitHub whether its merge is already in the release branch.",
        advice: `Install the GitHub App on ${merge.fullName}, then tag ${ticket.key} again.`,
      });
    }
    const token = await tokenFor(context, installationId);
    const compared = await compareCommits(context.config, token, merge.fullName, merge.sha, merge.cutSha);
    // Only `identical` or `ahead` put the merge in the cut commit's history; GitHub not knowing a commit doesn't.
    if (compared === "identical" || compared === "ahead") continue;
    return {
      release: { id: releaseId, name: release.name, branch },
      pullRequestId: Number(merge.id),
      mergeCommit: merge.sha, mergeStatus: { id: mergeStatus.id, name: mergeStatus.name },
    };
  }
  return null;
}

/**
 * A Run backporting a merge finished with *backported*: the Ticket waits for its Backport to link. Call it in the
 * transaction that locked the Ticket.
 */
export async function backported(context: Context, tx: Tx, ticket: { id: string; workspaceId: string; projectId: string }): Promise<void> {
  const { rowCount } = await tx.query("update ticket_backports set state = 'backported' where ticket_id = $1 and state = 'backporting'", [ticket.id]);
  if (rowCount) context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
}

/**
 * Queues the Backports of each of the Tickets that were backported and wait for them: their open linked Pull Requests
 * on their release branch, of a Repository their Project lists, join the release branch's Merge Queue as queued by
 * whoever queued the first Pull Request, recording a `queueJoined` Change by Cronk. A Ticket whose first Pull Request
 * nobody queued goes to its first Review Status instead, with Cronk's Comment, for a User to press Merge.
 */
export async function queueBackports(context: Context, tx: Tx, ticketIds: string[]): Promise<void> {
  if (ticketIds.length === 0) return;
  const { rows: tickets } = await tx.query<{
    id: string;
    key: string;
    workspaceId: string;
    projectId: string;
    statusId: string;
    verification: "unverified" | "verified" | null;
  }>(
    `select tickets.id, projects.key || '-' || tickets.number as key, tickets.workspace_id as "workspaceId",
       tickets.project_id as "projectId", tickets.status_id as "statusId", tickets.verification
     from tickets join projects on projects.id = tickets.project_id
     join ticket_backports b on b.ticket_id = tickets.id and b.state = 'backported' and b.status_id = tickets.status_id
     where tickets.id = any($1::uuid[]) and projects.pull_request_automation and projects.archived_at is null
     order by tickets.id
     for update of tickets`,
    [ticketIds],
  );
  for (const ticket of tickets) {
    const backport = (await backportOf(tx, ticket.id))!;
    const { rows: pullRequests } = await tx.query<{ id: string; repository: string; number: number; url: string }>(
      `select pull_requests.id::text, pull_requests.repository_full_name as repository, pull_requests.number, pull_requests.url
       from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
       join project_repositories on project_repositories.repository_id = pull_requests.repository_id
         and project_repositories.project_id = $2
       where pull_request_links.ticket_id = $1 and pull_requests.state = 'open' and pull_requests.base_branch = $3
         and not exists (select from merge_queue where merge_queue.pull_request_id = pull_requests.id)
       order by pull_request_links.linked_at, pull_requests.id`,
      [ticket.id, ticket.projectId, backport.branch],
    );
    if (pullRequests.length === 0) continue;
    const now = context.clock.now();
    const { userId, agentId } = backport.queuedBy;
    if (!userId && !agentId) {
      const review = (await statusesOf(tx, ticket.projectId)).find((s) => s.kind === "review");
      if (!review) continue;
      const named = pullRequests.map((p) => `[${p.repository}#${p.number}](${p.url})`).join(", ");
      await insertComment(
        context,
        tx,
        ticket,
        { kind: "cronk" },
        `${named} backports ${ticket.key} onto \`${backport.branch}\`. Nobody queued its first Pull Request, which merged ` +
          `on GitHub, so ${ticket.key} moves to ${review.name}: press **Merge** to queue the backport.`,
        null,
      );
      await moveByCronk(context, tx, ticket, {
        target: { kind: "status", statusId: review.id, completedFrom: null },
        by: { kind: "cronk" },
        verification: "unverified",
      });
      continue;
    }
    for (const pullRequest of pullRequests) {
      await tx.query(
        `insert into merge_queue (pull_request_id, ticket_id, status_id, queued_by_user_id, queued_by_agent_id, entered_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [pullRequest.id, ticket.id, backport.statusId, userId, userId ? null : agentId, now],
      );
    }
    await recordChanges(
      tx,
      ticket,
      { kind: "cronk" },
      now,
      pullRequests.map((p) => ({ field: "queueJoined", from: null, to: { pullRequest: { ...p, id: Number(p.id) } } }) as const),
    );
    context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  }
}

/** The Tickets the Pull Request links that were backported and wait for their Backport. */
export async function ticketsAwaitingBackport(tx: Tx, pullRequestId: number): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `select pull_request_links.ticket_id as id from pull_request_links
     join ticket_backports b on b.ticket_id = pull_request_links.ticket_id and b.state = 'backported'
     where pull_request_links.pull_request_id = $1 order by pull_request_links.ticket_id`,
    [pullRequestId],
  );
  return rows.map((row) => row.id);
}
