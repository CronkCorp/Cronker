import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, violates, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { inView, userViewer, type Viewer } from "../identity/viewers.js";
import { recheckWaiting, waitingTickets } from "../runs/runs.js";
import { requireMember } from "../workspaces/members.js";
import { defaultSteps } from "./default-steps.js";
import { defaultRoundLimit, Step, stepsOf, writeStep } from "./steps.js";

/** What a Status means, whatever its name. Every Project keeps at least one Status of each kind. */
export const statusKinds = ["backlog", "active", "review", "done", "canceled"] as const;
export type StatusKind = (typeof statusKinds)[number];
export const StatusKind = Type.Union(statusKinds.map((kind) => Type.Literal(kind)));

export const Status = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  kind: StatusKind,
  step: Type.Union([Step, Type.Null()], {
    description: "The agent work the Status asks for; without one, Tickets in it wait for a User.",
  }),
});
export type Status = Static<typeof Status>;

export const ProjectSummary = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  name: Type.String(),
  key: Type.String(),
});
export type ProjectSummary = Static<typeof ProjectSummary>;

/** A Project with its settings and its Statuses in board order. */
export const Project = Type.Object({
  ...ProjectSummary.properties,
  newTicketsDelegated: Type.Boolean({
    description: "Whether new Tickets start delegated to their creator's first Agent, assigning them. Off by default.",
  }),
  autonomousDelegationDefault: Type.Boolean({
    description: "Whether a Ticket takes Autonomous Delegation when first delegated, unless a User set it already. Off by default.",
  }),
  pullRequestAutomation: Type.Boolean({
    description:
      "Whether a merged Pull Request completes the Tickets it links in this Project, and a failing check or a review requesting " +
      "changes sends them back from a Review Status to their producing Step. On by default; off, merges and failures only update " +
      "the Pull Request's state.",
  }),
  agentsMayMerge: Type.Boolean({
    description:
      "Whether a Merge Step lets agents merge the Pull Requests of Tickets with Autonomous Delegation; off, every Merge Step " +
      "skips itself. Off by default; only an Admin changes it.",
  }),
  statuses: Type.Array(Status),
});
export type Project = Static<typeof Project>;

/** The default board every new Project starts with; `default-steps.ts` holds its Steps. */
const defaultStatuses: { name: string; kind: StatusKind }[] = [
  { name: "Backlog", kind: "backlog" },
  { name: "Triage", kind: "active" },
  { name: "Ready", kind: "backlog" },
  { name: "Investigate", kind: "active" },
  { name: "Implement", kind: "active" },
  { name: "Code review", kind: "active" },
  { name: "Merge", kind: "active" },
  { name: "In Review", kind: "review" },
  { name: "Done", kind: "done" },
  { name: "Canceled", kind: "canceled" },
];

const summaryColumns = `projects.id, projects.workspace_id as "workspaceId", projects.name, projects.key`;

export async function projectsOf(db: Db, workspaceId: string): Promise<ProjectSummary[]> {
  const { rows } = await db.query<ProjectSummary>(
    `select ${summaryColumns} from projects where workspace_id = $1 order by lower(name), id`,
    [workspaceId],
  );
  return rows;
}

export async function statusesOf(db: Db | Tx, projectId: string): Promise<Status[]> {
  const { rows } = await db.query<Omit<Status, "step">>(
    "select id, name, kind from statuses where project_id = $1 order by position",
    [projectId],
  );
  const steps = await stepsOf(db, projectId);
  return rows.map((status) => ({ ...status, step: steps.get(status.id) ?? null }));
}

/**
 * A Project in the Viewer's view; otherwise nothing, as if it didn't exist.
 * With `lock`, the Project's row stays locked until the transaction ends, so changes to it queue up.
 */
export async function findProject(
  db: Db | Tx,
  viewer: Viewer,
  projectId: string,
  { lock = false } = {},
): Promise<Project | undefined> {
  if (!isUuid(projectId)) return undefined;
  const view = inView(viewer, "projects.workspace_id", "$2");
  const { rows } = await db.query<Omit<Project, "statuses">>(
    `select ${summaryColumns}, projects.new_tickets_delegated as "newTicketsDelegated",
       projects.autonomous_delegation_default as "autonomousDelegationDefault",
       projects.pull_request_automation as "pullRequestAutomation", projects.agents_may_merge as "agentsMayMerge"
     from projects where projects.id = $1 and ${view.sql}
     ${lock ? "for update of projects" : ""}`,
    [projectId, view.value],
  );
  const project = rows[0];
  return project && { ...project, statuses: await statusesOf(db, project.id) };
}

export async function createProject(
  { db, clock, live }: Context,
  workspaceId: string,
  input: { name: string; key: string },
): Promise<Project> {
  const name = input.name.trim();
  const key = input.key.toUpperCase();
  return transaction(db, async (tx) => {
    const now = clock.now();
    const project = await tx
      .query<ProjectSummary>(
        `insert into projects (workspace_id, name, key, created_at) values ($1, $2, $3, $4)
         returning id, workspace_id as "workspaceId", name, key`,
        [workspaceId, name, key, now],
      )
      .then(
        ({ rows }) => rows[0]!,
        (error: unknown) => {
          if (violates(error, "projects_workspace_key_key")) {
            throw new ApiError(409, "project_key_taken", `Another Project in this Workspace already has the key ${key}.`);
          }
          if (violates(error, "projects_workspace_name_key")) {
            throw new ApiError(409, "project_name_taken", `Another Project in this Workspace is already called ${name}.`);
          }
          throw error;
        },
      );
    for (const [position, status] of defaultStatuses.entries()) {
      await insertStatus(tx, project, status, position, now);
    }
    const statuses = await statusesOf(tx, project.id);
    const idOf = (name: string) => statuses.find((s) => s.name === name)!.id;
    for (const [name, { kind, brief, model, labelRule, outcomes }] of Object.entries(defaultSteps)) {
      const step: Step = {
        kind: kind ?? "ordinary",
        brief,
        model,
        roundLimit: defaultRoundLimit,
        labelRule: labelRule ?? null,
        outcomes: outcomes.map(({ name, status, ...flags }) => ({
          name,
          statusId: idOf(status),
          default: flags.default ?? false,
          needsYou: flags.needsYou ?? false,
          countsAsRound: flags.countsAsRound ?? false,
        })),
      };
      await writeStep(tx, project, idOf(name), step, now);
    }
    live.publish(tx, workspaceId, { type: "project.created", projectId: project.id });
    return {
      ...project,
      newTicketsDelegated: false,
      autonomousDelegationDefault: false,
      pullRequestAutomation: true,
      agentsMayMerge: false,
      statuses: await statusesOf(tx, project.id),
    };
  });
}

/** The settings a User changes on a Project. */
export interface ProjectEdit {
  newTicketsDelegated?: boolean;
  autonomousDelegationDefault?: boolean;
  pullRequestAutomation?: boolean;
  /** Only an Admin of the Project's Workspace may give this, whatever its value. */
  agentsMayMerge?: boolean;
}

/** Changes a Project's settings, as a User. */
export async function editProject(
  context: Context,
  userId: string,
  projectId: string,
  edit: ProjectEdit,
): Promise<Project> {
  const { db, live } = context;
  return transaction(db, async (tx) => {
    const viewer = userViewer(userId);
    const project = await findProject(tx, viewer, projectId, { lock: true });
    if (!project) throw projectNotFound();
    if (edit.agentsMayMerge !== undefined && !(await requireMember(db, userId, project.workspaceId)).isAdmin) {
      throw new ApiError(403, "not_admin", "Only an Admin of this Workspace can change whether agents may merge.");
    }
    const next = {
      newTicketsDelegated: edit.newTicketsDelegated ?? project.newTicketsDelegated,
      autonomousDelegationDefault: edit.autonomousDelegationDefault ?? project.autonomousDelegationDefault,
      pullRequestAutomation: edit.pullRequestAutomation ?? project.pullRequestAutomation,
      agentsMayMerge: edit.agentsMayMerge ?? project.agentsMayMerge,
    };
    if (
      next.newTicketsDelegated !== project.newTicketsDelegated ||
      next.autonomousDelegationDefault !== project.autonomousDelegationDefault ||
      next.pullRequestAutomation !== project.pullRequestAutomation ||
      next.agentsMayMerge !== project.agentsMayMerge
    ) {
      await tx.query(
        `update projects set new_tickets_delegated = $2, autonomous_delegation_default = $3, pull_request_automation = $4,
           agents_may_merge = $5
         where id = $1`,
        [project.id, next.newTicketsDelegated, next.autonomousDelegationDefault, next.pullRequestAutomation, next.agentsMayMerge],
      );
      live.publish(tx, project.workspaceId, { type: "project.changed", projectId: project.id });
    }
    // Merge Steps decide afresh for Tickets still waiting in them, as they would on entering them now.
    if (next.agentsMayMerge !== project.agentsMayMerge) {
      recheckWaiting(context, tx, await waitingTickets(tx, "tickets.project_id = $1", [project.id]));
    }
    return (await findProject(tx, viewer, project.id))!;
  });
}

export async function insertStatus(
  tx: Tx,
  project: ProjectSummary,
  status: { name: string; kind: StatusKind },
  position: number,
  now: Date,
): Promise<void> {
  await tx.query(
    `insert into statuses (workspace_id, project_id, name, kind, position, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [project.workspaceId, project.id, status.name, status.kind, position, now],
  );
}

export function projectNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Project.");
}
