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
 * Project has agents may merge on, the Pull Request's checks on its latest commit are green with none pending, no
 * review still requests changes and GitHub says it is mergeable. It merges with the App's installation token by the
 * Repository's default merge method, only while the Pull Request's head is the commit Cronk judged. The Run finishes
 * with *merged*, and the merge completes the Ticket as Unverified, recorded as the Agent's in that Run.
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
 * The Repository's default merge method: the first its settings allow, of a merge commit, squashing and rebasing,
 * as GitHub defaults to them; a merge commit when GitHub doesn't say.
 */
function defaultMergeMethod(repository: RepositoryOnGitHub | undefined): MergeMethod {
  return mergeMethods.find(({ allowed }) => repository?.[allowed] === true)?.method ?? "merge";
}

/** How a Run that may not merge goes on instead: its Step's Outcome sending the work back, as a round. */
function sendBackAdvice(step: Step, why: string): string {
  const back = step.outcomes.find((o) => o.countsAsRound);
  return back
    ? `Finish with ${back.name}, saying in a Comment that ${why}: it goes back to be fixed, as a round.`
    : `Finish with ${step.outcomes.find((o) => o.needsYou)?.name ?? "needs you"}, saying that ${why}.`;
}

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

/** The Pull Request, by GitHub's id, if it is linked to the Ticket; locked, so its webhook waits for the merge to commit. */
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

/** Whether a check on the commit is still running, by what GitHub reported. */
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
  run: "A Pull Request is merged through Cronk only by the running Run of a Merge Step, by its own Agent.",
  mergeStep: "Only a Run of a Merge Step merges its Ticket's Pull Request.",
  linked: "A Merge Run merges only a Pull Request linked to its own Ticket.",
  autonomous: "Agents merge only Tickets under Autonomous Delegation.",
  agentsMayMerge: "Agents merge only in Projects with agents may merge on, which only an Admin turns on.",
  listed: "Cronk merges only Pull Requests of Repositories the Ticket's Project lists.",
  open: "Cronk merges only an open Pull Request that is ready for review.",
  checks: "Cronk merges only a Pull Request whose checks on its latest commit are green, with none pending.",
  reviews: "Cronk merges only a Pull Request no review still requests changes on.",
  mergeable: "Cronk merges only a Pull Request GitHub says is mergeable.",
  installed: "Cronk merges with the GitHub App's token, so only in Repositories the App is installed on.",
};

/**
 * Merges the Pull Request, by GitHub's id, for the Agent's running Merge Run, as the module says, and returns the
 * Run, finished with *merged*.
 */
export async function mergePullRequest(context: Context, caller: Caller, runId: string, pullRequestId: number): Promise<Run> {
  return transaction(context.db, async (tx) => {
    const { ticket, run } = await lockOwnRunningRun(tx, caller, runId, {
      rule: rules.run,
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
        advice: `Finish with ${step.outcomes.find((o) => o.default)?.name ?? "your Step's default Outcome"}, leaving the merge to a User.`,
      });
    }
    const { rows: projects } = await tx.query<{ agentsMayMerge: boolean }>(
      `select agents_may_merge as "agentsMayMerge" from projects where id = $1`,
      [ticket.projectId],
    );
    if (!projects[0]!.agentsMayMerge) {
      throw new ApiError(403, "agents_may_not_merge", `${ticket.key}'s Project has agents may merge off, so agents don't merge there.`, {
        rule: rules.agentsMayMerge,
        advice: `Finish with ${step.outcomes.find((o) => o.default)?.name ?? "your Step's default Outcome"}, leaving the merge to a User.`,
      });
    }
    if (pullRequest.listedAs === null) {
      throw new ApiError(409, "repository_not_listed", `${ticket.key}'s Project no longer lists ${pullRequest.repository}, so Cronk won't merge ${name}.`, {
        rule: rules.listed,
        advice: sendBackAdvice(step, `its Project no longer lists ${pullRequest.repository}`).replace(/, as a round.$/, "."),
      });
    }
    if (pullRequest.state !== "open") {
      const as = pullRequest.state === "draft" ? "a draft" : pullRequest.state;
      throw new ApiError(409, "pull_request_not_open", `${name} is ${as}, so it can't be merged.`, {
        rule: rules.open,
        advice:
          pullRequest.state === "draft"
            ? sendBackAdvice(step, `${name} is still a draft`)
            : `Read ${ticket.key} again: ${name} is ${as}. Finish with the Outcome that fits.`,
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

    const repositoryId = Number(pullRequest.repositoryId);
    const installationId = await installationCovering(context, repositoryId);
    if (installationId === undefined) {
      throw new ApiError(409, "repository_not_installed", `The GitHub App isn't installed on ${pullRequest.listedAs}, so Cronk can't merge ${name}.`, {
        rule: rules.installed,
        advice: `Finish with ${step.outcomes.find((o) => o.needsYou)?.name ?? "needs you"}, asking a User to install the App there.`,
      });
    }
    const token = await tokenFor(context, installationId);
    const onGitHub = await pullRequestOnGitHub(context.config, token, pullRequest.listedAs, pullRequest.number);
    const notMergeable = (message: string, advice: string) =>
      new ApiError(409, "not_mergeable", message, { rule: rules.mergeable, advice });
    if (!onGitHub || onGitHub.state !== "open" || onGitHub.merged) {
      throw notMergeable(`GitHub doesn't show ${name} open, so it can't be merged.`, `Read ${ticket.key} again, then finish with the Outcome that fits.`);
    }
    if (onGitHub.head.sha !== pullRequest.sha) {
      throw new ApiError(409, "checks_pending", `${name} has a commit Cronk hasn't heard of yet, so its checks aren't known.`, {
        rule: rules.checks,
        advice: "Wait for GitHub to report the push and its checks, reading the Ticket again, then merge.",
      });
    }
    if (onGitHub.mergeable === null) {
      throw notMergeable(
        `GitHub is still working out whether ${name} can be merged.`,
        "Wait a minute, then merge again.",
      );
    }
    if (!onGitHub.mergeable) {
      throw notMergeable(`GitHub says ${name} can't be merged, as when it has a merge conflict.`, sendBackAdvice(step, `${name} has a merge conflict`));
    }
    const repository = await repositoryById(context.config, token, repositoryId);
    const merged = await mergeOnGitHub(context.config, token, pullRequest.listedAs, pullRequest.number, {
      method: defaultMergeMethod(repository),
      sha: pullRequest.sha,
    });
    if (!merged.merged) {
      if (merged.status === 409) {
        throw new ApiError(409, "checks_pending", `${name} has a commit Cronk hasn't heard of yet, so its checks aren't known.`, {
          rule: rules.checks,
          advice: "Wait for GitHub to report the push and its checks, reading the Ticket again, then merge.",
        });
      }
      throw notMergeable(
        `GitHub refused to merge ${name}${merged.message ? `: ${merged.message}` : "."}`,
        sendBackAdvice(step, `GitHub refused to merge ${name}`),
      );
    }

    const now = context.clock.now();
    await endRunFinished(context, tx, run.id, mergedOutcome, now);
    // Kept at GitHub's last reported time, so GitHub's own delivery of the merge still updates it, completing nothing again.
    await tx.query("update pull_requests set state = 'merged' where id = $1", [pullRequest.id]);
    await completeMergedTickets(context, tx, {
      pullRequest: { id: Number(pullRequest.id), repository: pullRequest.repository, number: pullRequest.number, title: pullRequest.title, url: pullRequest.url },
      mergedBy: null,
      autoMerged: false,
      byAgent: { id: run.agentId, runId: run.id, ticketId: ticket.id },
    });
    const { rows: linked } = await tx.query<{ ticketId: string; projectId: string; workspaceId: string }>(
      `select distinct tickets.id as "ticketId", tickets.project_id as "projectId", tickets.workspace_id as "workspaceId"
       from pull_request_links join tickets on tickets.id = pull_request_links.ticket_id where pull_request_links.pull_request_id = $1`,
      [pullRequest.id],
    );
    for (const { ticketId, projectId, workspaceId } of linked) {
      context.live.publish(tx, workspaceId, { type: "pull_requests.changed", projectId, ticketId });
    }
    return presentRun(tx, caller, run.id);
  });
}
