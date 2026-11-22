import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../http/errors.js";
import { archivedRefusal } from "../identity/viewers.js";
import type { Caller } from "../identity/callers.js";
import { askMerge, linkedPullRequest, mergeAsAsked, type AskedMerge, type MergeAdvice } from "../pipeline/pull-request-merging.js";
import { statusesOf } from "../work/projects.js";
import type { Step } from "../work/steps.js";
import { lockOwnRunningRun, presentRun, type Run } from "./runs.js";

/**
 * Merges by agents (ADR 0005, ADR 0007): a Merge Step's running Run merges a Pull Request linked to its Ticket through
 * Cronk, never on GitHub directly. Cronk refuses, naming the rule, unless the Ticket has Autonomous Delegation and its
 * Project has agents may merge and Pull Request automation on; then Cronk merges as `pipeline/pull-request-merging.ts`
 * says, with its rules on the Pull Request. The Run finishes with *merged*, and the merge completes the Ticket as
 * Unverified, recorded as the Agent's in that Run.
 */

export { mergedOutcome } from "../pipeline/pull-request-merging.js";

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

/** What a Merge Run does instead of a merge Cronk refuses, by its Step's Outcomes. */
const runAdvice = (step: Step, ticketKey: string): MergeAdvice => ({
  sendBack: (why) => sendBackAdvice(step, why),
  needsYou: (what) => needsYouAdvice(step, what),
  readAgain: (seen) =>
    seen ? `Read ${ticketKey} again: ${seen}. Finish with the Outcome that fits.` : `Read ${ticketKey} again, then finish with the Outcome that fits.`,
});

const rules = {
  ownRunningRun: "A Pull Request is merged through Cronk only by the running Run of a Merge Step, by its own Agent.",
  mergeStep: "Only a Run of a Merge Step merges its Ticket's Pull Request.",
  linked: "A Merge Run merges only a Pull Request linked to its own Ticket.",
  autonomous: "Agents merge only Tickets under Autonomous Delegation.",
  agentsMayMerge: "Agents merge only in Projects with agents may merge on, which only an Admin turns on.",
  automation: "Agents merge only in Projects whose merges complete their Tickets, with Pull Request automation on.",
};

/**
 * Checks who may merge, the Run merging the Pull Request, then Cronk's rules on the Pull Request, and marks it as
 * asked for by the Run, in a transaction of its own.
 */
async function askMergeByRun(context: Context, caller: Caller, runId: string, pullRequestId: number): Promise<AskedMerge> {
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
    const { rows: projects } = await tx.query<{ agentsMayMerge: boolean; automation: boolean; archived: boolean }>(
      `select agents_may_merge as "agentsMayMerge", pull_request_automation as automation, archived_at is not null as archived
       from projects where id = $1`,
      [ticket.projectId],
    );
    // A merge in an archived Project would complete nothing there, so Cronk doesn't ask GitHub for one.
    if (projects[0]!.archived) throw archivedRefusal();
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
    return askMerge(tx, {
      ticket,
      pullRequest,
      actor: { kind: "agent", agentId: run.agentId, runId: run.id, workspaceId: ticket.workspaceId },
      completeAs: "unverified",
      advice: runAdvice(step, ticket.key),
    });
  });
}

/**
 * Merges the Pull Request, by GitHub's id, for the Agent's running Merge Run, as the module says, and returns the
 * Run, finished with *merged*.
 */
/** The merge route's body: which of the Ticket's Pull Requests to merge. */
export const RunMerge = Type.Object({
  pullRequestId: Type.Integer({ description: "GitHub's id for the Pull Request, as the Ticket's Pull Requests list it." }),
});
export type RunMerge = Static<typeof RunMerge>;

export async function mergePullRequest(context: Context, caller: Caller, runId: string, pullRequestId: number): Promise<Run> {
  const asked = await askMergeByRun(context, caller, runId, pullRequestId);
  return mergeAsAsked(context, asked, (tx) => presentRun(tx, caller, runId));
}
