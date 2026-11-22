import type { Context } from "../context.js";
import { afterCommit, transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import { userName } from "../identity/user.js";
import { requireWrite } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { statusesOf } from "../work/projects.js";
import { editTicketIn, findTicketRow, ticketNotFound, type Ticket } from "../work/tickets.js";
import { moveByCronk } from "./cronk-moves.js";
import {
  askMerge,
  behindCode,
  GitHubRefusedMerge,
  linkedPullRequest,
  mergeAsAsked,
  updateBranch,
  type AskedMerge,
  type LinkedPullRequest,
  type MergeAdvice,
} from "./pull-request-merging.js";
import { failingCheckOn, sendBackForFailure, type Failure } from "./sending-back.js";

/**
 * Pipeline: the Merge Queue (ADR 0011, amending ADR 0005). A User with Write presses Merge on a Ticket in a Review
 * Status with an open linked Pull Request, in a Project with Pull Request automation on and a Merge Status (a Status
 * with a Merge Step): the Pull Request joins the queue for its Repository and base branch, and the Ticket moves into
 * the Merge Status as the User's move. A queued Ticket gets no Merge Run. Each `queuePass` takes the head of each queue,
 * the entry that joined first, and asks Cronk's merge (`pull-request-merging.ts`) for it as the queuing User's,
 * completing the Ticket as Verified; a head that isn't clean and green yet waits for a later pass. One head per queue
 * is merged at a time, so queues on other branches or Repositories never wait on each other.
 *
 * An entry leaves the queue when its Ticket leaves the Merge Status it waits in (`ticket-writes.ts`), as Remove from
 * queue, a User's move or the merge completing it do, and when its Pull Request merges or closes on GitHub. A failing
 * check on its latest commit or a review requesting changes, at the head or waiting, sends the Ticket back to the Step
 * that produced its Pull Request as a round, or to its first Review Status without one (`sending-back.ts`). A merge
 * GitHub refuses, such as for branch protection or a ruleset, hands the Ticket to its Assignee by the Merge Step's
 * *needs you* Outcome, Cronk's Question quoting GitHub's reason. Either way the queue moves on to the next entry.
 *
 * A head GitHub says is behind its base branch but merges cleanly, as in a Repository requiring up-to-date branches,
 * isn't merged: Cronk asks GitHub to update its branch (*updating branch*), then waits for the new commit's checks
 * (*waiting for checks*), the Tickets behind it waiting too, and merges it on a pass once they are green. Deliveries
 * of checks and reviews on a queued Pull Request have the queue act on it at once (`queueDue`).
 *
 * For now a Ticket queues only its first open linked Pull Request (Merge Queue 8 queues each), and a head that
 * conflicts waits (Merge Queue 7).
 */

const rules = {
  merge: "Merge queues a Ticket in a Review Status with an open linked Pull Request, in a Project with Pull Request automation on and a Merge Status.",
  remove: "Only a Ticket in the Merge Queue can be removed from it, and not while Cronk is merging it.",
};

/**
 * What the queue does instead of a merge Cronk refuses: a failure sends the head back and GitHub's refusal hands it
 * to its Assignee, as `mergeHead` does; anything else waits for a later pass. The advice itself is never shown.
 */
const waitAdvice: MergeAdvice = {
  sendBack: (why) => `It waits in the queue: ${why}.`,
  needsYou: (what) => `It waits in the queue for ${what}.`,
  readAgain: () => "It waits in the queue.",
};

/**
 * Merge: queues the Ticket's first open linked Pull Request and moves the Ticket into its Project's Merge Status, as
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
       order by pull_request_links.linked_at, pull_requests.id limit 1`,
      [ticket.id, ticket.projectId],
    );
    const pullRequest = pullRequests[0];
    if (!pullRequest) {
      throw refuse(
        "no_open_pull_request",
        `${ticket.key} has no open Pull Request of a Repository its Project lists, so there's nothing to merge.`,
        "Open a Pull Request naming its key, or mark a draft ready for review, then merge.",
      );
    }
    const now = context.clock.now();
    await tx.query(
      `insert into merge_queue (pull_request_id, ticket_id, status_id, queued_by_user_id, entered_at) values ($1, $2, $3, $4, $5)`,
      [pullRequest.id, ticket.id, mergeStatus.id, caller.id, now],
    );
    await recordChanges(tx, ticket, caller.id, now, [
      { field: "queueJoined", from: null, to: { pullRequest: { ...pullRequest, id: Number(pullRequest.id) } } },
    ]);
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

/** Where an entry is: waiting, being merged, having its branch updated, or waiting for its new commit's checks. */
export type QueueState = "queued" | "merging" | "updating-branch" | "waiting-for-checks";

/** The head of one queue, as the pass read it. */
interface Head {
  pullRequestId: string;
  ticketId: string;
  state: QueueState;
  queuedBy: string;
}

/** The states in which a head waits for the pass to act on it, rather than Cronk asking GitHub about it now. */
const waiting: QueueState[] = ["queued", "waiting-for-checks"];

/**
 * One pass of the Merge Queue: per Repository and base branch, asks Cronk's merge for the head, the entry that joined
 * first, unless Cronk is already asking GitHub about it. A head that fails or that GitHub refuses leaves the queue, as
 * the module says; one GitHub says is behind its base branch has its branch updated, then waits for the new commit's
 * checks; one that isn't ready yet waits for a later pass. Heads of Projects archived or with Pull Request automation
 * off since wait too. Given Pull Requests, it acts only on the heads among them, as a delivery about them asks.
 */
export async function queuePass(context: Context, only?: { pullRequestIds: number[] }): Promise<void> {
  const { rows: heads } = await context.db.query<Head & { active: boolean }>(
    `select distinct on (pull_requests.repository_id, coalesce(pull_requests.base_branch, ''))
       merge_queue.pull_request_id::text as "pullRequestId", merge_queue.ticket_id as "ticketId", merge_queue.state,
       merge_queue.queued_by_user_id as "queuedBy",
       projects.archived_at is null and projects.pull_request_automation as active
     from merge_queue join pull_requests on pull_requests.id = merge_queue.pull_request_id
     join tickets on tickets.id = merge_queue.ticket_id join projects on projects.id = tickets.project_id
     order by pull_requests.repository_id, coalesce(pull_requests.base_branch, ''), merge_queue.seq`,
  );
  for (const head of heads) {
    if (!waiting.includes(head.state) || !head.active) continue;
    if (only && !only.pullRequestIds.includes(Number(head.pullRequestId))) continue;
    await mergeHead(context, head);
  }
}

/**
 * Has the queue act at once on those of the Pull Requests that are queued, once the transaction commits, as a delivery
 * of their checks or reviews asks; the periodic pass acts on them anyway if this one fails.
 */
export async function queueDue(context: Context, tx: Tx, pullRequestIds: number[]): Promise<void> {
  if (pullRequestIds.length === 0) return;
  const { rows } = await tx.query<{ id: string }>(
    "select pull_request_id::text as id from merge_queue where pull_request_id = any($1::bigint[])",
    [pullRequestIds],
  );
  if (rows.length === 0) return;
  const due = rows.map((row) => Number(row.id));
  afterCommit(tx, () => queuePass(context, { pullRequestIds: due }).catch(() => undefined));
}

/** Whether GitHub reported any check, or check suite, on the commit. */
async function hasChecks(tx: Tx, repositoryId: string, sha: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `select from commit_checks where repository_id = $1 and sha = $2
     union all select from commit_check_suites where repository_id = $1 and sha = $2 limit 1`,
    [repositoryId, sha],
  );
  return rowCount !== 0;
}

/** Sets the entry's state, if it is still in one of `from`, telling its Workspace. */
async function setState(context: Context, tx: Tx, head: Head, to: QueueState, from: QueueState[], updatedFrom?: string): Promise<boolean> {
  const { rows } = await tx.query<{ workspaceId: string; projectId: string }>(
    `update merge_queue set state = $2, updated_from_sha = case when $4::text is null then updated_from_sha else $4 end
     from tickets where merge_queue.pull_request_id = $1 and merge_queue.state = any($3::text[]) and tickets.id = merge_queue.ticket_id
     returning tickets.workspace_id as "workspaceId", tickets.project_id as "projectId"`,
    [head.pullRequestId, to, from, updatedFrom ?? null],
  );
  for (const { workspaceId, projectId } of rows) {
    context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId: head.ticketId });
  }
  return rows.length > 0;
}

/**
 * Asks Cronk's merge for the head as its queuing User's, marking it *merging* while GitHub is asked. A head whose branch
 * Cronk updated waits until GitHub reports the new commit and, if the old one had checks, some checks on it; then
 * Cronk's rules hold it until they are green.
 */
async function mergeHead(context: Context, head: Head): Promise<void> {
  const asked = await transaction(context.db, async (tx): Promise<{ asked: AskedMerge; from: QueueState } | null> => {
    const { rows: tickets } = await tx.query<{ id: string; projectId: string; workspaceId: string; key: string }>(
      `select tickets.id, tickets.project_id as "projectId", tickets.workspace_id as "workspaceId",
         projects.key || '-' || tickets.number as key
       from tickets join projects on projects.id = tickets.project_id where tickets.id = $1 for update of tickets`,
      [head.ticketId],
    );
    const ticket = tickets[0];
    // Read again under the Ticket's lock: it may have left the queue, or another pass taken it, since the pass read it.
    const { rows: entries } = await tx.query<{ state: QueueState; updatedFrom: string | null }>(
      `select state, updated_from_sha as "updatedFrom" from merge_queue
       where pull_request_id = $1 and ticket_id = $2 and state = any($3::text[]) for update`,
      [head.pullRequestId, head.ticketId, waiting],
    );
    const entry = entries[0];
    if (!ticket || !entry) return null;
    const pullRequest = await linkedPullRequest(tx, ticket, Number(head.pullRequestId));
    const { rows: users } = await tx.query<{ name: string }>(`select ${userName()} as name from users where id = $1`, [head.queuedBy]);
    if (!pullRequest || !users[0]) return null;
    if (entry.state === "waiting-for-checks" && entry.updatedFrom !== null) {
      // GitHub hasn't reported the updated commit yet, so the old one's checks would be judged.
      if (pullRequest.sha === entry.updatedFrom) return null;
      // Nor any check on it yet, where the old one had some.
      if ((await hasChecks(tx, pullRequest.repositoryId, entry.updatedFrom)) && !(await hasChecks(tx, pullRequest.repositoryId, pullRequest.sha))) {
        return null;
      }
    }
    let asked: AskedMerge;
    try {
      asked = await askMerge(tx, {
        ticket,
        pullRequest,
        actor: { kind: "user", userId: head.queuedBy, name: users[0].name, workspaceId: ticket.workspaceId },
        completeAs: "verified",
        advice: waitAdvice,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // A failure Cronk knows sends the head back, even one that sent it back before on the same commit.
      const failure = await failureOf(tx, pullRequest, error.code);
      if (failure) {
        const failed = { id: Number(pullRequest.id), repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url };
        if (await sendBackForFailure(context, tx, failed, failure, { ticketId: ticket.id, again: true })) {
          context.live.publish(tx, ticket.workspaceId, { type: "pull_requests.changed", projectId: ticket.projectId, ticketId: ticket.id });
        }
      }
      return null;
    }
    await setState(context, tx, head, "merging", [entry.state]);
    return { asked, from: entry.state };
  });
  if (!asked) return;
  try {
    // The merge completes the Ticket, taking it out of the Merge Status and so out of the queue; whatever kept it
    // there, such as automation turned off meanwhile, the merged Pull Request leaves the queue all the same.
    await mergeAsAsked(context, asked.asked, (tx) => dropFromQueue(context, tx, Number(head.pullRequestId)), { refuseBehind: true });
  } catch (error) {
    if (error instanceof ApiError && error.code === behindCode) return updateHead(context, head, asked.asked);
    await transaction(context.db, (tx) => setState(context, tx, head, asked.from, ["merging"]));
    if (error instanceof GitHubRefusedMerge) await handOver(context, head, error);
    else if (!(error instanceof ApiError)) throw error;
  }
}

/**
 * Has GitHub update the branch of a head that is behind its base branch, marking it *updating branch* while GitHub is
 * asked, then *waiting for checks* on the commit GitHub makes. A head GitHub won't update, as when the head moved
 * meanwhile, goes back to waiting for a later pass.
 */
async function updateHead(context: Context, head: Head, asked: AskedMerge): Promise<void> {
  if (!(await transaction(context.db, (tx) => setState(context, tx, head, "updating-branch", ["merging"])))) return;
  let updated = false;
  try {
    updated = await updateBranch(context, asked);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  } finally {
    await transaction(context.db, (tx) =>
      updated
        ? setState(context, tx, head, "waiting-for-checks", ["updating-branch"], asked.pullRequest.sha)
        : setState(context, tx, head, "queued", ["updating-branch"]),
    ).catch(() => undefined);
  }
}

/** The failure a refusal of Cronk's merge names: a failing check on the latest commit, or a review requesting changes. */
async function failureOf(tx: Tx, pullRequest: LinkedPullRequest, code: string): Promise<Failure | null> {
  if (code === "checks_failing") return failingCheckOn(tx, pullRequest.repositoryId, pullRequest.sha);
  if (code !== "changes_requested") return null;
  const { rows } = await tx.query<{ id: string; reviewer: string; url: string | null }>(
    `select review_id as id, reviewer, url from pull_request_reviews
     where pull_request_id = $1 and state = 'changes_requested' order by review_id limit 1`,
    [pullRequest.id],
  );
  return rows[0] ? { kind: "review", id: Number(rows[0].id), reviewer: rows[0].reviewer, url: rows[0].url } : null;
}

/**
 * Hands a head GitHub refused to merge to its Ticket's Assignee, by the Merge Step's *needs you* Outcome with Cronk's
 * Question quoting GitHub's reason, which takes it out of the queue. Not a round.
 */
async function handOver(context: Context, head: Head, refusal: GitHubRefusedMerge): Promise<void> {
  await transaction(context.db, async (tx) => {
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
       from tickets join projects on projects.id = tickets.project_id where tickets.id = $1 for update of tickets`,
      [head.ticketId],
    );
    const ticket = tickets[0];
    const { rows: entries } = await tx.query<{ statusId: string; repository: string; number: number }>(
      `select merge_queue.status_id as "statusId", pull_requests.repository_full_name as repository, pull_requests.number
       from merge_queue join pull_requests on pull_requests.id = merge_queue.pull_request_id
       where merge_queue.pull_request_id = $1 and merge_queue.ticket_id = $2 and merge_queue.state = any($3::text[]) for update of merge_queue`,
      [head.pullRequestId, head.ticketId, waiting],
    );
    const entry = entries[0];
    // It may have left the queue meanwhile.
    if (!ticket || !entry || ticket.statusId !== entry.statusId) return;
    const status = (await statusesOf(tx, ticket.projectId)).find((s) => s.id === entry.statusId);
    const needsYou = status?.step?.outcomes.find((o) => o.needsYou);
    if (!status?.step || !needsYou) return;
    const name = `${entry.repository}#${entry.number}`;
    const why = refusal.reason ? `GitHub refused to merge ${name}: “${refusal.reason}”` : `GitHub refused to merge ${name} without saying why`;
    await moveByCronk(context, tx, ticket, {
      target: { kind: "outcome", step: { statusId: status.id, name: status.name }, outcome: { ...needsYou, countsAsRound: false } },
      by: { kind: "cronk" },
      verification: "unverified",
      question:
        `${why}, so ${ticket.key} left the Merge Queue. Change what GitHub needs, such as the Repository's branch protection or ` +
        "rulesets, then press Merge again, or merge it on GitHub yourself.",
    });
  });
}
