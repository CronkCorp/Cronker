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
  | { kind: "agent"; id: string; workspace: { id: string }; owner: { id: string }; access: "full" | "read" };

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

/** What a Viewer may do in a Project, or with a Workspace's own knowledge: nothing, Read or Write. */
export type Access = "none" | "read" | "write";

/**
 * Where a record is, as SQL expressions: its Project's id, null for a Workspace's own knowledge, and its Workspace's id.
 */
export interface Place {
  project: string;
  workspace: string;
}

const levels = "array['none', 'read', 'write']::text[]";
const rank = (access: string) => `array_position(${levels}, (${access})::text)`;

/**
 * A User's Access, as SQL: nothing outside their Workspaces; Write in the Workspace's own knowledge and, for an Admin,
 * in every Project of it; otherwise their listed level, or, unlisted, Write in an open Project and nothing in a private one.
 */
function userAccess(user: string, { project, workspace }: Place): string {
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
  const token = viewer.access === "full" ? "'write'" : "'read'";
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

/** The refusal of a write to a Viewer with only Read where the write lands. */
export function readAccessRefusal(): ApiError {
  return new ApiError(403, "read_access", "You have Read in this Project, so you may only read it.", {
    rule: "A Viewer with Read in a Project may read everything in it but change nothing.",
    advice: "Read instead, or ask an Admin of this Workspace for Write in this Project.",
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
  if ((await accessOf(db, viewer, place)) !== "write") throw readAccessRefusal();
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
