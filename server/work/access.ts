import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { userViewer } from "../identity/viewers.js";
import { requireAdmin } from "../workspaces/members.js";
import { findProject, projectNotFound, Visibility } from "./projects.js";

/** A User listed on a Project, with their level there. Read comes later; for now every listed User has Write. */
export const ListedUser = Type.Object({
  userId: Type.String({ format: "uuid" }),
  level: Type.Literal("write"),
});
export type ListedUser = Static<typeof ListedUser>;

/** Who may see a Project: whether it is open or private, and the Users it lists. */
export const ProjectAccess = Type.Object({
  visibility: Visibility,
  users: Type.Array(ListedUser, {
    description:
      "The Users listed on the Project, in the order they were listed. In a private Project only they, and the " +
      "Workspace's Admins, see it; Admins have Write whatever the list says.",
  }),
});
export type ProjectAccess = Static<typeof ProjectAccess>;

async function accessOfProject(db: Db | Tx, projectId: string): Promise<ProjectAccess> {
  const { rows } = await db.query<{ visibility: ProjectAccess["visibility"] }>(
    "select visibility from projects where id = $1",
    [projectId],
  );
  const users = await db.query<ListedUser>(
    `select user_id as "userId", level from project_members where project_id = $1 order by created_at, user_id`,
    [projectId],
  );
  return { visibility: rows[0]!.visibility, users: users.rows };
}

/**
 * The Project, read in `lookup` (the transaction, or `db`), if the User is an Admin of its Workspace: 404 if they
 * can't read it, 403 if they aren't its Admin.
 */
async function projectForAdmin(db: Db, lookup: Db | Tx, userId: string, projectId: string, { lock = false } = {}) {
  const project = await findProject(lookup, userViewer(userId), projectId, { lock });
  if (!project) throw projectNotFound();
  await requireAdmin(db, userId, project.workspaceId);
  return project;
}

/** Sets whether a Project is open or private and replaces the Users it lists, as an Admin. */
export async function setProjectAccess(
  { db, clock, live }: Context,
  userId: string,
  projectId: string,
  access: ProjectAccess,
): Promise<ProjectAccess> {
  return transaction(db, async (tx) => {
    const project = await projectForAdmin(db, tx, userId, projectId, { lock: true });
    const ids = access.users.map((user) => user.userId);
    if (new Set(ids).size !== ids.length) {
      throw new ApiError(400, "user_listed_twice", "Each User is listed on a Project once.");
    }
    const { rows: members } = await tx.query<{ userId: string }>(
      `select user_id as "userId" from memberships where workspace_id = $1 and user_id = any($2::uuid[])`,
      [project.workspaceId, ids],
    );
    if (members.length !== ids.length) {
      throw new ApiError(400, "unknown_user", "Only Users of the Project's Workspace can be listed on it.");
    }
    await tx.query("update projects set visibility = $2 where id = $1", [project.id, access.visibility]);
    await tx.query("delete from project_members where project_id = $1 and not (user_id = any($2::uuid[]))", [
      project.id,
      ids,
    ]);
    const now = clock.now();
    for (const user of access.users) {
      await tx.query(
        `insert into project_members (project_id, workspace_id, user_id, level, created_at) values ($1, $2, $3, $4, $5)
         on conflict (project_id, user_id) do update set level = excluded.level`,
        [project.id, project.workspaceId, user.userId, user.level, now],
      );
    }
    live.publish(tx, project.workspaceId, { type: "project.changed", projectId: project.id });
    return accessOfProject(tx, project.id);
  });
}

export function accessRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  const params = Type.Object({ projectId: Type.String() });
  return async (app) => {
    app.get(
      "/api/projects/:projectId/access",
      {
        schema: {
          tags: ["Projects"],
          summary: "A Project's Access",
          description: "Whether the Project is open or private, and the Users it lists. Only an Admin of its Workspace reads it.",
          params,
          response: { 200: ProjectAccess, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const project = await projectForAdmin(db, db, user.id, request.params.projectId);
        return accessOfProject(db, project.id);
      },
    );

    app.put(
      "/api/projects/:projectId/access",
      {
        schema: {
          tags: ["Projects"],
          summary: "Set a Project's Access",
          description:
            "Makes the Project open or private and replaces the Users it lists, each a User of its Workspace, once. " +
            "In a private Project, a User it doesn't list, and their Agents, find nothing of it, as if it didn't " +
            "exist; Admins keep Write in every Project. Only an Admin of its Workspace sets it.",
          params,
          body: ProjectAccess,
          response: { 200: ProjectAccess, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return setProjectAccess(context, user.id, request.params.projectId, request.body);
      },
    );
  };
}
