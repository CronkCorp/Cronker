import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import {
  mergeOnGitHub,
  pullRequestOnGitHub,
  repositoryById,
  updateBranchOnGitHub,
  type MergeMethod,
  type RepositoryOnGitHub,
} from "../github/client.js";
import { installationCovering, tokenFor } from "../github/installations.js";
import { ApiError } from "../http/errors.js";
import { endRunFinished } from "../runs/runs.js";
import { completeMergedTickets, type Merge } from "./merges.js";
import { failingCheckOn } from "./sending-back.js";

/**
 * Pipeline: Cronk merging a Pull Request linked to a Ticket, for whoever its caller says merges it, with no Run
 * required (ADR 0005, ADR 0007). Cronk refuses, naming the rule, unless the Ticket's Project lists the Pull Request's
 * Repository, the Pull Request is open, its checks on its latest commit are green with none pending, no review still
 * requests changes and GitHub says it is mergeable. It merges with the App's installation token by the Repository's
 * default merge method, only while the Pull Request's head is the commit Cronk judged, and records the merge as its
 * actor's, completing the Ticket as the caller says. Who may ask for a merge is the caller's to check first.
 *
 * No lock is held while GitHub is asked: Cronk checks its rules and marks the Pull Request as asked for by the actor,
 * asks GitHub, then records the merge. GitHub's own delivery of the merge, arriving first, records it the same way.
 */

/** The Outcome a Run that merged finishes with. */
export const mergedOutcome = "merged";

/**
 * Who asked Cronk for the merge, recorded as its merger: an Agent, in its Run if it has one, or a User, each in the
 * Workspace whose Tickets' Changes are theirs.
 */
export type MergeActor =
  | { kind: "agent"; agentId: string; runId: string | null; workspaceId: string }
  | { kind: "user"; userId: string; name: string; workspaceId: string };

/** How the merge completes the Tickets it links. */
export type CompleteAs = "verified" | "unverified";

/** What the caller advises, in its own words, when Cronk refuses the merge. */
export interface MergeAdvice {
  /** For what the work's author can fix: `why` says what is wrong. */
  sendBack(why: string): string;
  /** For what only a User can fix: `what` says what is needed. */
  needsYou(what: string): string;
  /** For a Pull Request no longer open: `seen` says how Cronk saw it, null when GitHub says so. */
  readAgain(seen: string | null): string;
}

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

export interface LinkedPullRequest {
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

/** The Pull Request, by GitHub's id, if it is linked to the Ticket; locked, until it is marked as asked for. */
export async function linkedPullRequest(
  tx: Tx,
  ticket: { id: string; projectId: string },
  pullRequestId: number,
): Promise<LinkedPullRequest | undefined> {
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
  listed: "Cronk merges only Pull Requests of Repositories the Ticket's Project lists.",
  open: "Cronk merges only an open Pull Request that is ready for review.",
  checks: "Cronk merges only a Pull Request whose checks on its latest commit are green, with none pending.",
  reviews: "Cronk merges only a Pull Request no review still requests changes on.",
  mergeable: "Cronk merges only a Pull Request GitHub says is mergeable.",
  installed: "Cronk merges with the GitHub App's token, so only in Repositories the App is installed on.",
  upToDate: "The Merge Queue merges only a Pull Request whose branch is up to date with its base branch.",
};

/** The refusal `mergeAsAsked` gives, when asked to, for a Pull Request whose base branch has commits its head lacks. */
export const behindCode = "behind";

/** The refusal for a Pull Request whose latest commit Cronk hasn't heard of, so whose checks it doesn't know. */
const unknownCommit = (name: string) =>
  new ApiError(409, "checks_pending", `${name} has a commit Cronk hasn't heard of yet, so its checks aren't known.`, {
    rule: rules.checks,
    advice: "Wait for GitHub to report the push and its checks, reading the Ticket again, then merge.",
  });

/**
 * GitHub's own refusal of a merge Cronk's rules allowed, such as one branch protection, required approvals, a ruleset
 * or GitHub's own merge queue forbids, with the reason GitHub gave, if any.
 */
export class GitHubRefusedMerge extends ApiError {
  constructor(
    message: string,
    advice: string,
    readonly reason: string | null,
  ) {
    super(409, "not_mergeable", message, { rule: rules.mergeable, advice });
  }
}

/** What the marker on a Pull Request asked for, held until Cronk records the merge or GitHub refuses it. */
interface MergeAsked {
  actor: MergeActor;
  completeAs: CompleteAs;
  /** Set when the Merge Queue asked for it, so the merge completes a Ticket only with its last queued Pull Request. */
  queue?: true;
}

/** A merge Cronk's own rules allowed and marked as asked for, for GitHub to be asked. */
export interface AskedMerge {
  ticketKey: string;
  pullRequest: LinkedPullRequest & { listedAs: string };
  asked: MergeAsked;
  advice: MergeAdvice;
}

/**
 * Checks Cronk's own rules for merging the Pull Request, linked to the Ticket and locked by `linkedPullRequest` in
 * the same transaction, and marks it as asked for by the actor.
 */
export async function askMerge(
  tx: Tx,
  request: {
    ticket: { key: string };
    pullRequest: LinkedPullRequest;
    actor: MergeActor;
    completeAs: CompleteAs;
    /** Whether the Merge Queue asks for it. */
    viaQueue?: boolean;
    advice: MergeAdvice;
  },
): Promise<AskedMerge> {
  const { ticket, pullRequest, advice } = request;
  const name = `${pullRequest.repository}#${pullRequest.number}`;
  const { listedAs } = pullRequest;
  if (listedAs === null) {
    throw new ApiError(409, "repository_not_listed", `${ticket.key}'s Project no longer lists ${pullRequest.repository}, so Cronk won't merge ${name}.`, {
      rule: rules.listed,
      advice: advice.needsYou(`what to do with ${name}, whose Repository the Project no longer lists`),
    });
  }
  if (pullRequest.state !== "open") {
    const shownState = pullRequest.state === "draft" ? "a draft" : pullRequest.state;
    throw new ApiError(409, "pull_request_not_open", `${name} is ${shownState}, so it can't be merged.`, {
      rule: rules.open,
      advice: pullRequest.state === "draft" ? advice.sendBack(`${name} is still a draft`) : advice.readAgain(`${name} is ${shownState}`),
    });
  }
  const failing = await failingCheckOn(tx, pullRequest.repositoryId, pullRequest.sha);
  if (failing) {
    const check = failing.kind === "check" ? failing.name : "a check";
    throw new ApiError(409, "checks_failing", `The check ${check} failed on ${name}'s latest commit, so it can't be merged.`, {
      rule: rules.checks,
      advice: advice.sendBack(`the check ${check} failed`),
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
      advice: advice.sendBack(`@${reviewer} requested changes`),
    });
  }
  const asked: MergeAsked = { actor: request.actor, completeAs: request.completeAs, ...(request.viaQueue ? { queue: true } : {}) };
  await tx.query("update pull_requests set merge_asked_by = $2 where id = $1", [pullRequest.id, JSON.stringify(asked)]);
  return { ticketKey: ticket.key, pullRequest: { ...pullRequest, listedAs }, asked, advice };
}

/** How Cronk asks GitHub for a merge. */
export interface MergeOptions {
  /**
   * Refuses, with `behindCode`, a Pull Request GitHub says is behind its base branch, rather than asking GitHub to
   * merge it, so the caller can update its branch first.
   */
  refuseBehind?: boolean;
}

/** The installation token for the Pull Request's Repository, refusing, as Cronk's rules say, where the App isn't installed. */
async function tokenForPullRequest(context: Context, pullRequest: AskedMerge["pullRequest"], advice: MergeAdvice): Promise<string> {
  const installationId = await installationCovering(context, Number(pullRequest.repositoryId));
  if (installationId === undefined) {
    const name = `${pullRequest.repository}#${pullRequest.number}`;
    throw new ApiError(409, "repository_not_installed", `The GitHub App isn't installed on ${pullRequest.listedAs}, so Cronk can't merge ${name}.`, {
      rule: rules.installed,
      advice: advice.needsYou(`a User to install the GitHub App on ${pullRequest.listedAs}`),
    });
  }
  return tokenFor(context, installationId);
}

/** Asks GitHub to merge the Pull Request, refusing, as Cronk's rules say, when GitHub says it can't be merged. */
async function askGitHub(context: Context, { pullRequest, advice }: AskedMerge, options: MergeOptions): Promise<void> {
  const name = `${pullRequest.repository}#${pullRequest.number}`;
  const repositoryId = Number(pullRequest.repositoryId);
  const token = await tokenForPullRequest(context, pullRequest, advice);
  const notMergeable = (message: string, advice: string) => new ApiError(409, "not_mergeable", message, { rule: rules.mergeable, advice });
  const onGitHub = await pullRequestOnGitHub(context.config, token, pullRequest.listedAs, pullRequest.number);
  if (!onGitHub || onGitHub.state !== "open" || onGitHub.merged) {
    throw notMergeable(`GitHub doesn't show ${name} open, so it can't be merged.`, advice.readAgain(null));
  }
  if (onGitHub.head.sha !== pullRequest.sha) throw unknownCommit(name);
  if (onGitHub.mergeable === null) {
    throw notMergeable(`GitHub is still working out whether ${name} can be merged.`, "Wait a minute, then merge again.");
  }
  if (!onGitHub.mergeable) {
    throw notMergeable(`GitHub says ${name} can't be merged, as when it has a merge conflict.`, advice.sendBack(`${name} has a merge conflict`));
  }
  if (options.refuseBehind && onGitHub.mergeable_state === "behind") {
    throw new ApiError(409, behindCode, `${name}'s base branch has commits its branch lacks, so it is updated before it merges.`, {
      rule: rules.upToDate,
      advice: "Update its branch, then wait for the new commit's checks.",
    });
  }
  const repository = await repositoryById(context.config, token, repositoryId);
  const merged = await mergeOnGitHub(context.config, token, pullRequest.listedAs, pullRequest.number, {
    method: defaultMergeMethod(repository),
    sha: pullRequest.sha,
  });
  if (merged.merged) return;
  if (merged.status === 409) throw unknownCommit(name);
  // Such as branch protection or the Repository's settings, which the work's author can't change.
  throw new GitHubRefusedMerge(
    `GitHub refused to merge ${name}${merged.message ? `: ${merged.message}` : "."}`,
    advice.needsYou(`what GitHub needs before ${name} can be merged`),
    merged.message || null,
  );
}

/**
 * Asks GitHub for the merge `askMerge` allowed, with no lock held, then records it and runs `then` in the
 * transaction that recorded it. When GitHub refuses, the Pull Request is no longer marked as asked for, unless GitHub
 * merged it after all, as its delivery of the merge would have recorded meanwhile.
 */
export async function mergeAsAsked<T>(
  context: Context,
  asked: AskedMerge,
  then: (tx: Tx) => Promise<T>,
  options: MergeOptions = {},
): Promise<T> {
  try {
    await askGitHub(context, asked, options);
  } catch (error) {
    await context.db.query("update pull_requests set merge_asked_by = null where id = $1 and merge_asked_by = $2::jsonb", [
      asked.pullRequest.id,
      JSON.stringify(asked.asked),
    ]);
    throw error;
  }
  return transaction(context.db, async (tx) => {
    await recordAskedMerge(context, tx, Number(asked.pullRequest.id));
    return then(tx);
  });
}

/**
 * Asks GitHub to bring the Pull Request's branch up to date with its base branch, merging the base into it, only while
 * its head is still the commit Cronk judged. Says whether GitHub took it on, as it does in the background; refuses, as
 * Cronk's rules say, where the App isn't installed.
 */
export async function updateBranch(context: Context, { pullRequest, advice }: Pick<AskedMerge, "pullRequest" | "advice">): Promise<boolean> {
  const token = await tokenForPullRequest(context, pullRequest, advice);
  const updated = await updateBranchOnGitHub(context.config, token, pullRequest.listedAs, pullRequest.number, pullRequest.sha);
  return updated.updated;
}

/**
 * Records the merge of a Pull Request someone asked Cronk for, once, whether Cronk hears of it from GitHub's answer
 * or from GitHub's delivery of the merge, whichever comes first; says whether it recorded it. An Agent's Run, if
 * still running, finishes with *merged*, and the merge completes the Tickets the Pull Request links as asked,
 * recorded as the actor's in the actor's Workspace.
 */
export async function recordAskedMerge(context: Context, tx: Tx, pullRequestId: number): Promise<boolean> {
  const { rows } = await tx.query<{ asked: MergeAsked | null; repository: string; number: number; title: string; url: string }>(
    `select merge_asked_by as asked, repository_full_name as repository, number, title, url
     from pull_requests where id = $1 for update`,
    [pullRequestId],
  );
  const pullRequest = rows[0];
  if (!pullRequest?.asked) return false;
  const { actor, completeAs, queue } = pullRequest.asked;
  const by = await mergerOf(tx, actor);
  if (!by) {
    await tx.query("update pull_requests set merge_asked_by = null where id = $1", [pullRequestId]);
    return false;
  }
  await tx.query("update pull_requests set state = 'merged', merge_asked_by = null where id = $1", [pullRequestId]);
  if (by.run) {
    // The Ticket is locked before its Run, as everywhere.
    await tx.query("select from tickets where id = $1 for update", [by.run.ticketId]);
    if (by.run.running) await endRunFinished(context, tx, by.run.id, mergedOutcome, context.clock.now());
  }
  const { repository, number, title, url } = pullRequest;
  await completeMergedTickets(context, tx, {
    pullRequest: { id: pullRequestId, repository, number, title, url },
    mergedBy: null,
    autoMerged: false,
    ...by.merge,
    verification: completeAs,
    viaQueue: queue === true,
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

/**
 * The merger the actor stands for, with the Agent's Run if it asked in one; none when the actor or its Run is gone
 * meanwhile, which leaves the merge to be recorded as GitHub reports it.
 */
async function mergerOf(
  tx: Tx,
  actor: MergeActor,
): Promise<{ merge: Pick<Merge, "byAgent" | "byUser">; run?: { id: string; ticketId: string; running: boolean } } | undefined> {
  if (actor.kind === "user") {
    const { rows } = await tx.query("select from users where id = $1", [actor.userId]);
    if (rows.length === 0) return undefined;
    return { merge: { byUser: { id: actor.userId, name: actor.name, workspaceId: actor.workspaceId } } };
  }
  const { rows: agents } = await tx.query<{ name: string }>("select name from agents where id = $1", [actor.agentId]);
  if (!agents[0]) return undefined;
  const { rows: runs } = actor.runId
    ? await tx.query<{ ticketId: string; running: boolean }>(
        `select ticket_id as "ticketId", state = 'running' as running from runs where id = $1`,
        [actor.runId],
      )
    : { rows: [] };
  const run = runs[0] && actor.runId ? { id: actor.runId, ...runs[0] } : undefined;
  if (actor.runId && !run) return undefined;
  return {
    merge: { byAgent: { id: actor.agentId, name: agents[0].name, runId: run?.id ?? null, workspaceId: actor.workspaceId } },
    run,
  };
}
