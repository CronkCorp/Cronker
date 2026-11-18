import { Type, type Static } from "typebox";
import { transaction, type Db } from "../db.js";
import type { Clock } from "../clock.js";

export const Workspace = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() });
export type Workspace = Static<typeof Workspace>;

export const WorkspaceName = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });

export const Membership = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  isAdmin: Type.Boolean(),
});
export type Membership = Static<typeof Membership>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!uuid.test(workspaceId)) return undefined;
  const { rows } = await db.query<Workspace>(
    `select workspaces.id, workspaces.name
     from workspaces join memberships on memberships.workspace_id = workspaces.id
     where workspaces.id = $1 and memberships.user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0];
}

/** Creates a Workspace with the User as its first Admin. */
export async function createWorkspace(db: Db, clock: Clock, userId: string, name: string): Promise<Membership> {
  return transaction(db, async (tx) => {
    const now = clock.now();
    const { rows } = await tx.query<Workspace>(
      "insert into workspaces (name, created_at) values ($1, $2) returning id, name",
      [name.trim(), now],
    );
    const workspace = rows[0]!;
    await tx.query(
      "insert into memberships (workspace_id, user_id, is_admin, created_at) values ($1, $2, true, $3)",
      [workspace.id, userId, now],
    );
    return { ...workspace, isAdmin: true };
  });
}
