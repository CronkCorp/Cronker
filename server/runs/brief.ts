import { Type, type Static } from "typebox";
import type { Config } from "../config.js";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import type { Viewer } from "../identity/viewers.js";
import { mcpPath } from "../mcp/routes.js";
import { statusesOf, type Status } from "../work/projects.js";
import type { Outcome, Step } from "../work/steps.js";
import { findTicketRow, ticketNotFound } from "../work/tickets.js";

/** The instructions a Run starts from, in its three parts and as the one text the Run is sent. */
export const Brief = Type.Object({
  preamble: Type.String({
    description: "Cronk's fixed preamble: how to reach Cronk, the Run's id, the Outcomes the Run may choose and the rules.",
  }),
  brief: Type.String({ description: "The Step's own Brief, in Markdown." }),
  ticketKey: Type.String({ description: "The Ticket's key, the subject line the Brief ends with." }),
  text: Type.String({ description: "The three parts joined, as a Run receives them." }),
});
export type Brief = Static<typeof Brief>;

/**
 * The Brief a Run on the Ticket would start from in its Status now, before the Run exists,
 * so the Run id is not yet known.
 */
export async function previewBrief({ db, config }: Context, viewer: Viewer, ticketId: string): Promise<Brief> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const statuses = await statusesOf(db, ticket.projectId);
  const status = statuses.find((s) => s.id === ticket.statusId)!;
  if (!status.step) {
    throw new ApiError(
      409,
      "status_has_no_step",
      `${ticket.key} is in ${status.name}, which has no Step: Tickets there wait for a User, and get no Run.`,
    );
  }
  return buildBrief(config, ticket.key, statuses, status as Status & { step: Step }, ticket.autonomousDelegation === true);
}

/** The Outcomes a Run of the Step may choose: those to a Done Status only on a Ticket under Autonomous Delegation. */
export function offeredOutcomes(step: Step, statuses: Status[], autonomous: boolean): Outcome[] {
  return step.outcomes.filter((o) => autonomous || !completes(o, statuses));
}

/** Whether the Outcome completes its Ticket, moving it to a Done Status. */
export function completes(outcome: Outcome, statuses: Status[]): boolean {
  return statuses.find((s) => s.id === outcome.statusId)!.kind === "done";
}

/** The Brief of a Run of the Status's Step on the Ticket; without a Run id, as a preview. */
export function buildBrief(
  config: Config,
  ticketKey: string,
  statuses: Status[],
  status: Status & { step: Step },
  autonomous: boolean,
  runId?: string,
): Brief {
  const step = status.step;
  const nameOf = (statusId: string) => statuses.find((s) => s.id === statusId)!.name;
  const outcomeLine = (o: Outcome) => {
    const moves = `- **${o.name}**: moves ${ticketKey} to ${nameOf(o.statusId)}`;
    if (completes(o, statuses)) {
      return `${moves}, completing it as Unverified until its Assignee Accepts or Reopens it.`;
    }
    if (o.needsYou) return `${moves} and hands it back to its Assignee. Give a Question saying what you need.`;
    if (o.countsAsRound) {
      return `${moves}. It counts as a round: after ${step.roundLimit}, the Step's *needs you* Outcome applies instead.`;
    }
    return `${moves}.`;
  };

  const preamble = [
    `You are an agent working on the Ticket ${ticketKey} in Cronk, as one Run of its ${status.name} Step.`,
    "",
    `Reach Cronk through its MCP server at ${new URL(mcpPath, config.publicUrl).href}. ` +
      "Read the Ticket there, with its Comments, Relations and the Reports of earlier Runs: this Brief doesn't repeat them.",
    "",
    runId ? `Your Run id is ${runId}.` : "Your Run id is given when the Run starts.",
    "",
    step.kind === "merge"
      ? "End the Run by merging its Pull Request with `merge_pull_request`, or by calling `finish` with your Run id and one of these Outcomes:"
      : "End the Run by calling `finish` with your Run id and one of these Outcomes:",
    "",
    ...offeredOutcomes(step, statuses, autonomous).map(outcomeLine),
    "",
    "Rules:",
    "",
    step.kind === "merge"
      ? "- Call `finish` exactly once, as the last thing you do, unless you merge: a merge with `merge_pull_request` " +
        "ends this Run, finished as *merged*, so don't call `finish` after it."
      : "- Call `finish` exactly once, as the last thing you do.",
    "- *needs you* takes a Question.",
    `- While this Run is running you may edit ${ticketKey}'s description, Priority, Labels, due date and estimate, ` +
      "write Reports on it and split it into Sub-Tickets with `create_sub_ticket`; leave everything else to its Users.",
    `- File anything you find that isn't part of ${ticketKey}'s work with \`file_ticket\`, giving your Run id: it waits ` +
      `for ${ticketKey}'s Assignee as a Discovered Ticket.`,
    "- Don't merge pull requests on GitHub directly.",
  ].join("\n");

  return {
    preamble,
    brief: step.brief,
    ticketKey,
    text: [preamble, step.brief, ticketKey].join("\n\n"),
  };
}
