import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import type { Viewer } from "../identity/viewers.js";
import { mcpPath } from "../mcp/routes.js";
import { statusesOf } from "../work/projects.js";
import type { Outcome } from "../work/steps.js";
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
  const step = status.step;
  const nameOf = (statusId: string) => statuses.find((s) => s.id === statusId)!.name;
  const kindOf = (statusId: string) => statuses.find((s) => s.id === statusId)!.kind;
  // Outcomes completing work are offered only under Autonomous Delegation, which no Ticket has yet.
  const offered = step.outcomes.filter((o) => kindOf(o.statusId) !== "done");
  const outcomeLine = (o: Outcome) => {
    const moves = `- **${o.name}**: moves ${ticket.key} to ${nameOf(o.statusId)}`;
    if (o.needsYou) return `${moves} and hands it back to its Assignee. Give a Question saying what you need.`;
    if (o.countsAsRound) {
      return `${moves}. It counts as a round: after ${step.roundLimit}, the Step's *needs you* Outcome applies instead.`;
    }
    return `${moves}.`;
  };

  const preamble = [
    `You are an agent working on the Ticket ${ticket.key} in Cronk, as one Run of its ${status.name} Step.`,
    "",
    `Reach Cronk through its MCP server at ${new URL(mcpPath, config.publicUrl).href}. ` +
      "Read the Ticket there, with its Comments, Relations and the Reports of earlier Runs: this Brief doesn't repeat them.",
    "",
    "Your Run id is given when the Run starts.",
    "",
    "End the Run by calling `finish` with your Run id and one of these Outcomes:",
    "",
    ...offered.map(outcomeLine),
    "",
    "Rules:",
    "",
    "- Call `finish` exactly once, as the last thing you do.",
    "- *needs you* takes a Question.",
    "- Don't merge pull requests on GitHub directly.",
  ].join("\n");

  return {
    preamble,
    brief: step.brief,
    ticketKey: ticket.key,
    text: [preamble, step.brief, ticket.key].join("\n\n"),
  };
}
