import { ownerName } from "../agents/tokens.js";
import type { Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import type { Project } from "./projects.js";

/**
 * Who may change a Project's board: its Statuses and their Steps. A User or an Agent with Write in the Project
 * changes its Statuses and takes a Step off one; giving a Status a Step, or changing one, rewrites the Brief, model
 * and Outcomes later Runs work by, so an Agent may do that only when its Owner is an Admin of the Workspace.
 */

/** Refuses a caller without Write in the Project: for an Agent, the least of its Agent Access, its Owner's and its token's. */
export function requireBoardWrite(caller: Caller, project: Project): void {
  if (project.access === "write") return;
  throw new ApiError(403, "read_access", `${caller.kind === "agent" ? caller.name : "You"} may only read ${project.key}.`, {
    rule:
      "Changing a Project's Statuses and Steps needs Write in it. An Agent's is the least of the Project's Agent " +
      "Access, its Owner's Access and its token's access.",
    advice:
      caller.kind === "agent"
        ? `Leave a Comment asking ${ownerName(caller)}, ${caller.name}'s Owner, or another User with Write in ${project.key}, to change it.`
        : `Ask an Admin of the Workspace for Write in ${project.key}.`,
  });
}

/** Refuses an Agent whose Owner isn't an Admin of the Project's Workspace giving a Status a Step or changing its Step. */
export async function requireStepAuthor(tx: Tx, caller: Caller, project: Project): Promise<void> {
  if (caller.kind !== "agent") return;
  const { rows } = await tx.query<{ isAdmin: boolean }>(
    `select is_admin as "isAdmin" from memberships where workspace_id = $1 and user_id = $2`,
    [project.workspaceId, caller.owner.id],
  );
  if (rows[0]?.isAdmin) return;
  throw new ApiError(
    403,
    "agent_not_allowed",
    `${caller.name} is an Agent, and its Owner, ${ownerName(caller)}, isn't an Admin of this Workspace.`,
    {
      rule:
        "A Step's Brief, model and Outcomes are what later Runs work by, so an Agent gives a Status a Step or changes " +
        "one only when its Owner is an Admin of the Workspace. With Write in the Project it may still change the " +
        "Project's Statuses and take a Step off one.",
      advice: `Leave a Comment asking ${ownerName(caller)}, or an Admin, to change ${project.key}'s Step.`,
    },
  );
}
