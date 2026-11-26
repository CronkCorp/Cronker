import type { Context } from "../context.js";
import { afterCommit, transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import { userName } from "../identity/user.js";
import { requireWrite } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { statusesOf, type Status } from "../work/projects.js";
import type { Outcome, Step } from "../work/steps.js";
import { editTicketIn, findTicketRow, ticketNotFound, type Ticket } from "../work/tickets.js";
import { moveByCronk, type MovedTicket } from "./cronk-moves.js";
import {
  askMerge,
  behindCode,
  ConflictingPullRequest,
  GitHubRefusedMerge,
  linkedPullRequest,
  mergeAsAsked,
  pendingCheckOn,
  updateBranch,
  type AskedMerge,
  type CompleteAs,
  type LinkedPullRequest,
  type MergeActor,
  type MergeAdvice,
} from "./pull-request-merging.js";
import { failingCheckOn, sendBackForFailure, type Failure } from "./sending-back.js";
import { startRunIfNeeded } from "../runs/runs.js";
import { ticketRunner } from "../runs/waiting.js";
import { insertComment } from "../work/comment-writes.js";

/**
 * Pipeline: the Merge Queue (ADR 0011, amending ADR 0005). A User with Write presses Merge on a Ticket in a Review
 * Status with an open linked Pull Request, in a Project with Pull Request automation on and a Merge Status (a Status
 * with a Merge Step): each of its open linked Pull Requests joins the queue for its own Repository and base branch, and
 * the Ticket moves into the Merge Status as the User's move. An Autonomous Delegation Ticket in a Project with agents
 * may merge on joins on its own as it enters the Merge Status (`runs.ts`), for its Agent. A queued Ticket gets no Merge
 * Run. Each `queuePass` takes the head of each queue, the entry that joined first, and asks Cronk's merge
 * (`pull-request-merging.ts`) for it as the queuing User's, or as the Agent's for an entry Autonomous Delegation
 * queued; a head that isn't clean and green yet waits for a later pass. A Ticket with several entries stays in the
 * Merge Status until the last of them merges, which completes it as Verified, or as Unverified for the Agent's
 * (`merges.ts`). Turning agents may merge off takes out the entries Autonomous Delegation queued, passing their
 * Tickets on as their Merge Step would (`dropAutonomousEntries`). One head per queue
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
 * Leaving the Merge Status takes all of a Ticket's entries out at once, so one Pull Request sending it back takes the
 * others with it.
 *
 * A head GitHub says conflicts with its base branch steps aside, out of line, so the queue moves on to the next entry
 * (`stepAside`): Cronk writes a Comment naming the merge that caused the conflict, and a Run of the Merge Step starts
 * (*resolving conflict*), whatever the Merge Step's rule says. Its Agent resolves the conflict, pushes to the Pull
 * Request's branch and finishes with *resolved*, the Merge Step's Outcome leaving the Ticket in the Merge Status
 * (`resolvingOutcome`); the entry then waits, still out of line, for the new commit's checks (*waiting for checks*),
 * and once they are green rejoins its queue at the front (`rejoin`). A resolution that isn't mechanical goes back to
 * Implement by the Merge Step's Outcome sending it back, which then counts as no round. Each entry steps aside at most
 * 3 times: a fourth conflict, a Ticket with no Delegate to resolve it, or a Merge Step without *resolved*, hands the
 * Ticket to its Assignee by the Merge Step's *needs you* Outcome with Cronk's Question, not as a round.
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
 * Merge: queues each of the Ticket's open linked Pull Requests, each in its own Repository's and base branch's queue,
 * and moves the Ticket into its Project's Merge Status, as
 * the User's move, refusing, naming the rule, as the module says.
 */
export async function joinQueue(context: Context, caller: Caller, ticketId: string): Promise<Ticket> {
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
    const pullRequests = await queueablePullRequests(tx, ticket);
    if (pullRequests.length === 0) {
      throw refuse(
        "no_open_pull_request",
        `${ticket.key} has no open Pull Request of a Repository its Project lists, so there's nothing to merge.`,
        "Open a Pull Request naming its key, or mark a draft ready for review, then merge.",
      );
    }
    const now = context.clock.now();
    // A Full Agent's entry is its Agent's merge, as an Autonomous Delegation one is, but taken as its Owner would.
    const byAgent = caller.kind === "agent";
    for (const pullRequest of pullRequests) {
      await tx.query(
        `insert into merge_queue (pull_request_id, ticket_id, status_id, queued_by_user_id, queued_by_agent_id, by_full_token, entered_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [pullRequest.id, ticket.id, mergeStatus.id, byAgent ? null : caller.id, byAgent ? caller.id : null, byAgent, now],
      );
    }
    await recordChanges(
      tx,
      ticket,
      byAgent ? { kind: "agent", id: caller.id, runId: null } : caller.id,
      now,
      pullRequests.map(queueJoined),
    );
    return editTicketIn(context, tx, caller, ticket.id, { statusId: mergeStatus.id });
  });
}

/** A Pull Request a Ticket can queue: an open linked one, of a Repository its Project lists, not queued yet. */
interface QueueablePullRequest {
  id: string;
  repository: string;
  number: number;
  url: string;
}

/** The Ticket's Pull Requests it can queue, in the order they were linked. */
async function queueablePullRequests(tx: Tx, ticket: { id: string; projectId: string }): Promise<QueueablePullRequest[]> {
  const { rows } = await tx.query<QueueablePullRequest>(
    `select pull_requests.id::text, pull_requests.repository_full_name as repository, pull_requests.number, pull_requests.url
     from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
     join project_repositories on project_repositories.repository_id = pull_requests.repository_id
       and project_repositories.project_id = $2
     where pull_request_links.ticket_id = $1 and pull_requests.state = 'open'
       and not exists (select from merge_queue where merge_queue.pull_request_id = pull_requests.id)
     order by pull_request_links.linked_at, pull_requests.id`,
    [ticket.id, ticket.projectId],
  );
  return rows;
}

const queueJoined = (pullRequest: QueueablePullRequest) =>
  ({ field: "queueJoined", from: null, to: { pullRequest: { ...pullRequest, id: Number(pullRequest.id) } } }) as const;

/**
 * Autonomous Delegation's join: queues each of the Ticket's open linked Pull Requests for the Agent it is delegated
 * to, as it enters the Merge Status `statusId`, recording a `queueJoined` Change by Cronk for each. Returns false,
 * queueing nothing, when the Ticket has none. Whether an agent may merge the Ticket is the caller's to check first, in
 * the transaction that locked the Ticket.
 */
export async function joinQueueAutonomously(
  context: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string },
  statusId: string,
  agentId: string,
  now: Date,
): Promise<boolean> {
  const pullRequests = await queueablePullRequests(tx, ticket);
  if (pullRequests.length === 0) return false;
  for (const pullRequest of pullRequests) {
    await tx.query(
      `insert into merge_queue (pull_request_id, ticket_id, status_id, queued_by_agent_id, entered_at) values ($1, $2, $3, $4, $5)`,
      [pullRequest.id, ticket.id, statusId, agentId, now],
    );
  }
  await recordChanges(tx, ticket, { kind: "cronk" }, now, pullRequests.map(queueJoined));
  context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  return true;
}

/**
 * Turning *agents may merge* off: takes the Project's entries only Autonomous Delegation queued out of the queue,
 * recording a `queueLeft` Change by Cronk on each, and returns their Tickets with their Runners, for their Merge Step
 * to pass them on as entering it now would. Entries a User or a Full token queued stay, and so does one Cronk is asking
 * GitHub about.
 */
export async function dropAutonomousEntries(
  context: Context,
  tx: Tx,
  projectId: string,
): Promise<{ id: string; runnerId: string | null }[]> {
  const { rows } = await tx.query<{ ticketId: string; workspaceId: string; runnerId: string | null; pullRequest: unknown }>(
    `with dropped as (
       delete from merge_queue using tickets
       where tickets.id = merge_queue.ticket_id and tickets.project_id = $1
         and merge_queue.queued_by_agent_id is not null and not merge_queue.by_full_token
         and merge_queue.state in ('queued', 'waiting-for-checks')
       returning merge_queue.ticket_id, merge_queue.pull_request_id)
     select tickets.id as "ticketId", tickets.workspace_id as "workspaceId", ${ticketRunner("tickets")} as "runnerId",
       json_build_object('id', pull_requests.id, 'repository', pull_requests.repository_full_name,
         'number', pull_requests.number, 'url', pull_requests.url) as "pullRequest"
     from dropped join tickets on tickets.id = dropped.ticket_id join pull_requests on pull_requests.id = dropped.pull_request_id
     order by tickets.number, pull_requests.id`,
    [projectId],
  );
  for (const { ticketId, workspaceId, pullRequest } of rows) {
    await recordChanges(tx, { id: ticketId, workspaceId }, { kind: "cronk" }, context.clock.now(), [
      { field: "queueLeft", from: { pullRequest }, to: null },
    ]);
    context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId });
  }
  return rows
    .filter((row, i) => rows.findIndex((other) => other.ticketId === row.ticketId) === i)
    .map((row) => ({ id: row.ticketId, runnerId: row.runnerId }));
}

/** Remove from queue: sends the queued Ticket back to its Project's first Review Status, as the User's move. */
export async function leaveQueue(context: Context, caller: Caller, ticketId: string): Promise<Ticket> {
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

/**
 * Where an entry is: waiting, being merged, having its branch updated, having a conflict resolved, or waiting for its
 * new commit's checks.
 */
export type QueueState = "queued" | "merging" | "updating-branch" | "resolving-conflict" | "waiting-for-checks";

/** How many times an entry steps aside for a conflict before its Ticket comes to its Assignee instead. */
export const conflictCap = 3;

/**
 * The Merge Step's Outcome a Run resolving a conflict finishes with once it pushed a resolution: the one, neither the
 * default nor *needs you* nor *backported*, that leaves the Ticket in the Merge Status, as the default Merge Step's
 * *resolved* does.
 */
export function resolvingOutcome(status: Pick<Status, "id"> & { step: Step | null }): Outcome | undefined {
  if (status.step?.kind !== "merge") return undefined;
  // *backported* leaves it there too, but is for a Run backporting a merge (`backports.ts`).
  return status.step.outcomes.find((o) => o.statusId === status.id && !o.default && !o.needsYou && o.name.toLowerCase() !== "backported");
}

/** Whether one of the Ticket's entries waits for a Run of the Merge Step to resolve its conflict. */
export async function resolvingConflict(tx: Tx, ticketId: string): Promise<boolean> {
  const { rowCount } = await tx.query("select from merge_queue where ticket_id = $1 and state = 'resolving-conflict'", [ticketId]);
  return rowCount !== 0;
}

/**
 * A Run resolving a conflict finished with *resolved*: the Ticket's entries resolving a conflict wait, still out of
 * line, for their new commits' checks. Says whether any did. Call it in the transaction that locked the Ticket.
 */
export async function conflictResolved(context: Context, tx: Tx, ticket: { id: string; workspaceId: string; projectId: string }): Promise<boolean> {
  const { rowCount } = await tx.query(
    "update merge_queue set state = 'waiting-for-checks' where ticket_id = $1 and state = 'resolving-conflict'",
    [ticket.id],
  );
  if (rowCount) context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  return rowCount !== 0;
}

/** The head of one queue, as the pass read it. */
interface Head {
  pullRequestId: string;
  ticketId: string;
  state: QueueState;
  /** The User who pressed Merge, or null for an entry an Agent queued: `queuedByAgent`. */
  queuedBy: string | null;
  queuedByAgent: string | null;
  /** Whether `queuedByAgent` pressed Merge with a Full token, rather than Autonomous Delegation queueing it. */
  byFullToken: boolean;
}

/** The states in which a head waits for the pass to act on it, rather than Cronk asking GitHub about it now. */
const waiting: QueueState[] = ["queued", "waiting-for-checks"];

/**
 * One pass of the Merge Queue: per Repository and base branch, asks Cronk's merge for the head, the entry that joined
 * first, unless Cronk is already asking GitHub about it. A head that fails or that GitHub refuses leaves the queue, as
 * the module says; one GitHub says is behind its base branch has its branch updated, then waits for the new commit's
 * checks; one that isn't ready yet waits for a later pass. Heads of Projects archived or with Pull Request automation
 * off since wait too. Given Pull Requests, it acts only on the heads among them, as a delivery about them asks. While
 * GitHub is unavailable (`github/status.ts`) every head waits, and the pass asks GitHub nothing; entries
 * rejoining, which asks GitHub nothing, still do.
 */
export async function queuePass(context: Context, only?: { pullRequestIds: number[] }): Promise<void> {
  const githubUnavailable = () => context.githubStatus.waitingUntil(context.clock.now()) !== null;
  const wanted = (entry: Head & { active: boolean }) => entry.active && (!only || only.pullRequestIds.includes(Number(entry.pullRequestId)));
  // Entries that stepped aside and wait for their resolving commits' checks rejoin first, at the front of their queues.
  const { rows: aside } = await context.db.query<Head & { active: boolean }>(
    `select ${headColumns} from merge_queue join tickets on tickets.id = merge_queue.ticket_id
     join projects on projects.id = tickets.project_id
     where merge_queue.aside and merge_queue.state = 'waiting-for-checks'
     order by merge_queue.seq`,
  );
  for (const entry of aside) if (wanted(entry)) await rejoin(context, entry);
  const { rows: heads } = await context.db.query<Head & { active: boolean }>(
    `select distinct on (pull_requests.repository_id, coalesce(pull_requests.base_branch, '')) ${headColumns}
     from merge_queue join pull_requests on pull_requests.id = merge_queue.pull_request_id
     join tickets on tickets.id = merge_queue.ticket_id join projects on projects.id = tickets.project_id
     -- An entry that stepped aside is out of line; one Cronk is acting on stays the head.
     where not merge_queue.aside
     order by pull_requests.repository_id, coalesce(pull_requests.base_branch, ''), merge_queue.state = 'queued', merge_queue.seq`,
  );
  for (const head of heads) {
    if (githubUnavailable()) return;
    if (!waiting.includes(head.state) || !wanted(head)) continue;
    await mergeHead(context, head);
  }
}

const headColumns = `merge_queue.pull_request_id::text as "pullRequestId", merge_queue.ticket_id as "ticketId", merge_queue.state,
  merge_queue.queued_by_user_id as "queuedBy", merge_queue.queued_by_agent_id as "queuedByAgent",
  merge_queue.by_full_token as "byFullToken",
  projects.archived_at is null and projects.pull_request_automation as active`;

/**
 * Has the queue act at once on those of the Pull Requests that are queued, once the transaction commits, as a delivery
 * of their checks or reviews asks; the periodic pass acts on them anyway if this one fails.
 */
export async function queueDue(context: Context, tx: Tx, pullRequestIds: number[]): Promise<void> {
  if (pullRequestIds.length === 0) return;
  const { rows } = await tx.query<{ id: string }>(
    "select pull_request_id::text as id from merge_queue where pull_request_id = any($1::bigint[]) and state <> 'resolving-conflict'",
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
 * Whom Cronk merges the head for: the User who queued it, completing the Ticket as Verified, or the Agent Autonomous
 * Delegation queued it for, completing it as Unverified, as an agent's merge does, while its Project still has agents
 * may merge on and the Agent isn't removed. An Agent that pressed Merge with a Full token merges as Autonomous
 * Delegation's does, Unverified, but needs no agents may merge: it acted as its Owner. Null leaves the head waiting.
 */
async function mergerOf(
  tx: Tx,
  head: Head,
  ticket: { projectId: string; workspaceId: string },
): Promise<{ actor: MergeActor; completeAs: CompleteAs } | null> {
  if (head.queuedBy) {
    const { rows } = await tx.query<{ name: string }>(`select ${userName()} as name from users where id = $1`, [head.queuedBy]);
    if (!rows[0]) return null;
    return { actor: { kind: "user", userId: head.queuedBy, name: rows[0].name, workspaceId: ticket.workspaceId }, completeAs: "verified" };
  }
  const { rows } = await tx.query(
    `select from agents join projects on projects.id = $2
     where agents.id = $1 and agents.removed_at is null and ($3 or projects.agents_may_merge)`,
    [head.queuedByAgent, ticket.projectId, head.byFullToken],
  );
  if (rows.length === 0) return null;
  return {
    actor: { kind: "agent", agentId: head.queuedByAgent!, runId: null, workspaceId: ticket.workspaceId },
    completeAs: "unverified",
  };
}

/**
 * Asks Cronk's merge for the head as its queuing User's or Agent's, marking it *merging* while GitHub is asked. A head whose branch
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
       where pull_request_id = $1 and ticket_id = $2 and state = any($3::text[]) and not aside for update`,
      [head.pullRequestId, head.ticketId, waiting],
    );
    const entry = entries[0];
    if (!ticket || !entry) return null;
    const pullRequest = await linkedPullRequest(tx, ticket, Number(head.pullRequestId));
    if (!pullRequest) return null;
    const merger = await mergerOf(tx, head, ticket);
    if (!merger) return null;
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
        ...merger,
        viaQueue: true,
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
    // The merge takes its entry out of the queue, completing the Ticket when it was its last; whatever kept the entry
    // there, such as automation turned off meanwhile, the merged Pull Request leaves the queue all the same.
    await mergeAsAsked(context, asked.asked, (tx) => dropFromQueue(context, tx, Number(head.pullRequestId)), { refuseBehind: true });
  } catch (error) {
    if (error instanceof ApiError && error.code === behindCode) return updateHead(context, head, asked.asked);
    await transaction(context.db, (tx) => setState(context, tx, head, asked.from, ["merging"]));
    if (error instanceof ConflictingPullRequest) await stepAside(context, head, asked.asked, error);
    else if (error instanceof GitHubRefusedMerge) await handOver(context, head, error);
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
    const locked = await lockHead(tx, head);
    if (!locked) return;
    const { ticket, entry, status } = locked;
    const name = `${entry.repository}#${entry.number}`;
    const why = refusal.reason ? `GitHub refused to merge ${name}: “${refusal.reason}”` : `GitHub refused to merge ${name} without saying why`;
    await askAssignee(
      context,
      tx,
      ticket,
      status,
      `${why}, so ${ticket.key} left the Merge Queue. Change what GitHub needs, such as the Repository's branch protection or ` +
        "rulesets, then press Merge again, or merge it on GitHub yourself.",
    );
  });
}

/** The Ticket the pass read the head of, locked, with its entry while it still waits in the Merge Status it entered. */
async function lockHead(
  tx: Tx,
  head: Head,
): Promise<
  | {
      ticket: MovedTicket & { delegateId: string | null; delegateRemoved: boolean };
      entry: { statusId: string; repository: string; number: number; url: string; branch: string | null; repositoryId: string; conflictCount: number };
      status: Status & { step: Step };
    }
  | undefined
> {
  const { rows: tickets } = await tx.query<MovedTicket & { delegateId: string | null; delegateRemoved: boolean }>(
    `select tickets.id, projects.key || '-' || tickets.number as key, tickets.workspace_id as "workspaceId",
       tickets.project_id as "projectId", tickets.status_id as "statusId", tickets.verification,
       tickets.delegate_id as "delegateId", coalesce(agents.removed_at is not null, false) as "delegateRemoved"
     from tickets join projects on projects.id = tickets.project_id left join agents on agents.id = tickets.delegate_id
     where tickets.id = $1 for update of tickets`,
    [head.ticketId],
  );
  const ticket = tickets[0];
  const { rows: entries } = await tx.query<{
    statusId: string;
    repository: string;
    number: number;
    url: string;
    branch: string | null;
    repositoryId: string;
    conflictCount: number;
  }>(
    `select merge_queue.status_id as "statusId", pull_requests.repository_full_name as repository, pull_requests.number,
       pull_requests.url, pull_requests.base_branch as branch, pull_requests.repository_id as "repositoryId",
       merge_queue.conflict_count as "conflictCount"
     from merge_queue join pull_requests on pull_requests.id = merge_queue.pull_request_id
     where merge_queue.pull_request_id = $1 and merge_queue.ticket_id = $2 and merge_queue.state = any($3::text[])
       and not merge_queue.aside
     for update of merge_queue`,
    [head.pullRequestId, head.ticketId, waiting],
  );
  const entry = entries[0];
  // It may have left the queue meanwhile.
  if (!ticket || !entry || ticket.statusId !== entry.statusId) return undefined;
  const status = (await statusesOf(tx, ticket.projectId)).find((s) => s.id === entry.statusId);
  if (!status?.step) return undefined;
  return { ticket, entry, status: status as Status & { step: Step } };
}

/**
 * Hands the queued Ticket to its Assignee by its Merge Step's *needs you* Outcome, with Cronk's Question, which takes
 * it out of the queue. Not a round.
 */
async function askAssignee(context: Context, tx: Tx, ticket: MovedTicket, status: Status & { step: Step }, question: string): Promise<void> {
  const needsYou = status.step.outcomes.find((o) => o.needsYou);
  if (!needsYou) return;
  await moveByCronk(context, tx, ticket, {
    target: { kind: "outcome", step: { statusId: status.id, name: status.name }, outcome: { ...needsYou, countsAsRound: false } },
    by: { kind: "cronk" },
    verification: "unverified",
    question,
  });
}

const linkedName = (repository: string, number: number, url: string | null) =>
  url ? `[${repository}#${number}](${url})` : `${repository}#${number}`;

/**
 * Takes a head GitHub says conflicts with its base branch out of line, so the queue moves on: with Cronk's Comment
 * naming the merge that caused the conflict, it waits for a Run of the Merge Step to resolve it, which starts now. A
 * fourth conflict, a Ticket with no Delegate, or a Merge Step without a resolving Outcome hands the Ticket to its
 * Assignee instead.
 */
async function stepAside(context: Context, head: Head, asked: AskedMerge, conflict: ConflictingPullRequest): Promise<void> {
  await transaction(context.db, async (tx) => {
    const locked = await lockHead(tx, head);
    if (!locked) return;
    const { ticket, entry, status } = locked;
    const branch = conflict.base.ref ?? entry.branch;
    // The merge whose commit GitHub compared against, if Cronk knows it.
    const { rows: merges } = conflict.base.sha
      ? await tx.query<{ id: string; repository: string; number: number; url: string }>(
          `select id::text, repository_full_name as repository, number, url from pull_requests
           where repository_id = $1 and state = 'merged' and $2 in (merge_commit_sha, answered_merge_sha) order by id limit 1`,
          [entry.repositoryId, conflict.base.sha],
        )
      : { rows: [] };
    const merge = merges[0];
    const name = linkedName(entry.repository, entry.number, entry.url);
    const conflicts = `${name} conflicts with \`${branch ?? "its base branch"}\`${merge ? ` since ${linkedName(merge.repository, merge.number, merge.url)} merged` : ""}`;
    const plainName = `${entry.repository}#${entry.number}`;
    const plainConflicts = `${plainName} conflicts with ${branch ?? "its base branch"}${merge ? ` since ${merge.repository}#${merge.number} merged` : ""}`;
    if (entry.conflictCount >= conflictCap) {
      await askAssignee(
        context,
        tx,
        ticket,
        status,
        `${plainConflicts}, and ${ticket.key} already stepped aside for conflicts ${conflictCap} times, so it left the Merge Queue. ` +
          "Resolve the conflict yourself, or send it back to work, then press Merge again.",
      );
      return;
    }
    const resolving = resolvingOutcome(status);
    if (!resolving || !ticket.delegateId || ticket.delegateRemoved) {
      const why = !resolving
        ? `its ${status.name} Step has no Outcome for a resolved conflict, so no Run can resolve it`
        : `${ticket.key} isn't delegated, so no Run can resolve it`;
      await askAssignee(
        context,
        tx,
        ticket,
        status,
        `${plainConflicts}: ${why}, and it left the Merge Queue. Resolve the conflict, then press Merge again.`,
      );
      return;
    }
    const now = context.clock.now();
    await tx.query(
      `update merge_queue set state = 'resolving-conflict', aside = true, conflict_count = conflict_count + 1,
         conflict_merged_pull_request_id = $2, conflict_base_sha = $3, conflict_at = $4, updated_from_sha = $5
       where pull_request_id = $1`,
      [head.pullRequestId, merge?.id ?? null, conflict.base.sha, now, asked.pullRequest.sha],
    );
    await insertComment(
      context,
      tx,
      ticket,
      { kind: "cronk" },
      `${conflicts}, so ${ticket.key} stepped aside in the Merge Queue, which moves on meanwhile; a Run of ${status.name} ` +
        `resolves the conflict (${entry.conflictCount + 1} of ${conflictCap}). Once the resolution's checks are green, ` +
        `${ticket.key} rejoins the queue at the front.`,
      null,
    );
    context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    await startRunIfNeeded(context, tx, ticket.id, now);
  });
}

/**
 * Judges an entry that stepped aside and waits for its resolving commit's checks, by what GitHub reported, asking
 * GitHub nothing: once GitHub reports a commit other than the conflicting one, and its checks are green, it rejoins
 * its queue at the front, ahead of the entries waiting there; a failing check or a review requesting changes sends
 * it back, as a round; otherwise it waits, out of line.
 */
async function rejoin(context: Context, entry: Head): Promise<void> {
  return transaction(context.db, async (tx) => {
    const { rows: tickets } = await tx.query<{ id: string; projectId: string; workspaceId: string }>(
      `select tickets.id, tickets.project_id as "projectId", tickets.workspace_id as "workspaceId"
       from tickets where tickets.id = $1 for update`,
      [entry.ticketId],
    );
    const ticket = tickets[0];
    const { rows: entries } = await tx.query<{ updatedFrom: string | null }>(
      `select updated_from_sha as "updatedFrom" from merge_queue
       where pull_request_id = $1 and ticket_id = $2 and aside and state = 'waiting-for-checks' for update`,
      [entry.pullRequestId, entry.ticketId],
    );
    if (!ticket || !entries[0]) return;
    const pullRequest = await linkedPullRequest(tx, ticket, Number(entry.pullRequestId));
    if (!pullRequest || pullRequest.state !== "open") return;
    const { updatedFrom } = entries[0];
    // Until GitHub reports the resolving push, the conflicting commit's checks would be judged.
    if (updatedFrom !== null && pullRequest.sha === updatedFrom) return;
    if (updatedFrom !== null && (await hasChecks(tx, pullRequest.repositoryId, updatedFrom)) && !(await hasChecks(tx, pullRequest.repositoryId, pullRequest.sha))) {
      return;
    }
    const failure = (await failingCheckOn(tx, pullRequest.repositoryId, pullRequest.sha)) ?? (await failureOf(tx, pullRequest, "changes_requested"));
    if (failure) {
      const failed = { id: Number(pullRequest.id), repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url };
      if (await sendBackForFailure(context, tx, failed, failure, { ticketId: ticket.id, again: true })) {
        context.live.publish(tx, ticket.workspaceId, { type: "pull_requests.changed", projectId: ticket.projectId, ticketId: ticket.id });
      }
      return;
    }
    if (await pendingCheckOn(tx, pullRequest.repositoryId, pullRequest.sha)) return;
    // At the front: ahead of every entry waiting in its queue, behind none but one Cronk is acting on, which sorts first.
    await tx.query(
      `update merge_queue set aside = false, state = 'queued', updated_from_sha = null,
         seq = coalesce((select min(other.seq) - 1 from merge_queue other join pull_requests other_pr on other_pr.id = other.pull_request_id
           where other.pull_request_id <> $1 and not other.aside and other.state = 'queued'
             and other_pr.repository_id = $2 and coalesce(other_pr.base_branch, '') = coalesce($3, '')), seq)
       where pull_request_id = $1`,
      [entry.pullRequestId, pullRequest.repositoryId, await baseBranchOf(tx, entry.pullRequestId)],
    );
    context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  });
}

async function baseBranchOf(tx: Tx, pullRequestId: string): Promise<string | null> {
  const { rows } = await tx.query<{ branch: string | null }>("select base_branch as branch from pull_requests where id = $1", [pullRequestId]);
  return rows[0]?.branch ?? null;
}
