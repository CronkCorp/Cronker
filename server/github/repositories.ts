import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { userViewer } from "../identity/viewers.js";
import { findProject, projectNotFound, type ProjectSummary } from "../work/projects.js";
import type { Viewer } from "../identity/viewers.js";
import { repositoryById } from "./client.js";
import { listInstallations, tokenFor } from "./installations.js";
import type { EventHandler } from "./webhooks.js";

/**
 * The Repositories a Project lists as holding its code. A Repository is known by GitHub's
 * id, so a rename or transfer keeps it; its owner/name is kept only for showing. Any User of
 * the Workspace adds or removes them, choosing among those the App's installations cover.
 */

export const Repository = Type.Object({
  id: Type.Integer({ description: "GitHub's id for the Repository, which stays the same through renames and transfers." }),
  fullName: Type.String({ description: "`owner/name` as GitHub last reported it." }),
  keyClash: Type.Boolean({
    description:
      "Whether a Project of another Workspace lists this Repository under the same key, so its Pull Requests link to Tickets there too. Which Project, and whose, is never said.",
  }),
});
export type Repository = Static<typeof Repository>;

/**
 * The Repositories a Project lists, by owner and name. Keys are unique within a Workspace,
 * so a Project sharing this one's key on a Repository is always in another Workspace.
 */
async function repositoriesListed(db: Db | Tx, projectId: string): Promise<Repository[]> {
  const { rows } = await db.query<{ id: string; fullName: string; keyClash: boolean }>(
    `select repositories.id, repositories.full_name as "fullName",
       exists (
         select from project_repositories others join projects other on other.id = others.project_id
         where others.repository_id = repositories.id and other.id <> projects.id and lower(other.key) = lower(projects.key)
       ) as "keyClash"
     from project_repositories
     join repositories on repositories.id = project_repositories.repository_id
     join projects on projects.id = project_repositories.project_id
     where project_repositories.project_id = $1
     order by lower(repositories.full_name), repositories.id`,
    [projectId],
  );
  // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
  return rows.map((r) => ({ id: Number(r.id), fullName: r.fullName, keyClash: r.keyClash }));
}

/** The Repositories of a Project in the Viewer's view. */
export async function repositoriesOf({ db }: Context, viewer: Viewer, projectId: string): Promise<Repository[]> {
  const project = await findProject(db, viewer, projectId);
  if (!project) throw projectNotFound();
  return repositoriesListed(db, project.id);
}

/**
 * Adds a Repository one of the App's installations covers to a Project, by GitHub's id. GitHub
 * is asked afresh which Repositories that is, so a list kept from before can't add one the App
 * no longer reads, nor refuse one just installed.
 */
export async function addRepository(context: Context, userId: string, projectId: string, repositoryId: number): Promise<Repository> {
  const viewer = userViewer(userId);
  if (!(await findProject(context.db, viewer, projectId))) throw projectNotFound();
  const covered = (await listInstallations(context, { refresh: true })).flatMap((i) => i.repositories).find((r) => r.id === repositoryId);
  if (!covered) {
    throw new ApiError(
      409,
      "repository_not_installed",
      "The GitHub App isn't installed on that Repository. Install it there on GitHub, then add the Repository.",
    );
  }
  return transaction(context.db, async (tx) => {
    const project = await findProject(tx, viewer, projectId, { lock: true });
    if (!project) throw projectNotFound();
    const now = context.clock.now();
    await tx.query(
      `insert into repositories (id, full_name, updated_at) values ($1, $2, $3)
       on conflict (id) do update set full_name = excluded.full_name, updated_at = excluded.updated_at`,
      [covered.id, covered.fullName, now],
    );
    const { rowCount } = await tx.query(
      `insert into project_repositories (project_id, workspace_id, repository_id, added_by, added_at)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [project.id, project.workspaceId, covered.id, userId, now],
    );
    if (rowCount === 0) throw new ApiError(409, "repository_already_listed", `The Project already lists ${covered.fullName}.`);
    await announceListChanged(context, tx, project, covered.id);
    return (await repositoriesListed(tx, project.id)).find((r) => r.id === covered.id)!;
  });
}

/**
 * Tells the Project's Workspace its list changed, and the Workspace of each other Project
 * listing the Repository under the same key that its own Project changed, since its warning
 * comes or goes. That Workspace hears only of its own Project.
 */
async function announceListChanged({ live }: Context, tx: Tx, project: ProjectSummary, repositoryId: number): Promise<void> {
  live.publish(tx, project.workspaceId, { type: "project.changed", projectId: project.id });
  const { rows } = await tx.query<{ projectId: string; workspaceId: string }>(
    `select projects.id as "projectId", projects.workspace_id as "workspaceId"
     from project_repositories join projects on projects.id = project_repositories.project_id
     where project_repositories.repository_id = $1 and projects.id <> $2 and lower(projects.key) = lower($3)`,
    [repositoryId, project.id, project.key],
  );
  for (const { projectId, workspaceId } of rows) live.publish(tx, workspaceId, { type: "project.changed", projectId });
}

/** Removes a Repository from a Project's list. */
export async function removeRepository(context: Context, userId: string, projectId: string, repositoryId: number): Promise<void> {
  await transaction(context.db, async (tx) => {
    const project = await findProject(tx, userViewer(userId), projectId, { lock: true });
    if (!project) throw projectNotFound();
    const { rowCount } = await tx.query("delete from project_repositories where project_id = $1 and repository_id = $2", [
      project.id,
      repositoryId,
    ]);
    if (rowCount === 0) throw new ApiError(404, "not_found", "The Project doesn't list that Repository.");
    // A Repository no Project lists any more is forgotten, so nothing keeps its name up to date.
    await tx.query(
      "delete from repositories where id = $1 and not exists (select from project_repositories where repository_id = $1)",
      [repositoryId],
    );
    await announceListChanged(context, tx, project, repositoryId);
  });
  // Someone is changing which Repositories the Project lists, so the next listing asks GitHub afresh, as adding did.
  context.installationListings.forget();
}

/**
 * GitHub's `repository` event: a rename or transfer changes the owner/name shown for a
 * Repository a Project lists. Deliveries can arrive late or out of order, so the name is
 * read from GitHub as it is now, falling back to the delivery's own only when the App's
 * installation no longer covers the Repository, as after a transfer to another owner.
 * What Cronk keeps of the App's installations is asked of GitHub again, whether or not a
 * Project lists this Repository: a rename's installation's Repositories, or everything after a
 * transfer, which may move the Repository to another installation. Other actions change
 * nothing, and for Repositories no Project lists, nothing else.
 */
export const onRepositoryEvent: EventHandler = async (context, tx, { payload }) => {
  const { action, repository, installation } = payload as {
    action?: string;
    repository?: { id?: unknown; full_name?: unknown };
    installation?: { id?: unknown };
  };
  if (action !== "renamed" && action !== "transferred") return;
  if (typeof repository?.id !== "number" || typeof repository.full_name !== "string") return;
  if (action === "renamed" && typeof installation?.id === "number") context.installationListings.forgetRepositoriesOf(installation.id);
  else context.installationListings.forget();
  const { rows: known } = await tx.query("select from repositories where id = $1 for update", [repository.id]);
  if (known.length === 0) return;
  const current =
    typeof installation?.id === "number"
      ? await repositoryById(context.config, await tokenFor(context, installation.id), repository.id)
      : undefined;
  const fullName = current?.full_name ?? repository.full_name;
  await tx.query("update repositories set full_name = $2, updated_at = $3 where id = $1", [repository.id, fullName, context.clock.now()]);
  const { rows } = await tx.query<{ projectId: string; workspaceId: string }>(
    `select project_id as "projectId", workspace_id as "workspaceId" from project_repositories where repository_id = $1`,
    [repository.id],
  );
  for (const { projectId, workspaceId } of rows) context.live.publish(tx, workspaceId, { type: "project.changed", projectId });
};
