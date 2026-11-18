import type { Context } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../http/errors.js";
import { recheckWaiting, waitingTickets } from "../runs/runs.js";
import { userViewer } from "../identity/viewers.js";
import { findProject, projectNotFound, statusesOf, type Project } from "./projects.js";
import { checkOutcomes, mayHaveStep, removeStep, stepOnDoneOrCanceled, writeStep, type Step } from "./steps.js";

/**
 * Changes to the Step on one of a Project's Statuses, made under a lock on the Project
 * like every change to its Statuses, so a Step is always checked against the board as it is.
 */
export type StepChange = { type: "put"; step: Step } | { type: "remove" };

export async function changeStep(
  context: Context,
  userId: string,
  projectId: string,
  statusId: string,
  change: StepChange,
): Promise<Project> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const project = await findProject(tx, userViewer(userId), projectId, { lock: true });
    if (!project) throw projectNotFound();
    const status = project.statuses.find((s) => s.id === statusId);
    if (!status) throw new ApiError(404, "not_found", "No such Status in this Project.");
    if (change.type === "put") {
      if (!mayHaveStep(status.kind)) throw stepOnDoneOrCanceled(status);
      checkOutcomes(change.step.outcomes, status, project.statuses);
      await writeStep(tx, project, statusId, change.step, clock.now());
    } else {
      await removeStep(tx, statusId);
      // Tickets there waiting for a Run need none now.
      recheckWaiting(context, tx, await waitingTickets(tx, "tickets.status_id = $1", [statusId]));
    }
    live.publish(tx, project.workspaceId, { type: "statuses.changed", projectId: project.id });
    return { ...project, statuses: await statusesOf(tx, project.id) };
  });
}
