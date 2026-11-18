import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { isUuid } from "../http/ids.js";

export const Workspace = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() });
export type Workspace = Static<typeof Workspace>;

export const Membership = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  isAdmin: Type.Boolean(),
});
export type Membership = Static<typeof Membership>;

/** The Workspaces a User belongs to. */
export async function workspacesOf(db: Db, userId: string): Promise<Membership[]> {
  const { rows } = await db.query<Membership>(
    `select workspaces.id, workspaces.name, memberships.is_admin as "isAdmin"
     from memberships join workspaces on workspaces.id = memberships.workspace_id
     where memberships.user_id = $1 order by workspaces.name, workspaces.id`,
    [userId],
  );
  return rows;
}

/** A Workspace, if the User belongs to it; otherwise nothing, as if it didn't exist. */
export async function findWorkspace(db: Db, userId: string, workspaceId: string): Promise<Workspace | undefined> {
  if (!isUuid(workspaceId)) return undefined;
  const { rows } = await db.query<Workspace>(
    `select workspaces.id, workspaces.name
     from workspaces join memberships on memberships.workspace_id = workspaces.id
     where workspaces.id = $1 and memberships.user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0];
}
