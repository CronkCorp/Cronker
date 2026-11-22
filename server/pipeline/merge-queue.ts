import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import { userName } from "../identity/user.js";
import { requireWrite } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { statusesOf } from "../work/projects.js";
import { editTicketIn, findTicketRow, ticketNotFound, type Ticket } from "../work/tickets.js";
import { askMerge, linkedPullRequest, mergeAsAsked, type AskedMerge, type MergeAdvice } from "./pull-request-merging.js";

/**
 * Pipeline: the Merge Queue (ADR 0011, amending ADR 0005). A User with Write presses Merge on a Ticket in a Review
 * Status with an open linked Pull Request, in a Project with Pull Request automation on and a Merge Status (a Status
 * with a Merge Step): each of its open linked Pull Requests joins the queue for its own Repository and base branch, and
 * the Ticket moves into the Merge Status as the User's move. A queued Ticket gets no Merge Run. Each `queuePass` takes the head of each queue,
 * the entry that joined first, and asks Cronk's merge (`pull-request-merging.ts`) for it as the queuing User's; a head
 * that isn't clean and green yet waits for a later pass. A Ticket with several entries stays in the Merge Status until
 * the last of them merges, which completes it as Verified (`merges.ts`). One head per queue
 * is merged at a time, so queues on other branches or Repositories never wait on each other.
 *
 * An entry leaves the queue when its Ticket leaves the Merge Status it waits in (`ticket-writes.ts`), as Remove from
 * queue, a User's move or the merge completing it do, and when its Pull Request merges or closes on GitHub.
 *
 * Leaving the Merge Status takes all of a Ticket's entries out at once, so one Pull Request sending it back takes the
 * others with it. For now a head that conflicts, falls behind, fails its checks or that GitHub refuses waits (Merge
 * Queues 5 and 6).
 */

const rules = {
  merge: "Merge queues a Ticket in a Review Status with an open linked Pull Request, in a Project with Pull Request automation on and a Merge Status.",
  remove: "Only a Ticket in the Merge Queue can be removed from it, and not while Cronk is merging it.",
};

/** What the queue does instead of a merge Cronk refuses: nothing, as the head waits for a later pass. */
const waitAdvice: MergeAdvice = {
  sendBack: (why) => `It waits in the queue: ${why}.`,
  needsYou: (what) => `It waits in the queue for ${what}.`,
  readAgain: () => "It waits in the queue.",
};

/**
 * Merge: queues each of the Ticket's open linked Pull Requests, each in its own Repository's and base branch's queue,
 * and moves the Ticket into its Project's Merge Status, as
 * the User's move, refusing, naming the rule, as the module says.
 */
export async function joinQueue(context: Context, caller: Caller & { kind: "user" }, ticketId: string): Promise<Ticket> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, caller, ticket);
    const refuse = (code: string, message: string, advice: string) => new ApiError(409, code, message, { rule: rules.merge, advice });
    const statuses = await statusesOf(tx, ticket.projectId);
    const status = statuses.find((s) => s.id === ticket.statusId);
    if (status?.kind !== "review") {
      throw refuse("not_in_review", `${ticket.key} isn't in a Review Status, so it can't be merged from here.`, "Merge it once it reaches a Review Status, such as In Review.");
    }
    const { rows: projects } = await tx.query<{ automation: boolean }>(
      `select pull_request_automation as automation from projects where id = $1`,
      [ticket.projectId],
    );
    if (!projects[0]!.automation) {
      throw refuse(
        "pull_request_automation_off",
        `${ticket.key}'s Project has Pull Request automation off, so a merge wouldn't complete it.`,
        "Merge it on GitHub, or ask an Admin to turn Pull Request automation on.",
      );
    }
    const mergeStatus = statuses.find((s) => s.step?.kind === "merge");
    if (!mergeStatus) {
      throw refuse("no_merge_status", `${ticket.key}'s Project has no Merge Status, so it has no Merge Queue.`, "Merge it on GitHub, or give a Status of the board a Merge Step.");
    }
    const { rows: pullRequests } = await tx.query<{ id: string; repository: string; number: number; url: string }>(
      `select pull_requests.id::text, pull_requests.repository_full_name as repository, pull_requests.number, pull_requests.url
       from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
       join project_repositories on project_repositories.repository_id = pull_requests.repository_id
         and project_repositories.project_id = $2
       where pull_request_links.ticket_id = $1 and pull_requests.state = 'open'
         and not exists (select from merge_queue where merge_queue.pull_request_id = pull_requests.id)
       order by pull_request_links.linked_at, pull_requests.id`,
      [ticket.id, ticket.projectId],
    );
    if (pullRequests.length === 0) {
      throw refuse(
        "no_open_pull_request",
        `${ticket.key} has no open Pull Request of a Repository its Project lists, so there's nothing to merge.`,
        "Open a Pull Request naming its key, or mark a draft ready for review, then merge.",
      );
    }
    const now = context.clock.now();
    for (const pullRequest of pullRequests) {
      await tx.query(
        `insert into merge_queue (pull_request_id, ticket_id, status_id, queued_by_user_id, entered_at) values ($1, $2, $3, $4, $5)`,
        [pullRequest.id, ticket.id, mergeStatus.id, caller.id, now],
      );
    }
    await recordChanges(
      tx,
      ticket,
      caller.id,
      now,
      pullRequests.map((pullRequest) => ({ field: "queueJoined", from: null, to: { pullRequest: { ...pullRequest, id: Number(pullRequest.id) } } })),
    );
    return editTicketIn(context, tx, caller, ticket.id, { statusId: mergeStatus.id });
  });
}

/** Remove from queue: sends the queued Ticket back to its Project's first Review Status, as the User's move. */
export async function leaveQueue(context: Context, caller: Caller & { kind: "user" }, ticketId: string): Promise<Ticket> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, caller, ticket);
    const { rows } = await tx.query<{ state: string }>("select state from merge_queue where ticket_id = $1 for update", [ticket.id]);
    if (rows.length === 0) {
      throw new ApiError(409, "not_queued", `${ticket.key} isn't in the Merge Queue.`, { rule: rules.remove, advice: "Move it instead." });
    }
    if (rows.some((row) => row.state === "merging")) {
      throw new ApiError(409, "merging", `Cronk is merging ${ticket.key} now, so it can't leave the queue.`, {
        rule: rules.remove,
        advice: "Wait a moment: once the merge is done or refused, read the Ticket again.",
      });
    }
    const review = (await statusesOf(tx, ticket.projectId)).find((s) => s.kind === "review")!;
    return editTicketIn(context, tx, caller, ticket.id, { statusId: review.id });
  });
}

/**
 * Takes a Pull Request GitHub reports merged or closed out of the queue, recording a `queueLeft` Change by Cronk on
 * its Ticket unless the merge completed it already. Call it in the transaction that recorded GitHub's delivery.
 */
export async function dropFromQueue(context: Context, tx: Tx, pullRequestId: number): Promise<void> {
  const { rows } = await tx.query<{ ticketId: string; workspaceId: string; projectId: string; pullRequest: unknown }>(
    `with dropped as (delete from merge_queue where pull_request_id = $1 returning ticket_id)
     select tickets.id as "ticketId", tickets.workspace_id as "workspaceId", tickets.project_id as "projectId",
       json_build_object('id', pull_requests.id, 'repository', pull_requests.repository_full_name,
         'number', pull_requests.number, 'url', pull_requests.url) as "pullRequest"
     from dropped join tickets on tickets.id = dropped.ticket_id join pull_requests on pull_requests.id = $1`,
    [pullRequestId],
  );
  for (const { ticketId, workspaceId, projectId, pullRequest } of rows) {
    await recordChanges(tx, { id: ticketId, workspaceId }, { kind: "cronk" }, context.clock.now(), [
      { field: "queueLeft", from: { pullRequest }, to: null },
    ]);
    context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId });
  }
}

/** The head of one queue, as the pass read it. */
interface Head {
  pullRequestId: string;
  ticketId: string;
  state: "queued" | "merging";
  queuedBy: string;
}

/**
 * One pass of the Merge Queue: per Repository and base branch, asks Cronk's merge for the head, the entry that joined
 * first, unless it is already merging. A head Cronk's rules or GitHub refuse waits for a later pass. Heads of
 * Projects archived or with Pull Request automation off since wait too.
 */
export async function queuePass(context: Context): Promise<void> {
  const { rows: heads } = await context.db.query<Head>(
    `select distinct on (pull_requests.repository_id, coalesce(pull_requests.base_branch, ''))
       merge_queue.pull_request_id::text as "pullRequestId", merge_queue.ticket_id as "ticketId", merge_queue.state,
       merge_queue.queued_by_user_id as "queuedBy",
       projects.archived_at is null and projects.pull_request_automation as active
     from merge_queue join pull_requests on pull_requests.id = merge_queue.pull_request_id
     join tickets on tickets.id = merge_queue.ticket_id join projects on projects.id = tickets.project_id
     order by pull_requests.repository_id, coalesce(pull_requests.base_branch, ''), merge_queue.seq`,
  );
  for (const head of heads as (Head & { active: boolean })[]) {
    if (head.state !== "queued" || !head.active) continue;
    await mergeHead(context, head);
  }
}

/** Asks Cronk's merge for the head as its queuing User's, marking it *merging* while GitHub is asked. */
async function mergeHead(context: Context, head: Head): Promise<void> {
  const asked = await transaction(context.db, async (tx): Promise<AskedMerge | null> => {
    const { rows: tickets } = await tx.query<{ id: string; projectId: string; workspaceId: string; key: string }>(
      `select tickets.id, tickets.project_id as "projectId", tickets.workspace_id as "workspaceId",
         projects.key || '-' || tickets.number as key
       from tickets join projects on projects.id = tickets.project_id where tickets.id = $1 for update of tickets`,
      [head.ticketId],
    );
    const ticket = tickets[0];
    // Read again under the Ticket's lock: it may have left the queue since the pass read it.
    const { rowCount } = await tx.query(
      "select from merge_queue where pull_request_id = $1 and ticket_id = $2 and state = 'queued' for update",
      [head.pullRequestId, head.ticketId],
    );
    if (!ticket || !rowCount) return null;
    const pullRequest = await linkedPullRequest(tx, ticket, Number(head.pullRequestId));
    const { rows: users } = await tx.query<{ name: string }>(`select ${userName()} as name from users where id = $1`, [head.queuedBy]);
    if (!pullRequest || !users[0]) return null;
    let asked: AskedMerge;
    try {
      asked = await askMerge(tx, {
        ticket,
        pullRequest,
        actor: { kind: "user", userId: head.queuedBy, name: users[0].name, workspaceId: ticket.workspaceId },
        completeAs: "verified",
        viaQueue: true,
        advice: waitAdvice,
      });
    } catch (error) {
      if (error instanceof ApiError) return null;
      throw error;
    }
    await tx.query("update merge_queue set state = 'merging' where pull_request_id = $1", [head.pullRequestId]);
    context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    return asked;
  });
  if (!asked) return;
  try {
    // The merge takes its entry out of the queue, completing the Ticket when it was its last; whatever kept the entry
    // there, such as automation turned off meanwhile, the merged Pull Request leaves the queue all the same.
    await mergeAsAsked(context, asked, (tx) => dropFromQueue(context, tx, Number(head.pullRequestId)));
  } catch (error) {
    await transaction(context.db, async (tx) => {
      const { rows } = await tx.query<{ workspaceId: string; projectId: string }>(
        `update merge_queue set state = 'queued' from tickets
         where merge_queue.pull_request_id = $1 and merge_queue.state = 'merging' and tickets.id = merge_queue.ticket_id
         returning tickets.workspace_id as "workspaceId", tickets.project_id as "projectId"`,
        [head.pullRequestId],
      );
      for (const { workspaceId, projectId } of rows) {
        context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId: head.ticketId });
      }
    });
    if (!(error instanceof ApiError)) throw error;
  }
}
