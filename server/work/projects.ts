import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, violates, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { accessIn, archivedRefusal, inReach, readAccessRefusal, userViewer, type Viewer } from "../identity/viewers.js";
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

/** Whether a Project is open to every User of its Workspace or only to those it lists, and its Admins. */
export const Visibility = Type.Union([Type.Literal("open"), Type.Literal("private")], {
  description:
    "`open`: every User of the Workspace has Write unless listed otherwise. `private`: only the Users it lists, and " +
    "the Workspace's Admins, see it; to anyone else it answers as if it didn't exist.",
});

export const ProjectSummary = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  name: Type.String(),
  key: Type.String(),
  visibility: Visibility,
  access: Type.Union([Type.Literal("write"), Type.Literal("read")], {
    description:
      "What the caller may do in the Project: `write`, or `read` to only read it. Admins always have Write; an " +
      "Agent's is the least of the Project's Agent Access, its Owner's Access and its token's access. In an archived " +
      "Project it is `read` for everyone.",
  }),
  archivedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()], {
    description:
      "When an Admin archived the Project, or null. An archived Project is read-only for everyone, Admins and Agents " +
      "included: every write in it is refused with `project_archived` until an Admin unarchives it.",
  }),
  archivedBy: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Admin who archived the Project, or null.",
  }),
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
  conciseReports: Type.Boolean({
    description:
      "Whether the Briefs of Runs in this Project ask them to keep their Reports concise: the outcome, findings, what was " +
      "verified and what the next Run or User needs, without the working. Off by default; nothing stored is cut.",
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

/**
 * A Project's summary columns as the Viewer sees them, its own Access included, binding the Viewer's value to `param`.
 * An archived Project's Access shows as Read, with `archivedAt` saying why.
 */
const summaryColumns = (viewer: Viewer, param: string) =>
  `projects.id, projects.workspace_id as "workspaceId", projects.name, projects.key, projects.visibility,
   (select case level when 'archived' then 'read' else level end
    from (select ${accessIn(viewer, { project: "projects.id", workspace: "projects.workspace_id" }, param).sql} as level) access_level) as access,
   projects.archived_at as "archivedAt", projects.archived_by as "archivedBy"`;

/**
 * Refuses a write to the Project unless the caller has Write in it: `project_archived` while it is archived, whoever
 * asks, otherwise `read_access`.
 */
export function requireProjectWrite(project: ProjectSummary): void {
  if (project.archivedAt !== null) throw archivedRefusal();
  if (project.access !== "write") throw readAccessRefusal();
}

/** The Workspace's Projects the Viewer may read. */
export async function projectsOf(db: Db, viewer: Viewer, workspaceId: string): Promise<ProjectSummary[]> {
  const view = inReach(viewer, { project: "projects.id", workspace: "projects.workspace_id" }, "$2");
  const { rows } = await db.query<ProjectSummary>(
    `select ${summaryColumns(viewer, "$2")} from projects where workspace_id = $1 and ${view.sql} order by lower(name), id`,
    [workspaceId, view.value],
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
  const view = inReach(viewer, { project: "projects.id", workspace: "projects.workspace_id" }, "$2");
  const { rows } = await db.query<Omit<Project, "statuses">>(
    `select ${summaryColumns(viewer, "$2")}, projects.new_tickets_delegated as "newTicketsDelegated",
       projects.autonomous_delegation_default as "autonomousDelegationDefault",
       projects.pull_request_automation as "pullRequestAutomation", projects.agents_may_merge as "agentsMayMerge",
       projects.concise_reports as "conciseReports"
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
  // The creator has Write in the new Project: a User of its Workspace, or an Agent whose Owner is an Admin, with a
  // full token, in a Project that starts open with Agent Access Write (ADR 0010).
  return transaction(db, async (tx) => {
    const now = clock.now();
    const project = await tx
      .query<ProjectSummary>(
        `insert into projects (workspace_id, name, key, created_at) values ($1, $2, $3, $4)
         returning id, workspace_id as "workspaceId", name, key, visibility, 'write' as access,
           null as "archivedAt", null as "archivedBy"`,
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
      conciseReports: false,
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
  conciseReports?: boolean;
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
    requireProjectWrite(project);
    if (edit.agentsMayMerge !== undefined && !(await requireMember(db, userId, project.workspaceId)).isAdmin) {
      throw new ApiError(403, "not_admin", "Only an Admin of this Workspace can change whether agents may merge.");
    }
    const next = {
      newTicketsDelegated: edit.newTicketsDelegated ?? project.newTicketsDelegated,
      autonomousDelegationDefault: edit.autonomousDelegationDefault ?? project.autonomousDelegationDefault,
      pullRequestAutomation: edit.pullRequestAutomation ?? project.pullRequestAutomation,
      agentsMayMerge: edit.agentsMayMerge ?? project.agentsMayMerge,
      conciseReports: edit.conciseReports ?? project.conciseReports,
    };
    if (
      next.newTicketsDelegated !== project.newTicketsDelegated ||
      next.autonomousDelegationDefault !== project.autonomousDelegationDefault ||
      next.pullRequestAutomation !== project.pullRequestAutomation ||
      next.agentsMayMerge !== project.agentsMayMerge ||
      next.conciseReports !== project.conciseReports
    ) {
      await tx.query(
        `update projects set new_tickets_delegated = $2, autonomous_delegation_default = $3, pull_request_automation = $4,
           agents_may_merge = $5, concise_reports = $6
         where id = $1`,
        [
          project.id,
          next.newTicketsDelegated,
          next.autonomousDelegationDefault,
          next.pullRequestAutomation,
          next.agentsMayMerge,
          next.conciseReports,
        ],
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
