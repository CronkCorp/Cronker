import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, violates, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { defaultSteps } from "./default-steps.js";
import { Step, stepsOf, writeStep } from "./steps.js";

/** What a Status means, whatever its name. Every Project keeps at least one Status of each kind. */
export const statusKinds = ["backlog", "active", "review", "done", "canceled"] as const;
export type StatusKind = (typeof statusKinds)[number];
export const StatusKind = Type.Union(statusKinds.map((kind) => Type.Literal(kind)));

export const Status = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  kind: StatusKind,
  step: Type.Union([Step, Type.Null()], {
    description: "The agent work the Status asks for; without one, Tickets in it wait for a person.",
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

/** A Project with its Statuses in board order. */
export const Project = Type.Object({
  ...ProjectSummary.properties,
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
  const { rows } = await db.query<ProjectSummary>(
    `select ${summaryColumns} from projects where projects.id = $1 and ${view.sql}
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
    for (const [name, { brief, model, outcomes }] of Object.entries(defaultSteps)) {
      const step: Step = {
        brief,
        model,
        roundLimit: 2,
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
    return { ...project, statuses: await statusesOf(tx, project.id) };
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
