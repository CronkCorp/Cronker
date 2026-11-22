import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { readersIn, userViewer, writersIn } from "../identity/viewers.js";
import { requireAdmin } from "../workspaces/members.js";
import { findProject, projectNotFound, Visibility } from "./projects.js";
import { countHeld, nameOf, releaseTickets } from "./releasing.js";

/** A User listed on a Project, with their level there: Read to follow its work without changing it, or Write. */
export const ListedUser = Type.Object({
  userId: Type.String({ format: "uuid" }),
  level: Type.Union([Type.Literal("write"), Type.Literal("read")], {
    description: "`write`, or `read` to read everything in the Project and change nothing. Admins have Write whatever it says.",
  }),
});
export type ListedUser = Static<typeof ListedUser>;

/** Who may see a Project: whether it is open or private, and the Users it lists. */
export const ProjectAccess = Type.Object({
  visibility: Visibility,
  users: Type.Array(ListedUser, {
    description:
      "The Users listed on the Project, in the order they were listed. In a private Project only they, and the " +
      "Workspace's Admins, see it; in an open Project, a User it doesn't list has Write. Admins have Write whatever " +
      "the list says.",
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

/** How many Tickets an Access change would unassign or undelegate, as asked before making it. */
export const AccessPreview = Type.Object({
  tickets: Type.Integer({
    description:
      "How many of the Project's Tickets the change would unassign or undelegate, stopping their running Runs: those " +
      "of Users who would lose Write in it, and those delegated to their Agents.",
  }),
});
export type AccessPreview = Static<typeof AccessPreview>;

type AdminProject = Awaited<ReturnType<typeof projectForAdmin>>;

/** Writes the Project's new Access in the transaction, after checking it; returns the Users who lose Write by it. */
async function writeAccess(tx: Tx, project: AdminProject, access: ProjectAccess, now: Date): Promise<string[]> {
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
  const writersBefore = await writersIn(tx, project.workspaceId, project.id);
  await tx.query("update projects set visibility = $2 where id = $1", [project.id, access.visibility]);
  await tx.query("delete from project_members where project_id = $1 and not (user_id = any($2::uuid[]))", [
    project.id,
    ids,
  ]);
  for (const user of access.users) {
    await tx.query(
      `insert into project_members (project_id, workspace_id, user_id, level, created_at) values ($1, $2, $3, $4, $5)
       on conflict (project_id, user_id) do update set level = excluded.level`,
      [project.id, project.workspaceId, user.userId, user.level, now],
    );
  }
  const writersAfter = await writersIn(tx, project.workspaceId, project.id);
  return [...writersBefore].filter((user) => !writersAfter.has(user)).sort();
}

/**
 * Sets whether a Project is open or private and replaces the Users it lists, as an Admin. A User who loses Write
 * in it, by dropping to Read, leaving its list or its turning private without them, lets go of its Tickets as when
 * leaving the Workspace: they are unassigned, their Agents undelegated and their Runs stopped, as the Admin's Changes.
 */
export async function setProjectAccess(
  context: Context,
  userId: string,
  projectId: string,
  access: ProjectAccess,
): Promise<ProjectAccess> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const project = await projectForAdmin(db, tx, userId, projectId, { lock: true });
    const before = await readersIn(tx, project.workspaceId, [project.id]);
    const now = clock.now();
    const losing = await writeAccess(tx, project, access, now);
    for (const loser of losing) {
      const reason = `${await nameOf(tx, userId)} removed ${await nameOf(tx, loser)}'s Write in ${project.key}.`;
      await releaseTickets(context, tx, userId, { workspaceId: project.workspaceId, userId: loser, projectId: project.id }, reason, now);
    }
    // Those who keep the Project hear that it changed; those who gain or lose it, so their open pages add or drop it.
    const after = await readersIn(tx, project.workspaceId, [project.id]);
    const kept = [...after].filter((user) => before.has(user));
    const gained = [...after].filter((user) => !before.has(user));
    const lost = [...before].filter((user) => !after.has(user));
    live.publish(tx, project.workspaceId, { type: "project.changed", projectId: project.id }, { users: kept });
    if (gained.length > 0) {
      live.publish(tx, project.workspaceId, { type: "project.gained", projectId: project.id }, { users: gained });
    }
    if (lost.length > 0) {
      live.publish(tx, project.workspaceId, { type: "project.lost", projectId: project.id }, { users: lost });
    }
    return accessOfProject(tx, project.id);
  });
}

/** Thrown to roll a preview's transaction back, carrying what it found. */
class Previewed {
  constructor(readonly preview: AccessPreview) {}
}

/**
 * How many Tickets setting the Project's Access would unassign or undelegate, as an Admin, changing nothing: the
 * change is tried in a transaction that is rolled back.
 */
export async function previewProjectAccess(
  { db, clock }: Context,
  userId: string,
  projectId: string,
  access: ProjectAccess,
): Promise<AccessPreview> {
  try {
    await transaction(db, async (tx) => {
      const project = await projectForAdmin(db, tx, userId, projectId);
      const losing = await writeAccess(tx, project, access, clock.now());
      let tickets = 0;
      for (const loser of losing) {
        tickets += await countHeld(tx, { workspaceId: project.workspaceId, userId: loser, projectId: project.id });
      }
      throw new Previewed({ tickets });
    });
  } catch (error) {
    if (error instanceof Previewed) return error.preview;
    throw error;
  }
  throw new Error("unreachable");
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
            "Makes the Project open or private and replaces the Users it lists, each a User of its Workspace, once, " +
            "with Read or Write. A User with Read reads everything in the Project, and every write of theirs is " +
            "refused with `read_access`. " +
            "In a private Project, a User it doesn't list, and their Agents, find nothing of it, as if it didn't " +
            "exist; Admins keep Write in every Project. A User who loses Write in it is unassigned from its Tickets " +
            "and their Agents undelegated, stopping their Runs, as when they leave the Workspace: the Tickets wait in " +
            "the Admins' Inbox, and the Changes are the Admin's. `POST .../access/preview` says how many Tickets " +
            "that would be first. Only an Admin of its Workspace sets it.",
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

    app.post(
      "/api/projects/:projectId/access/preview",
      {
        schema: {
          tags: ["Projects"],
          summary: "Preview setting a Project's Access",
          description:
            "How many Tickets setting the Project's Access to the body would unassign or undelegate, stopping their " +
            "running Runs, changing nothing; refused as setting it would be. Only an Admin of its Workspace asks.",
          params,
          body: ProjectAccess,
          response: { 200: AccessPreview, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return previewProjectAccess(context, user.id, request.params.projectId, request.body);
      },
    );
  };
}
