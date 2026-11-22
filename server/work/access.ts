import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { archivedRefusal, readersIn, userViewer, writersIn } from "../identity/viewers.js";
import { requireAdmin } from "../workspaces/members.js";
import { findProject, Project, projectNotFound, Visibility } from "./projects.js";
import { agentAccess, type AgentAccess } from "../workspaces/workspaces.js";
import { delegatedTickets, heldTickets, nameOf, releaseTickets, undelegateProject } from "./releasing.js";

/** A User listed on a Project, with their level there: Read to follow its work without changing it, or Write. */
export const ListedUser = Type.Object({
  userId: Type.String({ format: "uuid" }),
  level: Type.Union([Type.Literal("write"), Type.Literal("read")], {
    description: "`write`, or `read` to read everything in the Project and change nothing. Admins have Write whatever it says.",
  }),
});
export type ListedUser = Static<typeof ListedUser>;

const projectAgentAccess = () =>
  agentAccess(
    "The Project's Agent Access: how far Agents may go in it. `write` (the default), `read`, refusing every write " +
      "of theirs there with `read_access`, or `none`, answering as not found to them. An Agent may do the least of " +
      "it, its Owner's Access and its token's access. Dropping it below `write` undelegates the Project's Tickets.",
  );

const accessFields = {
  visibility: Visibility,
  users: Type.Array(ListedUser, {
    description:
      "The Users listed on the Project, in the order they were listed. In a private Project only they, and the " +
      "Workspace's Admins, see it; in an open Project, a User it doesn't list has Write. Admins have Write whatever " +
      "the list says.",
  }),
};

/** Who may see a Project and how far: whether it is open or private, the Users it lists, and its Agent Access. */
export const ProjectAccess = Type.Object({ ...accessFields, agentAccess: projectAgentAccess() });
export type ProjectAccess = Static<typeof ProjectAccess>;

/** A Project's Access as set: its Agent Access stays as it is when left out. */
export const ProjectAccessChange = Type.Object({ ...accessFields, agentAccess: Type.Optional(projectAgentAccess()) });
export type ProjectAccessChange = Static<typeof ProjectAccessChange>;

async function accessOfProject(db: Db | Tx, projectId: string): Promise<ProjectAccess> {
  const { rows } = await db.query<Pick<ProjectAccess, "visibility" | "agentAccess">>(
    `select visibility, agent_access as "agentAccess" from projects where id = $1`,
    [projectId],
  );
  const users = await db.query<ListedUser>(
    `select user_id as "userId", level from project_members where project_id = $1 order by created_at, user_id`,
    [projectId],
  );
  return { visibility: rows[0]!.visibility, users: users.rows, agentAccess: rows[0]!.agentAccess };
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
      "of Users who would lose Write in it, those delegated to their Agents, and, with Agent Access dropping below " +
      "Write, every delegated one; each Ticket counted once.",
  }),
});
export type AccessPreview = Static<typeof AccessPreview>;

type AdminProject = Awaited<ReturnType<typeof projectForAdmin>>;

/** What an Access change takes away: the Users who lose Write by it, and whether Agents do. */
interface Losing {
  users: string[];
  agentsLoseWrite: boolean;
}

/** Writes the Project's new Access in the transaction, after checking it; returns who loses Write by it. */
async function writeAccess(tx: Tx, project: AdminProject, access: ProjectAccessChange, now: Date): Promise<Losing> {
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
  const { rows: was } = await tx.query<{ agentAccess: AgentAccess }>(
    `select agent_access as "agentAccess" from projects where id = $1`,
    [project.id],
  );
  const agentAccessBefore = was[0]!.agentAccess;
  const agentAccessAfter = access.agentAccess ?? agentAccessBefore;
  await tx.query("update projects set visibility = $2, agent_access = $3 where id = $1", [
    project.id,
    access.visibility,
    agentAccessAfter,
  ]);
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
  return {
    users: [...writersBefore].filter((user) => !writersAfter.has(user)).sort(),
    agentsLoseWrite: agentAccessBefore === "write" && agentAccessAfter !== "write",
  };
}

/**
 * Sets whether a Project is open or private, replaces the Users it lists and sets its Agent Access, as an Admin. A
 * User who loses Write in it, by dropping to Read, leaving its list or its turning private without them, lets go of
 * its Tickets as when leaving the Workspace: they are unassigned, their Agents undelegated and their Runs stopped, as
 * the Admin's Changes. Agent Access dropping below Write undelegates all its Tickets, stopping their Runs, as the
 * Admin's Changes; each keeps its Assignee, in whose Inbox it waits.
 */
export async function setProjectAccess(
  context: Context,
  userId: string,
  projectId: string,
  access: ProjectAccessChange,
): Promise<ProjectAccess> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const project = await projectForAdmin(db, tx, userId, projectId, { lock: true });
    if (project.archivedAt !== null) throw archivedRefusal();
    const before = await readersIn(tx, project.workspaceId, [project.id]);
    const now = clock.now();
    const losing = await writeAccess(tx, project, access, now);
    for (const loser of losing.users) {
      const reason = `${await nameOf(tx, userId)} removed ${await nameOf(tx, loser)}'s Write in ${project.key}.`;
      await releaseTickets(context, tx, userId, { workspaceId: project.workspaceId, userId: loser, projectId: project.id }, reason, now);
    }
    if (losing.agentsLoseWrite) {
      const reason = `${await nameOf(tx, userId)} removed Agents' Write in ${project.key}.`;
      await undelegateProject(context, tx, userId, project, reason, now);
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
  access: ProjectAccessChange,
): Promise<AccessPreview> {
  try {
    await transaction(db, async (tx) => {
      const project = await projectForAdmin(db, tx, userId, projectId);
      if (project.archivedAt !== null) throw archivedRefusal();
      const losing = await writeAccess(tx, project, access, clock.now());
      const tickets = new Set<string>();
      for (const loser of losing.users) {
        const releasing = { workspaceId: project.workspaceId, userId: loser, projectId: project.id };
        for (const id of await heldTickets(tx, releasing)) tickets.add(id);
      }
      if (losing.agentsLoseWrite) for (const id of await delegatedTickets(tx, project.id)) tickets.add(id);
      throw new Previewed({ tickets: tickets.size });
    });
  } catch (error) {
    if (error instanceof Previewed) return error.preview;
    throw error;
  }
  throw new Error("unreachable");
}

/**
 * Archives a Project, or unarchives it, as an Admin of its Workspace. While archived, every write in it is refused
 * with `project_archived`, for Users, Admins included, and Agents alike; reads keep working. Refused with 409 when it
 * already is as asked.
 */
export async function archiveProject(
  { db, clock, live }: Context,
  userId: string,
  projectId: string,
  archived: boolean,
): Promise<Project> {
  return transaction(db, async (tx) => {
    const project = await projectForAdmin(db, tx, userId, projectId, { lock: true });
    if (archived && project.archivedAt !== null) {
      throw new ApiError(409, "project_already_archived", `${project.key} is archived already.`);
    }
    if (!archived && project.archivedAt === null) {
      throw new ApiError(409, "project_not_archived", `${project.key} isn't archived.`);
    }
    await tx.query("update projects set archived_at = $2, archived_by = $3 where id = $1", [
      project.id,
      archived ? clock.now() : null,
      archived ? userId : null,
    ]);
    live.publish(tx, project.workspaceId, { type: "project.changed", projectId: project.id });
    return (await findProject(tx, userViewer(userId), project.id))!;
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
          description:
            "Whether the Project is open or private, the Users it lists, and its Agent Access. Only an Admin of its " +
            "Workspace reads it.",
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
            "Makes the Project open or private, replaces the Users it lists, each a User of its Workspace, once, " +
            "with Read or Write, and sets its Agent Access, kept as it is when left out. A User with Read reads " +
            "everything in the Project, and every write of theirs is refused with `read_access`. " +
            "In a private Project, a User it doesn't list, and their Agents, find nothing of it, as if it didn't " +
            "exist; Admins keep Write in every Project. A User who loses Write in it is unassigned from its Tickets " +
            "and their Agents undelegated, stopping their Runs, as when they leave the Workspace: the Tickets wait in " +
            "the Admins' Inbox, and the Changes are the Admin's. Agent Access dropping below `write` undelegates " +
            "every Ticket of the Project, stopping its Run; each keeps its Assignee, in whose Inbox it waits. " +
            "`POST .../access/preview` says how many Tickets " +
            "that would be first. Only an Admin of its Workspace sets it.",
          params,
          body: ProjectAccessChange,
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
          body: ProjectAccessChange,
          response: { 200: AccessPreview, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return previewProjectAccess(context, user.id, request.params.projectId, request.body);
      },
    );

    app.post(
      "/api/projects/:projectId/archive",
      {
        schema: {
          tags: ["Projects"],
          summary: "Archive a Project",
          description:
            "Makes the Project read-only and moves it out of the way: every write in it is then refused with " +
            "`project_archived`, for Users, Admins included, and Agents alike, while reads, its key and its addresses " +
            "keep working. Refused with `project_already_archived` if it is. Only an Admin of its Workspace archives it.",
          params,
          response: { 200: Project, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return archiveProject(context, user.id, request.params.projectId, true);
      },
    );

    app.post(
      "/api/projects/:projectId/unarchive",
      {
        schema: {
          tags: ["Projects"],
          summary: "Unarchive a Project",
          description:
            "Lets the Project be changed again, as before it was archived. Refused with `project_not_archived` if it " +
            "isn't. Only an Admin of its Workspace unarchives it.",
          params,
          response: { 200: Project, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return archiveProject(context, user.id, request.params.projectId, false);
      },
    );
  };
}
