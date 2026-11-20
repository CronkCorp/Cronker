import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { mergeOnGitHub, pullRequestOnGitHub, repositoryById, type MergeMethod, type RepositoryOnGitHub } from "../github/client.js";
import { installationCovering, tokenFor } from "../github/installations.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import { completeMergedTickets } from "../pipeline/merges.js";
import { failingCheckOn } from "../pipeline/sending-back.js";
import { statusesOf } from "../work/projects.js";
import type { Step } from "../work/steps.js";
import { endRunFinished, lockOwnRunningRun, presentRun, type Run } from "./runs.js";

/**
 * Merges by agents (ADR 0005, ADR 0007): a Merge Step's running Run merges a Pull Request linked to its Ticket through
 * Cronk, never on GitHub directly. Cronk refuses, naming the rule, unless the Ticket has Autonomous Delegation, its
 * Project has agents may merge and Pull Request automation on, the Pull Request is open, its checks on its latest
 * commit are green with none pending, no review still requests changes and GitHub says it is mergeable. It merges with
 * the App's installation token by the Repository's default merge method, only while the Pull Request's head is the
 * commit Cronk judged. The Run finishes with *merged*, and the merge completes the Ticket as Unverified, recorded as
 * the Agent's in that Run.
 *
 * No lock is held while GitHub is asked: Cronk checks its rules and marks the Pull Request as asked for by the Run,
 * asks GitHub, then records the merge. GitHub's own delivery of the merge, arriving first, records it the same way.
 */

/** The Outcome a Run that merged finishes with. */
export const mergedOutcome = "merged";

/** The merge methods GitHub offers, in the order GitHub's own merge button and API default to them. */
const mergeMethods: { method: MergeMethod; allowed: keyof RepositoryOnGitHub }[] = [
  { method: "merge", allowed: "allow_merge_commit" },
  { method: "squash", allowed: "allow_squash_merge" },
  { method: "rebase", allowed: "allow_rebase_merge" },
];

/**
 * The Repository's default merge method: the first its settings allow, of a merge commit, squashing and rebasing, as
 * GitHub defaults to them; GitHub's own default when it doesn't say which it allows.
 */
function defaultMergeMethod(repository: RepositoryOnGitHub | undefined): MergeMethod | undefined {
  return mergeMethods.find(({ allowed }) => repository?.[allowed] === true)?.method;
}

/** The name of the Step's Outcome of the kind, or a description of it when the Step has none. */
function outcomeNamed(step: Step, kind: "default" | "needsYou" | "countsAsRound"): string {
  const fallback = { default: "your Step's default Outcome", needsYou: "needs you", countsAsRound: "the Outcome sending it back" };
  return step.outcomes.find((o) => o[kind])?.name ?? fallback[kind];
}

/** What a Run that may not merge does instead: sends the work back, as a round, for what Implement can fix. */
const sendBackAdvice = (step: Step, why: string) =>
  `Finish with ${outcomeNamed(step, "countsAsRound")}, saying in a Comment that ${why}: it goes back to be fixed, as a round.`;

/** What a Run that may not merge does instead: hands the Ticket to its Assignee, for what only a User can fix. */
const needsYouAdvice = (step: Step, what: string) => `Finish with ${outcomeNamed(step, "needsYou")}, asking in your Question for ${what}.`;

/** What a Run that may not merge does instead: leaves the merge to a User. */
const leaveToUserAdvice = (step: Step) => `Finish with ${outcomeNamed(step, "default")}, leaving the merge to a User.`;

interface LinkedPullRequest {
  id: string;
  repositoryId: string;
  repository: string;
  /** Its Repository's `owner/name` now, while the Ticket's Project still lists it. */
  listedAs: string | null;
  number: number;
  title: string;
  url: string;
  sha: string;
  state: "open" | "draft" | "merged" | "closed";
}

/** The Pull Request, by GitHub's id, if it is linked to the Ticket; locked, until the Run has marked it as asked for. */
async function linkedPullRequest(tx: Tx, ticket: { id: string; projectId: string }, pullRequestId: number): Promise<LinkedPullRequest | undefined> {
  const { rows } = await tx.query<LinkedPullRequest>(
    `select pull_requests.id, pull_requests.repository_id as "repositoryId", pull_requests.repository_full_name as repository,
       (select repositories.full_name from repositories join project_repositories
          on project_repositories.repository_id = repositories.id and project_repositories.project_id = $3
        where repositories.id = pull_requests.repository_id) as "listedAs",
       pull_requests.number, pull_requests.title, pull_requests.url, pull_requests.head_sha as sha, pull_requests.state
     from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
     where pull_request_links.ticket_id = $1 and pull_requests.id = $2
     for update of pull_requests`,
    [ticket.id, pullRequestId, ticket.projectId],
  );
  return rows[0];
}

/** A check still running on the commit, by what GitHub reported, by its name. */
async function pendingCheckOn(tx: Tx, repositoryId: string, sha: string): Promise<string | null> {
  const { rows } = await tx.query<{ name: string }>(
    `select name from commit_checks where repository_id = $1 and sha = $2 and state = 'pending' order by lower(name), name limit 1`,
    [repositoryId, sha],
  );
  return rows[0]?.name ?? null;
}

/** A review still requesting changes on the Pull Request, by its reviewer's login. */
async function changesRequestedOn(tx: Tx, pullRequestId: string): Promise<string | null> {
  const { rows } = await tx.query<{ reviewer: string }>(
    `select reviewer from pull_request_reviews where pull_request_id = $1 and state = 'changes_requested' order by review_id limit 1`,
    [pullRequestId],
  );
  return rows[0]?.reviewer ?? null;
}

const rules = {
  ownRunningRun: "A Pull Request is merged through Cronk only by the running Run of a Merge Step, by its own Agent.",
  mergeStep: "Only a Run of a Merge Step merges its Ticket's Pull Request.",
  linked: "A Merge Run merges only a Pull Request linked to its own Ticket.",
  autonomous: "Agents merge only Tickets under Autonomous Delegation.",
  agentsMayMerge: "Agents merge only in Projects with agents may merge on, which only an Admin turns on.",
  automation: "Agents merge only in Projects whose merges complete their Tickets, with Pull Request automation on.",
  listed: "Cronk merges only Pull Requests of Repositories the Ticket's Project lists.",
  open: "Cronk merges only an open Pull Request that is ready for review.",
  checks: "Cronk merges only a Pull Request whose checks on its latest commit are green, with none pending.",
  reviews: "Cronk merges only a Pull Request no review still requests changes on.",
  mergeable: "Cronk merges only a Pull Request GitHub says is mergeable.",
  installed: "Cronk merges with the GitHub App's token, so only in Repositories the App is installed on.",
};

/** The refusal for a Pull Request whose latest commit Cronk hasn't heard of, so whose checks it doesn't know. */
const unknownCommit = (name: string) =>
  new ApiError(409, "checks_pending", `${name} has a commit Cronk hasn't heard of yet, so its checks aren't known.`, {
    rule: rules.checks,
    advice: "Wait for GitHub to report the push and its checks, reading the Ticket again, then merge.",
  });

/** What the Run asks GitHub to merge, once Cronk's own rules allow it. */
interface AskedMerge {
  step: Step;
  ticketKey: string;
  pullRequest: LinkedPullRequest & { listedAs: string };
}

/**
 * Checks Cronk's own rules for the Run merging the Pull Request and marks it as asked for by the Run, in a
 * transaction of its own.
 */
async function askMerge(context: Context, caller: Caller, runId: string, pullRequestId: number): Promise<AskedMerge> {
  return transaction(context.db, async (tx) => {
    const { ticket, run } = await lockOwnRunningRun(tx, caller, runId, {
      rule: rules.ownRunningRun,
      action: "merges with it",
      notRunning: "can't merge",
    });
    const statuses = await statusesOf(tx, ticket.projectId);
    const step = statuses.find((s) => s.id === run.statusId)?.step;
    if (step?.kind !== "merge") {
      throw new ApiError(403, "not_merge_step", `This Run is of the ${run.step.name} Step, which isn't a Merge Step, so it can't merge.`, {
        rule: rules.mergeStep,
        advice: `Finish this Run with one of its Outcomes; ${ticket.key}'s Merge Step merges it once it gets there.`,
      });
    }
    const pullRequest = await linkedPullRequest(tx, ticket, pullRequestId);
    if (!pullRequest) {
      throw new ApiError(403, "pull_request_not_linked", `That Pull Request isn't linked to ${ticket.key}.`, {
        rule: rules.linked,
        advice: `Read ${ticket.key} with read_ticket: its Pull Requests are listed with their ids. Merge one of those.`,
      });
    }
    const name = `${pullRequest.repository}#${pullRequest.number}`;
    if (ticket.autonomousDelegation !== true) {
      throw new ApiError(403, "no_autonomous_delegation", `${ticket.key} isn't under Autonomous Delegation, so agents don't merge it.`, {
        rule: rules.autonomous,
        advice: leaveToUserAdvice(step),
      });
    }
    const { rows: projects } = await tx.query<{ agentsMayMerge: boolean; automation: boolean }>(
      `select agents_may_merge as "agentsMayMerge", pull_request_automation as automation from projects where id = $1`,
      [ticket.projectId],
    );
    if (!projects[0]!.agentsMayMerge) {
      throw new ApiError(403, "agents_may_not_merge", `${ticket.key}'s Project has agents may merge off, so agents don't merge there.`, {
        rule: rules.agentsMayMerge,
        advice: leaveToUserAdvice(step),
      });
    }
    if (!projects[0]!.automation) {
      throw new ApiError(
        409,
        "pull_request_automation_off",
        `${ticket.key}'s Project has Pull Request automation off, so a merge wouldn't complete it.`,
        { rule: rules.automation, advice: leaveToUserAdvice(step) },
      );
    }
    const { listedAs } = pullRequest;
    if (listedAs === null) {
      throw new ApiError(409, "repository_not_listed", `${ticket.key}'s Project no longer lists ${pullRequest.repository}, so Cronk won't merge ${name}.`, {
        rule: rules.listed,
        advice: needsYouAdvice(step, `what to do with ${name}, whose Repository the Project no longer lists`),
      });
    }
    if (pullRequest.state !== "open") {
      const shownState = pullRequest.state === "draft" ? "a draft" : pullRequest.state;
      throw new ApiError(409, "pull_request_not_open", `${name} is ${shownState}, so it can't be merged.`, {
        rule: rules.open,
        advice:
          pullRequest.state === "draft"
            ? sendBackAdvice(step, `${name} is still a draft`)
            : `Read ${ticket.key} again: ${name} is ${shownState}. Finish with the Outcome that fits.`,
      });
    }
    const failing = await failingCheckOn(tx, pullRequest.repositoryId, pullRequest.sha);
    if (failing) {
      const check = failing.kind === "check" ? failing.name : "a check";
      throw new ApiError(409, "checks_failing", `The check ${check} failed on ${name}'s latest commit, so it can't be merged.`, {
        rule: rules.checks,
        advice: sendBackAdvice(step, `the check ${check} failed`),
      });
    }
    const pending = await pendingCheckOn(tx, pullRequest.repositoryId, pullRequest.sha);
    if (pending) {
      throw new ApiError(409, "checks_pending", `The check ${pending} is still running on ${name}'s latest commit, so it can't be merged yet.`, {
        rule: rules.checks,
        advice: "Wait for the checks to finish, reading the Ticket again, then merge; send it back if one fails.",
      });
    }
    const reviewer = await changesRequestedOn(tx, pullRequest.id);
    if (reviewer !== null) {
      throw new ApiError(409, "changes_requested", `@${reviewer} still requests changes on ${name}, so it can't be merged.`, {
        rule: rules.reviews,
        advice: sendBackAdvice(step, `@${reviewer} requested changes`),
      });
    }
    await tx.query("update pull_requests set merge_asked_by_run_id = $2 where id = $1", [pullRequest.id, run.id]);
    return { step, ticketKey: ticket.key, pullRequest: { ...pullRequest, listedAs } };
  });
}

/** Asks GitHub to merge the Pull Request, refusing, as Cronk's rules say, when GitHub says it can't be merged. */
async function mergeAsAsked(context: Context, { step, ticketKey, pullRequest }: AskedMerge): Promise<void> {
  const name = `${pullRequest.repository}#${pullRequest.number}`;
  const repositoryId = Number(pullRequest.repositoryId);
  const installationId = await installationCovering(context, repositoryId);
  if (installationId === undefined) {
    throw new ApiError(409, "repository_not_installed", `The GitHub App isn't installed on ${pullRequest.listedAs}, so Cronk can't merge ${name}.`, {
      rule: rules.installed,
      advice: needsYouAdvice(step, `a User to install the GitHub App on ${pullRequest.listedAs}`),
    });
  }
  const token = await tokenFor(context, installationId);
  const notMergeable = (message: string, advice: string) => new ApiError(409, "not_mergeable", message, { rule: rules.mergeable, advice });
  const onGitHub = await pullRequestOnGitHub(context.config, token, pullRequest.listedAs, pullRequest.number);
  if (!onGitHub || onGitHub.state !== "open" || onGitHub.merged) {
    throw notMergeable(`GitHub doesn't show ${name} open, so it can't be merged.`, `Read ${ticketKey} again, then finish with the Outcome that fits.`);
  }
  if (onGitHub.head.sha !== pullRequest.sha) throw unknownCommit(name);
  if (onGitHub.mergeable === null) {
    throw notMergeable(`GitHub is still working out whether ${name} can be merged.`, "Wait a minute, then merge again.");
  }
  if (!onGitHub.mergeable) {
    throw notMergeable(`GitHub says ${name} can't be merged, as when it has a merge conflict.`, sendBackAdvice(step, `${name} has a merge conflict`));
  }
  const repository = await repositoryById(context.config, token, repositoryId);
  const merged = await mergeOnGitHub(context.config, token, pullRequest.listedAs, pullRequest.number, {
    method: defaultMergeMethod(repository),
    sha: pullRequest.sha,
  });
  if (merged.merged) return;
  if (merged.status === 409) throw unknownCommit(name);
  // Such as branch protection or the Repository's settings, which Implement can't change.
  throw notMergeable(
    `GitHub refused to merge ${name}${merged.message ? `: ${merged.message}` : "."}`,
    needsYouAdvice(step, `what GitHub needs before ${name} can be merged`),
  );
}

/**
 * Merges the Pull Request, by GitHub's id, for the Agent's running Merge Run, as the module says, and returns the
 * Run, finished with *merged*.
 */
export async function mergePullRequest(context: Context, caller: Caller, runId: string, pullRequestId: number): Promise<Run> {
  const asked = await askMerge(context, caller, runId, pullRequestId);
  try {
    await mergeAsAsked(context, asked);
  } catch (error) {
    // Unless GitHub merged it after all, as its delivery of the merge would have recorded meanwhile.
    await context.db.query(
      "update pull_requests set merge_asked_by_run_id = null where id = $1 and merge_asked_by_run_id = $2",
      [asked.pullRequest.id, runId],
    );
    throw error;
  }
  return transaction(context.db, async (tx) => {
    await recordMergeAskedByRun(context, tx, pullRequestId);
    return presentRun(tx, caller, runId);
  });
}

/**
 * Records the merge of a Pull Request a Run asked Cronk for, once, whether Cronk hears of it from GitHub's answer or
 * from GitHub's delivery of the merge, whichever comes first; says whether it recorded it. The Run, if still running,
 * finishes with *merged*, and the merge completes the Tickets the Pull Request links as Unverified, recorded as the
 * Run's Agent's in the Run's Workspace.
 */
export async function recordMergeAskedByRun(context: Context, tx: Tx, pullRequestId: number): Promise<boolean> {
  const { rows } = await tx.query<{
    runId: string | null;
    repository: string;
    number: number;
    title: string;
    url: string;
  }>(
    `select merge_asked_by_run_id as "runId", repository_full_name as repository, number, title, url
     from pull_requests where id = $1 for update`,
    [pullRequestId],
  );
  const pullRequest = rows[0];
  if (!pullRequest?.runId) return false;
  const { rows: runs } = await tx.query<{ agentId: string; agentName: string; workspaceId: string; ticketId: string; running: boolean }>(
    `select runs.agent_id as "agentId", agents.name as "agentName", runs.workspace_id as "workspaceId", runs.ticket_id as "ticketId",
       runs.state = 'running' as running
     from runs join agents on agents.id = runs.agent_id where runs.id = $1`,
    [pullRequest.runId],
  );
  const run = runs[0]!;
  await tx.query("update pull_requests set state = 'merged', merge_asked_by_run_id = null where id = $1", [pullRequestId]);
  // The Ticket is locked before its Run, as everywhere.
  await tx.query("select from tickets where id = $1 for update", [run.ticketId]);
  if (run.running) await endRunFinished(context, tx, pullRequest.runId, mergedOutcome, context.clock.now());
  const { runId, repository, number, title, url } = pullRequest;
  await completeMergedTickets(context, tx, {
    pullRequest: { id: pullRequestId, repository, number, title, url },
    mergedBy: null,
    autoMerged: false,
    byAgent: { id: run.agentId, name: run.agentName, runId, workspaceId: run.workspaceId },
  });
  const { rows: linked } = await tx.query<{ ticketId: string; projectId: string; workspaceId: string }>(
    `select tickets.id as "ticketId", tickets.project_id as "projectId", tickets.workspace_id as "workspaceId"
     from pull_request_links join tickets on tickets.id = pull_request_links.ticket_id where pull_request_links.pull_request_id = $1`,
    [pullRequestId],
  );
  for (const { ticketId, projectId, workspaceId } of linked) {
    context.live.publish(tx, workspaceId, { type: "pull_requests.changed", projectId, ticketId });
  }
  return true;
}
