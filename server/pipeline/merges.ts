import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { recordChanges, type ChangeActor } from "../work/changes.js";
import { statusesOf } from "../work/projects.js";
import { insertComment } from "../work/comment-writes.js";
import { awaitBackport, releaseMerge } from "./backports.js";
import { inUnarchivedProject, listsPullRequestsRepository, moveByCronk, type MovedTicket } from "./cronk-moves.js";

/**
 * Pipeline: a merged Pull Request completes the Tickets it links. Each linked Ticket not already in a Done or
 * Canceled Status, in a Project with Pull Request automation on that still lists the Pull Request's Repository,
 * moves to its Project's first Done Status as a move by Cronk: Verified when the merging GitHub account is a User
 * of the Ticket's Workspace, otherwise
 * Unverified. A merge someone asked Cronk for completes them as they asked, an Agent's Run asking for Unverified, as
 * that Agent in that Run, or that User, in their own Workspace. A User's own merge while a Run is running on the
 * Ticket completes them Unverified, as that Run's Agent's in that Run, so an agent merging with the User's credentials can't pass as the User vouching for the work. Other Pull Requests and
 * unfinished Sub-Tickets don't hold it back, and a Run running on it stops as if a User had moved it. Reopen then sends it back to the producing Step's Status, or, without one, leaves it.
 *
 * The exception is a merge the Merge Queue asked for, of one of several Pull Requests a Ticket has in the queue: it
 * records the merge and takes that Pull Request out of the queue, leaving the Ticket in its Merge Status until the last
 * of them merges. A merge outside the queue still completes the Ticket on its first merge.
 *
 * A Ticket tagged with a cut Release completes only once it has merged both on its release branch and on another
 * branch (`backports.ts`). A merge onto another branch after the Cut, in a Repository the Release was cut in, with none
 * on the release branch yet, moves it into, or leaves it in, its Merge Status, where a Run of the Merge Step backports
 * it; a merge onto the release branch with none elsewhere yet only records the merge. A Project with no Merge Status
 * gets no Backport, its Tickets completing as any other.
 */

/** The merge as GitHub reported it, or as an Agent's Run asked Cronk for it. */
export interface Merge {
  pullRequest: { id: number; repository: string; number: number; title: string; url: string };
  /** The GitHub account GitHub says merged it, if it named one. */
  mergedBy: { id: number; login: string } | null;
  /** Whether GitHub merged it itself, by auto-merge, whoever turned that on. */
  autoMerged: boolean;
  /**
   * The Agent whose Run asked Cronk for the merge, and that Run's Workspace: the Changes on its Tickets are the
   * Agent's, in that Run, and on other Workspaces' Tickets Cronk's, naming no Agent of another Workspace.
   */
  byAgent?: { id: string; name: string; runId: string | null; workspaceId: string };
  /**
   * The User who asked Cronk for the merge, and the Workspace they asked in: the Changes on its Tickets are the
   * User's, and on other Workspaces' Tickets Cronk's.
   */
  byUser?: { id: string; name: string; workspaceId: string };
  /** How it completes the Tickets, when Cronk was asked for it; otherwise by who merged it, as above. */
  verification?: "verified" | "unverified";
  /** Whether the Merge Queue asked Cronk for it: a Ticket with other Pull Requests still queued then waits for them. */
  viaQueue?: boolean;
  /** When GitHub merged it, if it said; otherwise now. */
  mergedAt?: Date;
}

/** Completes the Tickets the merged Pull Request links. Call it in the transaction that recorded the merge. */
export async function completeMergedTickets(context: Context, tx: Tx, merge: Merge): Promise<void> {
  const { pullRequest, mergedBy } = merge;
  const { rows: tickets } = await tx.query<
    MovedTicket & {
      doneStatusId: string;
      producingStatusId: string | null;
      produced: boolean;
      byMember: boolean;
      running: { agentId: string; runId: string } | null;
    }
  >(
    `select tickets.id, projects.key || '-' || tickets.number as key, tickets.workspace_id as "workspaceId",
       tickets.project_id as "projectId", tickets.status_id as "statusId", tickets.verification,
       (select id from statuses done where done.project_id = tickets.project_id and done.kind = 'done'
        order by done.position limit 1) as "doneStatusId",
       runs.status_id as "producingStatusId", runs.id is not null as produced,
       exists (select 1 from memberships join users on users.id = memberships.user_id
               where memberships.workspace_id = tickets.workspace_id and users.github_id = $2) as "byMember",
       (select json_build_object('agentId', running.agent_id, 'runId', running.id) from runs running
        where running.ticket_id = tickets.id and running.state = 'running') as running
     from pull_request_links
     join tickets on tickets.id = pull_request_links.ticket_id
     join projects on projects.id = tickets.project_id
     join statuses on statuses.id = tickets.status_id
     left join runs on runs.id = pull_request_links.producing_run_id
     where pull_request_links.pull_request_id = $1 and projects.pull_request_automation
       and statuses.kind not in ('done', 'canceled')
       and ${listsPullRequestsRepository} and ${inUnarchivedProject}
     order by tickets.id
     for update of tickets`,
    [pullRequest.id, mergedBy?.id ?? null],
  );
  const name = `${pullRequest.repository}#${pullRequest.number}`;
  const { byAgent, byUser } = merge;
  const askedOfCronk = byAgent ?? byUser;
  for (const { doneStatusId, producingStatusId, produced, byMember, running, ...ticket } of tickets) {
    const agentsOwn = byAgent?.workspaceId === ticket.workspaceId;
    const usersOwn = byMember && !merge.autoMerged && !askedOfCronk;
    // A User's own merge while a Run is running on the Ticket may be that Run's Agent using the User's credentials:
    // it counts as the Run's Agent's, in that Run, and never vouches for the work.
    const asRunsAgent = usersOwn && running !== null;
    const by: ChangeActor =
      byAgent && agentsOwn
        ? { kind: "agent", id: byAgent.id, runId: byAgent.runId }
        : byUser?.workspaceId === ticket.workspaceId
          ? byUser.id
          : asRunsAgent
            ? { kind: "agent", id: running.agentId, runId: running.runId }
            : { kind: "cronk" };
    const merger = askedOfCronk
      ? askedOfCronk.workspaceId === ticket.workspaceId
        ? askedOfCronk.name
        : "Cronk"
      : mergedBy
        ? `@${mergedBy.login}`
        : "GitHub";
    const merged = { field: "merged" as const, from: null, to: { pullRequest, mergedBy: mergedBy?.login ?? null } };
    if (merge.viaQueue && (await othersQueued(tx, ticket.id, pullRequest.id))) {
      // Not its last queued Pull Request: the Ticket waits in the queue for the others, this one leaving it merged.
      await tx.query("delete from merge_queue where ticket_id = $1 and pull_request_id = $2", [ticket.id, pullRequest.id]);
      await recordChanges(tx, ticket, by, context.clock.now(), [merged]);
      context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
      continue;
    }
    // A Ticket of a cut Release completes once merged both on its release branch and elsewhere.
    const now = context.clock.now();
    const released = await releaseMerge(tx, ticket.id, pullRequest.id, merge.mergedAt ?? now);
    if (released && released.onReleaseBranch && !released.mergedElsewhere) {
      await recordChanges(tx, ticket, by, now, [merged]);
      context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
      continue;
    }
    const mergeStatus = (await statusesOf(tx, ticket.projectId)).find((s) => s.step?.kind === "merge");
    if (released && !released.onReleaseBranch && released.afterCut && !released.mergedOnReleaseBranch && mergeStatus) {
      const { release } = released;
      await moveByCronk(context, tx, ticket, {
        target: { kind: "status", statusId: mergeStatus.id, completedFrom: null },
        by,
        stopReason: `${merger} merged ${name} after ${release.name} was cut, so ${ticket.key} waits in ${mergeStatus.name} for a backport onto ${release.branch}.`,
        verification: "unverified",
        beforeMove: async (_decision, at) => {
          await recordChanges(tx, ticket, by, at, [merged]);
          await awaitBackport(tx, ticket, release.id, mergeStatus.id, pullRequest.id, at);
          await insertComment(
            context,
            tx,
            ticket,
            { kind: "cronk" },
            `[${name}](${pullRequest.url}) merged after ${release.name} was cut, so ${ticket.key} waits in ` +
              `${mergeStatus.name} until its change also merges into \`${release.branch}\`: a Run of ${mergeStatus.name} ` +
              "backports it.",
            null,
          );
        },
      });
      continue;
    }
    await moveByCronk(context, tx, ticket, {
      target: { kind: "status", statusId: doneStatusId, completedFrom: producingStatusId, withoutStep: !produced },
      by,
      stopReason: `${merger} merged ${name}, completing ${ticket.key}.`,
      // Only a User of the Ticket's Workspace merging it themselves, with no Run running on it, vouches for the work;
      // an agent's merge never does. A merge Cronk was asked for completes them as asked.
      verification: merge.verification ?? (usersOwn && running === null ? "verified" : "unverified"),
      pullRequestId: pullRequest.id,
      // Recorded at the move's time, ahead of the Changes moving it.
      beforeMove: async (_decision, now) => {
        await recordChanges(tx, ticket, by, now, [merged]);
      },
    });
  }
}

/** Whether the Ticket has Pull Requests in the Merge Queue other than this one. */
async function othersQueued(tx: Tx, ticketId: string, pullRequestId: number): Promise<boolean> {
  const { rowCount } = await tx.query("select from merge_queue where ticket_id = $1 and pull_request_id <> $2 limit 1", [
    ticketId,
    pullRequestId,
  ]);
  return (rowCount ?? 0) > 0;
}
