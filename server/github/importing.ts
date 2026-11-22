import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, violates, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { userViewer, type Viewer } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { indexMentions } from "../work/mentions.js";
import { findProject, projectNotFound, statusesOf } from "../work/projects.js";
import { distinctLabels } from "../work/tickets.js";
import { retryAt } from "../runs/subscription.js";
import { requireAdmin } from "../workspaces/members.js";
import { appToken } from "./app.js";
import { appInstallations, issuesPage, type IssueOnGitHub } from "./client.js";
import { installationCovering, tokenFor } from "./installations.js";

/**
 * Importing a Repository's GitHub issues into a Project that lists it, so an existing backlog starts in Cronk. An
 * Admin starts an import; it then runs as a background job, `runImports` reading one page of issues, oldest first,
 * per pass, until GitHub has listed them all. Each issue becomes an undelegated Ticket created at GitHub's time by
 * the Admin: open ones in the Project's first Backlog Status, those closed as not planned in its first Canceled
 * Status and other closed ones in its first Done Status, Verified. Pull Requests GitHub lists among the issues are
 * left out, and an issue imported before, known by its node id, is skipped, so an import can run again.
 *
 * Each page's Tickets are written in one transaction with the page the next pass reads, so a pass cut short is read
 * again whole. A page GitHub rate-limits is read again once the limit lifts: until then the import waits, saying
 * until when, and passes leave it be. Later passes may add to a page's work (Comments, structure) in `importIssue`
 * and `importNextPage` without changing how a job runs.
 */

export const Import = Type.Object({
  id: Type.String({ format: "uuid" }),
  repository: Type.Object({
    id: Type.Integer({ description: "GitHub's id for the Repository." }),
    fullName: Type.String({ description: "`owner/name` as it was when the import started." }),
  }),
  state: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  imported: Type.Integer({ minimum: 0, description: "How many issues became Tickets so far." }),
  skipped: Type.Integer({ minimum: 0, description: "How many issues were skipped, having been imported before." }),
  error: Type.Union([Type.String(), Type.Null()], { description: "Why a failed import stopped; null otherwise." }),
  waitingUntil: Type.Union([Type.String({ format: "date-time" }), Type.Null()], {
    description: "While a running import waits out GitHub's rate limit, when it carries on; null otherwise.",
  }),
  startedBy: Type.String({ format: "uuid", description: "The Admin who started it, whose Changes create its Tickets." }),
  startedAt: Type.String({ format: "date-time" }),
  finishedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type Import = Static<typeof Import>;

interface ImportRow {
  id: string;
  projectId: string;
  workspaceId: string;
  repositoryId: string;
  repositoryFullName: string;
  startedBy: string;
  state: Import["state"];
  nextPage: number;
  imported: number;
  skipped: number;
  error: string | null;
  pausedUntil: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const importColumns = `id, project_id as "projectId", workspace_id as "workspaceId", repository_id as "repositoryId",
  repository_full_name as "repositoryFullName", started_by as "startedBy", state, next_page as "nextPage", imported,
  skipped, error, paused_until as "pausedUntil", started_at as "startedAt", finished_at as "finishedAt"`;

const importOf = (row: ImportRow): Import => ({
  id: row.id,
  // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
  repository: { id: Number(row.repositoryId), fullName: row.repositoryFullName },
  state: row.state,
  imported: row.imported,
  skipped: row.skipped,
  error: row.error,
  waitingUntil: row.state === "running" ? (row.pausedUntil?.toISOString() ?? null) : null,
  startedBy: row.startedBy,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

const notListed = () => new ApiError(404, "not_found", "The Project doesn't list that Repository.");

/** Where an Admin adds a permission the App lacks, and has its installations accept it. */
const permissionAdvice =
  "An Admin adds the Issues (read) permission to the GitHub App, as the GitHub page lists it, and the owner of the " +
  "App's installation accepts it on GitHub; then start the import again.";

const permissionMissing = (account: string) =>
  new ApiError(409, "issues_permission_missing", `The GitHub App's installation on ${account} can't read issues yet. ${permissionAdvice}`);

/** Whether GitHub's access to a permission, such as `none` or absent, includes reading. */
const reads = (access: string | undefined) => access === "read" || access === "write";

/**
 * An Admin of the Project's Workspace starts importing the issues of a Repository the Project lists. Refused while
 * another import runs in the Project, and while the App's installation covering the Repository hasn't accepted
 * reading issues.
 */
export async function startImport(context: Context, userId: string, projectId: string, repositoryId: number): Promise<Import> {
  const { db, config, clock } = context;
  const project = await findProject(db, userViewer(userId), projectId);
  if (!project) throw projectNotFound();
  await requireAdmin(db, userId, project.workspaceId);
  const { rows: listed } = await db.query<{ fullName: string }>(
    `select repositories.full_name as "fullName" from project_repositories
     join repositories on repositories.id = project_repositories.repository_id
     where project_repositories.project_id = $1 and project_repositories.repository_id = $2`,
    [project.id, repositoryId],
  );
  const repository = listed[0];
  if (!repository) throw notListed();
  const installationId = await installationCovering(context, repositoryId);
  if (installationId === undefined) {
    throw new ApiError(
      409,
      "repository_not_installed",
      `The GitHub App isn't installed on ${repository.fullName}. Install it there on GitHub, then import again.`,
    );
  }
  const installation = (await appInstallations(config, await appToken(context))).find((i) => i.id === installationId);
  if (!installation || !reads(installation.permissions?.issues)) throw permissionMissing(installation?.account.login ?? "GitHub");
  try {
    const { rows } = await db.query<ImportRow>(
      `insert into github_imports (project_id, workspace_id, repository_id, repository_full_name, started_by, state, started_at)
       values ($1, $2, $3, $4, $5, 'running', $6) returning ${importColumns}`,
      [project.id, project.workspaceId, repositoryId, repository.fullName, userId, clock.now()],
    );
    return importOf(rows[0]!);
  } catch (error) {
    if (violates(error, "github_imports_running_idx")) {
      throw new ApiError(409, "import_running", "An import is already running in this Project. Wait for it to finish, then start another.");
    }
    throw error;
  }
}

/** The latest import of a Repository into a Project in the Viewer's view, if there was one. */
export async function latestImport(context: Context, viewer: Viewer, projectId: string, repositoryId: number): Promise<Import | null> {
  const project = await findProject(context.db, viewer, projectId);
  if (!project) throw projectNotFound();
  const { rows } = await context.db.query<ImportRow>(
    `select ${importColumns} from github_imports where project_id = $1 and repository_id = $2
     order by seq desc limit 1`,
    [project.id, repositoryId],
  );
  return rows[0] ? importOf(rows[0]) : null;
}

/**
 * One pass over the running imports: each reads its next page of issues, except one waiting out GitHub's rate limit.
 * An import GitHub refuses fails, saying why; one GitHub can't answer is read again on the next pass. The first error
 * is thrown once every import has had its pass.
 */
export async function runImports(context: Context): Promise<void> {
  const { rows } = await context.db.query<{ id: string }>(
    "select id from github_imports where state = 'running' and (paused_until is null or paused_until <= $1) order by seq",
    [context.clock.now()],
  );
  let failure: unknown;
  for (const { id } of rows) {
    try {
      await importNextPage(context, id);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/** Reads the import's next page of issues, if it is still running and no other pass holds it. */
async function importNextPage(context: Context, importId: string): Promise<void> {
  const { config, clock } = context;
  await transaction(context.db, async (tx) => {
    const { rows } = await tx.query<ImportRow>(
      `select ${importColumns} from github_imports
       where id = $1 and state = 'running' and (paused_until is null or paused_until <= $2) for update skip locked`,
      [importId, clock.now()],
    );
    const job = rows[0];
    if (!job) return;
    const fail = (error: string) =>
      tx.query("update github_imports set state = 'failed', error = $2, finished_at = $3 where id = $1", [job.id, error, clock.now()]);
    // A Repository renamed since the import started is read by its name now.
    const { rows: current } = await tx.query<{ fullName: string }>(`select full_name as "fullName" from repositories where id = $1`, [
      job.repositoryId,
    ]);
    const fullName = current[0]?.fullName ?? job.repositoryFullName;
    const installationId = await installationCovering(context, Number(job.repositoryId));
    if (installationId === undefined) return void (await fail(`The GitHub App is no longer installed on ${fullName}.`));
    const page = await issuesPage(config, await tokenFor(context, installationId), fullName, job.nextPage);
    if (page.kind === "rate_limited") {
      // Nothing of the page is written, so the pass after the wait reads it again from its first issue.
      await tx.query("update github_imports set paused_until = $2 where id = $1", [job.id, limitLifts(clock.now(), page)]);
      return;
    }
    if (page.kind === "refused") {
      return void (await fail(
        page.status === 403
          ? `GitHub refused to list ${fullName}'s issues to the App. ${permissionAdvice}`
          : `GitHub no longer shows ${fullName}'s issues to the App.`,
      ));
    }
    const statuses = await statusesOf(tx, job.projectId);
    const first = (kind: string) => statuses.find((s) => s.kind === kind)!.id;
    const places = { open: first("backlog"), done: first("done"), canceled: first("canceled") };
    let imported = 0;
    let skipped = 0;
    for (const issue of page.issues) {
      if (issue.pull_request !== undefined && issue.pull_request !== null) continue;
      if (await importIssue(context, tx, job, places, issue)) imported++;
      else skipped++;
    }
    await tx.query(
      `update github_imports set imported = imported + $2, skipped = skipped + $3, next_page = next_page + 1, paused_until = null,
         state = case when $4 then 'running' else 'done' end, finished_at = case when $4 then null else $5::timestamptz end
       where id = $1`,
      [job.id, imported, skipped, page.more, clock.now()],
    );
  });
}

/** The longest wait for GitHub's rate limit to lift, as for `Retry-After`: a day. */
const longestPauseMs = 24 * 60 * 60 * 1000;

/**
 * When GitHub's rate limit lifts: its `Retry-After` when it gives one, else its `X-RateLimit-Reset` (seconds since the
 * epoch), else a minute from now; never in the past, and a day at most.
 */
function limitLifts(now: Date, limit: { retryAfter: string | null; reset: string | null }): Date {
  const reset = limit.reset?.trim() ?? "";
  if (limit.retryAfter !== null || !/^\d+$/.test(reset)) return retryAt(now, limit.retryAfter);
  return new Date(Math.min(Math.max(Number(reset) * 1000, now.getTime()), now.getTime() + longestPauseMs));
}

/** Where an issue goes by its state: open, closed as completed, or closed as not planned. */
interface Places {
  open: string;
  done: string;
  canceled: string;
}

/** Makes a Ticket of an issue, unless one was made of it before; whether it made one. */
async function importIssue(context: Context, tx: Tx, job: ImportRow, places: Places, issue: IssueOnGitHub): Promise<boolean> {
  const { rowCount } = await tx.query("select 1 from tickets where project_id = $1 and github_issue_node_id = $2", [
    job.projectId,
    issue.node_id,
  ]);
  if (rowCount !== 0) return false;
  const closed = issue.state === "closed";
  const statusId = !closed ? places.open : issue.state_reason === "not_planned" ? places.canceled : places.done;
  const labels = distinctLabels(
    issue.labels.flatMap((label) => {
      const name = typeof label === "string" ? label : label.name;
      return name && name.trim() ? [name] : [];
    }),
  );
  const title = issue.title.trim() || `Issue #${issue.number}`;
  const description = issue.body ?? "";
  const createdAt = new Date(issue.created_at);
  const { rows } = await tx.query<{ id: string }>(
    `with numbered as (
       update projects set next_ticket_number = next_ticket_number + 1 where id = $2
       returning next_ticket_number - 1 as number
     )
     insert into tickets (workspace_id, project_id, number, title, description, status_id, labels, verification,
       created_by, created_at, status_entered_at, github_issue_node_id, github_issue_url)
     select $1, $2, number, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11 from numbered
     returning id`,
    [
      job.workspaceId,
      job.projectId,
      title,
      description,
      statusId,
      labels,
      statusId === places.done ? "verified" : null,
      job.startedBy,
      createdAt,
      issue.node_id,
      issue.html_url,
    ],
  );
  const ticket = { id: rows[0]!.id, workspaceId: job.workspaceId };
  await indexMentions(tx, "ticket", ticket, description);
  await recordChanges(tx, ticket, job.startedBy, createdAt, [
    { field: "created", from: null, to: { source: "github", url: issue.html_url } },
  ]);
  context.live.publish(tx, job.workspaceId, { type: "ticket.created", projectId: job.projectId, ticketId: ticket.id });
  return true;
}
