import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { recordChanges } from "../work/changes.js";
import { moveByCronk, type MovedTicket } from "./cronk-moves.js";

/**
 * Pipeline: a merged Pull Request completes the Tickets it links. Each linked Ticket not already in a Done or
 * Canceled Status, in a Project with Pull Request automation on, moves to its Project's first Done Status as a
 * move by Cronk: Verified when the merging GitHub account is a User of the Ticket's Workspace, otherwise
 * Unverified. Other Pull Requests and unfinished Sub-Tickets don't hold it back, and a Run running on it stops
 * as if a User had moved it. Reopen then sends it back to the producing Step's Status, or, without one, leaves it.
 */

/** The merge as GitHub reported it. */
export interface Merge {
  pullRequest: { id: number; repository: string; number: number; title: string; url: string };
  /** The GitHub account GitHub says merged it, if it named one. */
  mergedBy: { id: number; login: string } | null;
  /** Whether GitHub merged it itself, by auto-merge, whoever turned that on. */
  autoMerged: boolean;
}

/** Completes the Tickets the merged Pull Request links. Call it in the transaction that recorded the merge. */
export async function completeMergedTickets(context: Context, tx: Tx, merge: Merge): Promise<void> {
  const { pullRequest, mergedBy } = merge;
  const { rows: tickets } = await tx.query<
    MovedTicket & { doneStatusId: string; producingStatusId: string | null; produced: boolean; byMember: boolean }
  >(
    `select tickets.id, projects.key || '-' || tickets.number as key, tickets.workspace_id as "workspaceId",
       tickets.project_id as "projectId", tickets.status_id as "statusId", tickets.verification,
       (select id from statuses done where done.project_id = tickets.project_id and done.kind = 'done'
        order by done.position limit 1) as "doneStatusId",
       runs.status_id as "producingStatusId", runs.id is not null as produced,
       exists (select 1 from memberships join users on users.id = memberships.user_id
               where memberships.workspace_id = tickets.workspace_id and users.github_id = $2) as "byMember"
     from pull_request_links
     join tickets on tickets.id = pull_request_links.ticket_id
     join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     left join runs on runs.id = pull_request_links.producing_run_id
     where pull_request_links.pull_request_id = $1 and projects.pull_request_automation
       and statuses.kind not in ('done', 'canceled')
     order by tickets.id
     for update of tickets`,
    [pullRequest.id, mergedBy?.id ?? null],
  );
  const name = `${pullRequest.repository}#${pullRequest.number}`;
  const merger = mergedBy ? `@${mergedBy.login}` : "GitHub";
  for (const { doneStatusId, producingStatusId, produced, byMember, ...ticket } of tickets) {
    await moveByCronk(context, tx, ticket, {
      target: { kind: "status", statusId: doneStatusId, completedFrom: producingStatusId, withoutStep: !produced },
      by: { kind: "cronk" },
      stopReason: `${merger} merged ${name}, completing ${ticket.key}.`,
      // Only a User of the Ticket's Workspace merging it themselves vouches for the work.
      verification: byMember && !merge.autoMerged ? "verified" : "unverified",
      pullRequestId: pullRequest.id,
      // Recorded at the move's time, ahead of the Changes moving it.
      beforeMove: async (_decision, now) => {
        await recordChanges(tx, ticket, { kind: "cronk" }, now, [
          { field: "merged", from: null, to: { pullRequest, mergedBy: mergedBy?.login ?? null } },
        ]);
      },
    });
  }
}
