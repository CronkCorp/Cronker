import { Type, type Static } from "typebox";
import { transaction, type Db, type Tx } from "../db.js";
import type { Clock } from "../clock.js";
import { isUuid } from "../http/ids.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { slugForNewWorkspace, WorkspaceSlug } from "./slugs.js";

export const Workspace = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String(), slug: WorkspaceSlug });
export type Workspace = Static<typeof Workspace>;

export const WorkspaceName = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });

export const Membership = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  slug: WorkspaceSlug,
  isAdmin: Type.Boolean(),
});
export type Membership = Static<typeof Membership>;

/** The Workspaces a User belongs to. */
export async function workspacesOf(db: Db, userId: string): Promise<Membership[]> {
  const { rows } = await db.query<Membership>(
    `select workspaces.id, workspaces.name, workspaces.slug, memberships.is_admin as "isAdmin"
     from memberships join workspaces on workspaces.id = memberships.workspace_id
     where memberships.user_id = $1 order by workspaces.name, workspaces.id`,
    [userId],
  );
  return rows;
}

/** A Workspace in the Viewer's view; otherwise nothing, as if it didn't exist. */
export async function findWorkspace(db: Db, viewer: Viewer, workspaceId: string): Promise<Workspace | undefined> {
  if (!isUuid(workspaceId)) return undefined;
  const view = inView(viewer, "workspaces.id", "$2");
  const { rows } = await db.query<Workspace>(
    `select workspaces.id, workspaces.name, workspaces.slug from workspaces where workspaces.id = $1 and ${view.sql}`,
    [workspaceId, view.value],
  );
  return rows[0];
}

/** Creates a Workspace with the User as its first Admin, under the slug they chose or one made from its name. */
export async function createWorkspace(
  db: Db,
  clock: Clock,
  userId: string,
  input: { name: string; slug?: string },
): Promise<Membership> {
  return transaction(db, async (tx) => {
    const now = clock.now();
    const workspace = await insertWorkspace(tx, input.name, now, input.slug);
    await tx.query(
      "insert into memberships (workspace_id, user_id, is_admin, created_at) values ($1, $2, true, $3)",
      [workspace.id, userId, now],
    );
    return { ...workspace, isAdmin: true };
  });
}

/** Inserts a Workspace, with its slug. */
export async function insertWorkspace(tx: Tx, name: string, now: Date, chosenSlug?: string): Promise<Workspace> {
  const slug = await slugForNewWorkspace(tx, name.trim(), chosenSlug);
  const { rows } = await tx.query<Workspace>(
    "insert into workspaces (name, slug, created_at) values ($1, $2, $3) returning id, name, slug",
    [name.trim(), slug, now],
  );
  return rows[0]!;
}

/** Renames a Workspace; its slug stays as it is. */
export async function renameWorkspace(db: Db, workspaceId: string, name: string): Promise<Workspace> {
  const { rows } = await db.query<Workspace>("update workspaces set name = $1 where id = $2 returning id, name, slug", [
    name.trim(),
    workspaceId,
  ]);
  return rows[0]!;
}

/** A Workspace's settings beyond its name, set by its Admins. */
export const WorkspaceSettings = Type.Object({
  lostRunMinutes: Type.Integer({
    minimum: 1,
    maximum: 10_080,
    description: "How long a Run may go without a call naming it or its Ticket before it is lost. 30 unless changed.",
  }),
});
export type WorkspaceSettings = Static<typeof WorkspaceSettings>;

export async function settingsOf(db: Db, workspaceId: string): Promise<WorkspaceSettings> {
  const { rows } = await db.query<WorkspaceSettings>(
    `select lost_run_minutes as "lostRunMinutes" from workspaces where id = $1`,
    [workspaceId],
  );
  return rows[0]!;
}

export async function changeSettings(db: Db, workspaceId: string, change: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
  const { rows } = await db.query<WorkspaceSettings>(
    `update workspaces set lost_run_minutes = coalesce($2, lost_run_minutes) where id = $1
     returning lost_run_minutes as "lostRunMinutes"`,
    [workspaceId, change.lostRunMinutes ?? null],
  );
  return rows[0]!;
}
