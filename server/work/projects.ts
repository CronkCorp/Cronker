import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";

/** What a Status means, whatever its name. Every Project keeps at least one Status of each kind. */
export const statusKinds = ["backlog", "active", "review", "done", "canceled"] as const;
export type StatusKind = (typeof statusKinds)[number];
export const StatusKind = Type.Union(statusKinds.map((kind) => Type.Literal(kind)));

export const Status = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  kind: StatusKind,
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

/** The default board every new Project starts with. Steps come later. */
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

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const summaryColumns = `projects.id, projects.workspace_id as "workspaceId", projects.name, projects.key`;

export async function projectsOf(db: Db, workspaceId: string): Promise<ProjectSummary[]> {
  const { rows } = await db.query<ProjectSummary>(
    `select ${summaryColumns} from projects where workspace_id = $1 order by lower(name), id`,
    [workspaceId],
  );
  return rows;
}

async function statusesOf(db: Db | Tx, projectId: string): Promise<Status[]> {
  const { rows } = await db.query<Status>(
    "select id, name, kind from statuses where project_id = $1 order by position",
    [projectId],
  );
  return rows;
}

/** A Project, if the User belongs to its Workspace; otherwise nothing, as if it didn't exist. */
export async function findProject(db: Db | Tx, userId: string, projectId: string): Promise<Project | undefined> {
  if (!uuid.test(projectId)) return undefined;
  const { rows } = await db.query<ProjectSummary>(
    `select ${summaryColumns} from projects
     join memberships on memberships.workspace_id = projects.workspace_id
     where projects.id = $1 and memberships.user_id = $2`,
    [projectId, userId],
  );
  const project = rows[0];
  return project && { ...project, statuses: await statusesOf(db, project.id) };
}

export async function createProject(
  db: Db,
  clock: Clock,
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
      await tx.query(
        `insert into statuses (workspace_id, project_id, name, kind, position, created_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, project.id, status.name, status.kind, position, now],
      );
    }
    return { ...project, statuses: await statusesOf(tx, project.id) };
  });
}

/** Whether a query failed on the named unique index. */
function violates(error: unknown, constraint: string): boolean {
  const { code, constraint: violated } = error as { code?: string; constraint?: string };
  return code === "23505" && violated === constraint;
}

export function notFound(): ApiError {
  return new ApiError(404, "not_found", "No such Project.");
}
