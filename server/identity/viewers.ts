import type { Db, Tx } from "../db.js";
import { ApiError } from "../http/errors.js";

/**
 * Whose view of Cronk a read takes: a User sees the Workspaces they belong to, an Agent
 * only its own. Every lookup of a Workspace's records narrows by its Viewer, so records
 * out of view answer as if they didn't exist. An Agent's Viewer carries its Owner and its
 * token's access, which bound its Access.
 */
export type Viewer =
  | { kind: "user"; id: string }
  | { kind: "agent"; id: string; workspace: { id: string }; owner: { id: string }; access: "read" | "write" | "full" };

export const userViewer = (userId: string): Viewer => ({ kind: "user", id: userId });

/**
 * A SQL condition that the Workspace in `workspaceColumn` is in the Viewer's view, with
 * the value to bind to `param`. For the Workspace itself and records outside any Project's
 * Access, such as Agents; anything in a Project, or a Workspace's own knowledge, asks
 * {@link inReach} instead.
 */
export function inView(viewer: Viewer, workspaceColumn: string, param: string): { sql: string; value: string } {
  return viewer.kind === "user"
    ? {
        sql: `exists (select 1 from memberships where memberships.workspace_id = ${workspaceColumn} and memberships.user_id = ${param})`,
        value: viewer.id,
      }
    : { sql: `${workspaceColumn} = ${param}`, value: viewer.workspace.id };
}

/**
 * What a Viewer may do in a Project, or with a Workspace's own knowledge: nothing, Read or Write; or, in an archived
 * Project, whatever they had there, `archived`: read it and change nothing, Admins included, until it is unarchived.
 */
export type Access = "none" | "archived" | "read" | "write";

/**
 * Where a record is, as SQL expressions: its Project's id, null for a Workspace's own knowledge, and its Workspace's id.
 */
export interface Place {
  project: string;
  workspace: string;
}

// Archived ranks below Read, so an Agent's least of the levels is archived whenever its Owner's is.
const levels = "array['none', 'archived', 'read', 'write']::text[]";
const rank = (access: string) => `array_position(${levels}, (${access})::text)`;

/**
 * A User's Access, as SQL: nothing outside their Workspaces; Write in the Workspace's own knowledge and, for an Admin,
 * in every Project of it; otherwise their listed level, or, unlisted, Write in an open Project and nothing in a private one.
 * In an archived Project, any of those but nothing is `archived`.
 */
function userAccess(user: string, place: Place): string {
  const level = listedAccess(user, place);
  return `(case when ${place.project} is not null and (${level}) <> 'none'
      and exists (select 1 from projects archived_projects where archived_projects.id = ${place.project} and archived_projects.archived_at is not null)
    then 'archived' else ${level} end)`;
}

/** A User's Access by their membership and the Project's list, before an archived Project counts. */
function listedAccess(user: string, { project, workspace }: Place): string {
  return `coalesce((select case when ${project} is null or access_memberships.is_admin then 'write'
        else coalesce(
          (select project_members.level from project_members
           where project_members.project_id = ${project} and project_members.user_id = access_memberships.user_id),
          (select case access_projects.visibility when 'open' then 'write' else 'none' end
           from projects access_projects where access_projects.id = ${project}),
          'none')
        end
      from memberships access_memberships
      where access_memberships.workspace_id = ${workspace} and access_memberships.user_id = ${user}), 'none')`;
}

/**
 * The one rule for Access, as a SQL expression of `'none'`, `'read'` or `'write'` for a record at the place given, with
 * the value to bind to `param`. An Agent gets nothing outside its own Workspace, and in it the least of the Agent
 * Access where the record is (its Project's, or the Workspace's for its own knowledge), its Owner's Access and its
 * token's access.
 */
export function accessIn(viewer: Viewer, place: Place, param: string): { sql: string; value: string | string[] } {
  if (viewer.kind === "user") return { sql: userAccess(param, place), value: viewer.id };
  const workspace = `(${param}::uuid[])[1]`;
  const owner = `(${param}::uuid[])[2]`;
  const agentAccess = `case when ${place.project} is null
      then (select access_workspaces.agent_access from workspaces access_workspaces where access_workspaces.id = ${place.workspace})
      else (select access_projects.agent_access from projects access_projects where access_projects.id = ${place.project}) end`;
  // Full doesn't raise Access: it only changes which acts an Agent may take with Write.
  const token = viewer.access === "read" ? "'read'" : "'write'";
  return {
    sql: `(case when ${place.workspace} is distinct from ${workspace} then 'none'
      else (${levels})[least(${rank(userAccess(owner, place))}, ${rank(agentAccess)}, ${rank(token)})] end)`,
    value: [viewer.workspace.id, viewer.owner.id],
  };
}

/**
 * A SQL condition that the Viewer may at least read a record at the place given, with the value to bind to `param`:
 * what it can't read answers as if it didn't exist.
 */
export function inReach(viewer: Viewer, place: Place, param: string): { sql: string; value: string | string[] } {
  const access = accessIn(viewer, place, param);
  return { sql: `(${access.sql}) <> 'none'`, value: access.value };
}

/** The Viewer's Access in a Project, or, with no Project, to the Workspace's own knowledge; by the same rule. */
export async function accessOf(db: Db | Tx, viewer: Viewer, place: { workspaceId: string; projectId: string | null }): Promise<Access> {
  const access = accessIn(viewer, { project: "$2::uuid", workspace: "$1::uuid" }, "$3");
  const { rows } = await db.query<{ access: Access }>(`select ${access.sql} as access`, [
    place.workspaceId,
    place.projectId,
    access.value,
  ]);
  return rows[0]!.access;
}

/** The refusal of a write to an archived Project, whoever makes it. */
export function archivedRefusal(): ApiError {
  return new ApiError(403, "project_archived", "This Project is archived, so it may only be read.", {
    rule: "An archived Project is read-only for everyone, Admins and Agents included, until an Admin unarchives it.",
    advice: "Read instead, or ask an Admin of this Workspace to unarchive the Project.",
  });
}

/**
 * The refusal of a write to a Viewer without Write at the Access given: archived, or only Read, in a Project or, with
 * no Project, the Workspace's own knowledge.
 */
export function writeRefusal(access: Access, where: "project" | "workspace" = "project"): ApiError {
  return access === "archived" ? archivedRefusal() : readAccessRefusal(where);
}

/**
 * The refusal of a write to a Viewer with only Read where the write lands: in a Project, or, with no Project, the
 * Workspace's own knowledge.
 */
export function readAccessRefusal(where: "project" | "workspace" = "project"): ApiError {
  const place = where === "project" ? "this Project" : "this Workspace's own knowledge";
  return new ApiError(403, "read_access", `You have Read in ${place}, so you may only read it.`, {
    rule:
      `A Viewer with Read in ${place} may read everything in it but change nothing. An Agent has the least of the ` +
      "Agent Access there, its Owner's Access and its token's access.",
    advice: `Read instead, or ask an Admin of this Workspace for Write in ${place}, or to raise its Agent Access.`,
  });
}

/**
 * Refuses a write unless the Viewer has Write where it lands: in a Project, or, with no Project, the Workspace's own
 * knowledge. Call it after finding the record, so what the Viewer can't read still answers as not found.
 */
export async function requireWrite(
  db: Db | Tx,
  viewer: Viewer,
  place: { workspaceId: string; projectId: string | null },
): Promise<void> {
  const access = await accessOf(db, viewer, place);
  if (access !== "write") throw writeRefusal(access, place.projectId === null ? "workspace" : "project");
}

/**
 * The Users of a Workspace who may at least read every one of the places given: Projects by id, or null for the
 * Workspace's own knowledge. With no places, every User of the Workspace. By the same rule as {@link accessIn}.
 */
export async function readersIn(db: Db | Tx, workspaceId: string, projectIds: (string | null)[]): Promise<Set<string>> {
  const access = userAccess("readers.user_id", { project: "places.id", workspace: "$1::uuid" });
  const { rows } = await db.query<{ userId: string }>(
    `select readers.user_id as "userId" from memberships readers
     where readers.workspace_id = $1
       and not exists (select 1 from unnest($2::uuid[]) as places(id) where ${access} = 'none')`,
    [workspaceId, projectIds],
  );
  return new Set(rows.map((row) => row.userId));
}

/** The Users of a Workspace with Write in the Project, by the same rule as {@link accessIn}. */
export async function writersIn(db: Db | Tx, workspaceId: string, projectId: string): Promise<Set<string>> {
  const access = userAccess("writers.user_id", { project: "$2::uuid", workspace: "$1::uuid" });
  const { rows } = await db.query<{ userId: string }>(
    `select writers.user_id as "userId" from memberships writers where writers.workspace_id = $1 and ${access} = 'write'`,
    [workspaceId, projectId],
  );
  return new Set(rows.map((row) => row.userId));
}
