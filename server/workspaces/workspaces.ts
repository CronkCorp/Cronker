import { Type, type Static } from "typebox";
import { transaction, type Db, type Tx } from "../db.js";
import type { Clock } from "../clock.js";
import { ApiError } from "../http/errors.js";
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
/** The create-a-Workspace route's body: its slug is made from its name unless given. */
export const WorkspaceCreate = Type.Object({ name: WorkspaceName, slug: Type.Optional(WorkspaceSlug) });
export type WorkspaceCreate = Static<typeof WorkspaceCreate>;

/** The rename-a-Workspace route's body. */
export const WorkspaceRename = Type.Object({ name: WorkspaceName });
export type WorkspaceRename = Static<typeof WorkspaceRename>;

export async function createWorkspace(
  db: Db,
  clock: Clock,
  userId: string,
  input: WorkspaceCreate,
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

/** What one model label stands for: the exact model id a Runner setup gives routines for Steps wanting it. */
export const ModelId = Type.Object({
  label: Type.String({
    minLength: 1,
    maxLength: 50,
    pattern: "^\\S(.*\\S)?$",
    description: "The model label, as Steps name it, such as `haiku`; matched ignoring case.",
  }),
  modelId: Type.String({
    minLength: 1,
    maxLength: 100,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
    description: "The exact model id, such as `claude-haiku-5-5`.",
  }),
});
export type ModelId = Static<typeof ModelId>;

/** How many model labels a Workspace may have. */
export const mostModelLabels = 50;

/** How far Agents may go somewhere: Write, Read, or None, which puts it out of their reach; described for where. */
export const agentAccess = (description: string) =>
  Type.Union([Type.Literal("write"), Type.Literal("read"), Type.Literal("none")], { description });
export type AgentAccess = "write" | "read" | "none";

/** A Workspace's settings beyond its name, set by its Admins. */
export const WorkspaceSettings = Type.Object({
  lostRunMinutes: Type.Integer({
    minimum: 1,
    maximum: 10_080,
    description: "How long a Run may go without a call naming it or its Ticket before it is lost. 30 unless changed.",
  }),
  modelIds: Type.Array(ModelId, {
    maxItems: mostModelLabels,
    description:
      "The model id each model label stands for, labels unique ignoring case. A Runner setup gives each routine the " +
      "model id of its label. Ships with the latest Haiku, Sonnet and Opus for `haiku`, `sonnet` and `opus`.",
  }),
  agentAccess: agentAccess(
    "The Workspace's Agent Access: how far Agents may go in its own Documents, Terms, Decisions and Artifacts. " +
      "`write` (the default), `read`, refusing their writes there with `read_access`, or `none`, answering as not " +
      "found to them. An Agent may do the least of it, its Owner's Access and its token's access. Projects set their own.",
  ),
});
export type WorkspaceSettings = Static<typeof WorkspaceSettings>;

const settingsColumns = `lost_run_minutes as "lostRunMinutes", model_ids as "modelIds", agent_access as "agentAccess"`;

export async function settingsOf(db: Db, workspaceId: string): Promise<WorkspaceSettings> {
  const { rows } = await db.query<WorkspaceSettings>(`select ${settingsColumns} from workspaces where id = $1`, [workspaceId]);
  return rows[0]!;
}

/** The model id a label stands for in the Workspace, matched ignoring case. */
export function modelIdOf(settings: Pick<WorkspaceSettings, "modelIds">, label: string): string | undefined {
  return settings.modelIds.find((m) => m.label.toLowerCase() === label.toLowerCase())?.modelId;
}

/** The change-settings route's body: whichever settings are given change. */
export const WorkspaceSettingsEdit = Type.Partial(WorkspaceSettings);
export type WorkspaceSettingsEdit = Static<typeof WorkspaceSettingsEdit>;

export async function changeSettings(db: Db, workspaceId: string, change: WorkspaceSettingsEdit): Promise<WorkspaceSettings> {
  const modelIds = change.modelIds?.map((m) => ({ label: m.label.trim(), modelId: m.modelId.trim() }));
  if (modelIds) {
    const seen = new Set<string>();
    for (const { label } of modelIds) {
      if (seen.has(label.toLowerCase())) {
        throw new ApiError(400, "duplicate_model_label", `The model label ${label} is given more than one model id: each label stands for one, matched ignoring case.`,
        );
      }
      seen.add(label.toLowerCase());
    }
  }
  const { rows } = await db.query<WorkspaceSettings>(
    `update workspaces set lost_run_minutes = coalesce($2, lost_run_minutes), model_ids = coalesce($3, model_ids),
       agent_access = coalesce($4, agent_access)
     where id = $1 returning ${settingsColumns}`,
    [workspaceId, change.lostRunMinutes ?? null, modelIds ? JSON.stringify(modelIds) : null, change.agentAccess ?? null],
  );
  return rows[0]!;
}
