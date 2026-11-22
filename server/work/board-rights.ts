import { ownerName } from "../agents/tokens.js";
import type { Db, Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { archivedRefusal } from "../identity/viewers.js";
import type { AgentCaller, Caller } from "../identity/callers.js";
import type { Project } from "./projects.js";

/**
 * Who may change a Project's board: its Statuses and their Steps. A User or an Agent with Write in the Project
 * changes its Statuses and takes a Step off one; giving a Status a Step, or changing one, rewrites the Brief, model
 * and Outcomes later Runs work by, so an Agent may do that only when its Owner is an Admin of the Workspace. Creating
 * a Project brings the default Steps, so the same goes for that.
 */

/** Refuses a caller without Write in the Project: for an Agent, the least of its Agent Access, its Owner's and its token's. */
export function requireBoardWrite(caller: Caller, project: Project): void {
  if (project.archivedAt !== null) throw archivedRefusal();
  if (project.access === "write") return;
  throw new ApiError(403, "read_access", `${caller.kind === "agent" ? caller.name : "You"} may only read ${project.key}.`, {
    rule:
      "With Read in a Project you read it but change nothing: changing its Statuses and Steps needs Write in it. " +
      "An Agent's is the least of the Project's Agent Access, its Owner's Access and its token's access.",
    advice:
      caller.kind === "agent"
        ? `Leave a Comment asking ${ownerName(caller)}, ${caller.name}'s Owner, or another User with Write in ${project.key}, to change it.`
        : `Ask an Admin of the Workspace for Write in ${project.key}.`,
  });
}

/** Whether the Agent's Owner is an Admin of the Workspace. */
async function ownerIsAdmin(db: Db | Tx, agent: AgentCaller, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query<{ isAdmin: boolean }>(
    `select is_admin as "isAdmin" from memberships where workspace_id = $1 and user_id = $2`,
    [workspaceId, agent.owner.id],
  );
  return rows[0]?.isAdmin ?? false;
}

/** Refuses an Agent whose Owner isn't an Admin of the Project's Workspace giving a Status a Step or changing its Step. */
export async function requireStepAuthor(tx: Tx, caller: Caller, project: Project): Promise<void> {
  if (caller.kind !== "agent" || (await ownerIsAdmin(tx, caller, project.workspaceId))) return;
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

/**
 * Refuses an Agent whose Owner isn't an Admin of the Workspace creating a Project: a new Project brings the default
 * Steps, whose Briefs, models and Outcomes later Runs work by. A read-only token is refused before this, as for any
 * change. Any User of the Workspace may create a Project.
 */
export async function requireProjectCreator(db: Db, caller: Caller, workspaceId: string): Promise<void> {
  if (caller.kind !== "agent" || (await ownerIsAdmin(db, caller, workspaceId))) return;
  throw new ApiError(
    403,
    "agent_not_allowed",
    `${caller.name} is an Agent, and its Owner, ${ownerName(caller)}, isn't an Admin of this Workspace.`,
    {
      rule:
        "A new Project brings the default board's Steps, whose Briefs, models and Outcomes later Runs work by, so an " +
        "Agent creates a Project only when its Owner is an Admin of the Workspace, and with a token that isn't read-only.",
      advice: `Leave a Comment asking ${ownerName(caller)}, or an Admin, to create the Project.`,
    },
  );
}
