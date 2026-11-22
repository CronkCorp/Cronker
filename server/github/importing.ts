import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, violates, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { userViewer, type Viewer } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { indexMentions } from "../work/mentions.js";
import { findProject, projectNotFound, statusesOf } from "../work/projects.js";
import { distinctLabels } from "../work/tickets.js";
import { requireAdmin } from "../workspaces/members.js";
import { appToken } from "./app.js";
import { userName } from "../identity/user.js";
import {
  appInstallations,
  issueCommentsPage,
  issuesPage,
  type AccountOnGitHub,
  type IssueCommentOnGitHub,
  type IssueOnGitHub,
} from "./client.js";
import { installationCovering, tokenFor } from "./installations.js";

/**
 * Importing a Repository's GitHub issues into a Project that lists it, so an existing backlog starts in Cronk. An
 * Admin starts an import; it then runs as a background job, `runImports` reading one page of issues, oldest first,
 * per pass, until GitHub has listed them all. Each issue becomes an undelegated Ticket created at GitHub's time by
 * the Admin: open ones in the Project's first Backlog Status, those closed as not planned in its first Canceled
 * Status and other closed ones in its first Done Status, Verified. Pull Requests GitHub lists among the issues are
 * left out, and an issue imported before, known by its node id, is skipped, so an import can run again.
 *
 * Each issue brings its Comments, oldest first at GitHub's times, and its people: the issue's author, its Comments'
 * authors and its assignees are matched to Users of the Workspace by linked GitHub account. A matched author
 * creates the Ticket or writes the Comment; an unmatched one is kept as the GitHub login, shown as "@login on
 * GitHub", and listed in the import's summary. The first matched assignee becomes the Ticket's Assignee; unmatched
 * ones are dropped. No User is ever created.
 *
 * Each page's Tickets are written in one transaction with the page the next pass reads, so a pass cut short is read
 * again whole. Later passes may add to a page's work (Comments, structure, waiting out rate limits) in `importIssue`
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
  unmatchedAuthors: Type.Array(Type.String(), {
    description: "The GitHub logins of the issue and Comment authors so far that no User of the Workspace has linked, alphabetical.",
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
  unmatchedAuthors: string[];
  startedAt: Date;
  finishedAt: Date | null;
}

const importColumns = `id, project_id as "projectId", workspace_id as "workspaceId", repository_id as "repositoryId",
  repository_full_name as "repositoryFullName", started_by as "startedBy", state, next_page as "nextPage", imported,
  skipped, error, unmatched_authors as "unmatchedAuthors", started_at as "startedAt", finished_at as "finishedAt"`;

const importOf = (row: ImportRow): Import => ({
  id: row.id,
  // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
  repository: { id: Number(row.repositoryId), fullName: row.repositoryFullName },
  state: row.state,
  imported: row.imported,
  skipped: row.skipped,
  error: row.error,
  unmatchedAuthors: row.unmatchedAuthors,
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
 * One pass over the running imports: each reads its next page of issues. An import GitHub refuses fails, saying why;
 * one GitHub can't answer is read again on the next pass. The first error is thrown once every import has had its pass.
 */
export async function runImports(context: Context): Promise<void> {
  const { rows } = await context.db.query<{ id: string }>("select id from github_imports where state = 'running' order by seq");
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
      `select ${importColumns} from github_imports where id = $1 and state = 'running' for update skip locked`,
      [importId],
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
    const token = await tokenFor(context, installationId);
    const page = await issuesPage(config, token, fullName, job.nextPage);
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
    const issues = page.issues.filter((issue) => issue.pull_request === undefined || issue.pull_request === null);
    const { rows: known } = await tx.query<{ nodeId: string }>(
      `select github_issue_node_id as "nodeId" from tickets where project_id = $1 and github_issue_node_id = any($2)`,
      [job.projectId, issues.map((issue) => issue.node_id)],
    );
    const before = new Set(known.map((row) => row.nodeId));
    const fresh = issues.filter((issue) => !before.has(issue.node_id));
    // Every Comment is read before anything is written, so a refusal fails the import with nothing of the page kept.
    const comments = new Map<string, IssueCommentOnGitHub[]>();
    for (const issue of fresh) {
      const read = await commentsOf(context, token, fullName, issue.number);
      if (read.kind === "refused") {
        return void (await fail(
          read.status === 403
            ? `GitHub refused to list the Comments of ${fullName}#${issue.number} to the App. ${permissionAdvice}`
            : `GitHub no longer shows the Comments of ${fullName}#${issue.number} to the App.`,
        ));
      }
      comments.set(issue.node_id, read.comments);
    }
    const people = await usersOf(tx, job.workspaceId, [
      ...fresh.flatMap((issue) => [issue.user, ...(issue.assignees ?? [])]),
      ...[...comments.values()].flat().map((comment) => comment.user),
    ]);
    const unmatched = new Set<string>();
    let imported = 0;
    for (const issue of fresh) {
      if (await importIssue(context, tx, job, places, people, unmatched, issue, comments.get(issue.node_id)!)) imported++;
    }
    await tx.query(
      `update github_imports set imported = imported + $2, skipped = skipped + $3, next_page = next_page + 1,
         state = case when $4 then 'running' else 'done' end, finished_at = case when $4 then null else $5::timestamptz end,
         unmatched_authors = array(select distinct login from unnest(unmatched_authors || $6::text[]) as login order by login)
       where id = $1`,
      [job.id, imported, issues.length - imported, page.more, clock.now(), [...unmatched]],
    );
  });
}

/** Where an issue goes by its state: open, closed as completed, or closed as not planned. */
interface Places {
  open: string;
  done: string;
  canceled: string;
}

/** Every Comment on an issue, oldest first, reading each page GitHub has. */
async function commentsOf(
  { config }: Context,
  token: string,
  fullName: string,
  number: number,
): Promise<{ kind: "comments"; comments: IssueCommentOnGitHub[] } | { kind: "refused"; status: number }> {
  const comments: IssueCommentOnGitHub[] = [];
  for (let page = 1; ; page++) {
    const read = await issueCommentsPage(config, token, fullName, number, page);
    if (read.kind === "refused") return read;
    comments.push(...read.comments);
    if (!read.more) return { kind: "comments", comments };
  }
}

/** A User of the Workspace, as an imported Ticket or Comment names them. */
interface Person {
  id: string;
  name: string;
}

/** The Users of the Workspace who linked these GitHub accounts, by GitHub's id for the account. */
async function usersOf(tx: Tx, workspaceId: string, accounts: (AccountOnGitHub | null | undefined)[]): Promise<Map<number, Person>> {
  const ids = [...new Set(accounts.flatMap((account) => (account ? [account.id] : [])))];
  if (ids.length === 0) return new Map();
  const { rows } = await tx.query<{ githubId: string; id: string; name: string }>(
    `select users.github_id as "githubId", users.id, ${userName()} as name from users
     join memberships on memberships.user_id = users.id and memberships.workspace_id = $1
     where users.github_id = any($2::bigint[])`,
    [workspaceId, ids],
  );
  return new Map(rows.map((row) => [Number(row.githubId), { id: row.id, name: row.name }]));
}

/** The login GitHub shows for an account it has since deleted. */
const deletedAccount = "ghost";

/** Makes a Ticket of an issue, with its Comments, unless one was made of it before; whether it made one. */
async function importIssue(
  context: Context,
  tx: Tx,
  job: ImportRow,
  places: Places,
  people: Map<number, Person>,
  unmatched: Set<string>,
  issue: IssueOnGitHub,
  comments: IssueCommentOnGitHub[],
): Promise<boolean> {
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
  const author = issue.user ? people.get(issue.user.id) : undefined;
  if (!author) unmatched.add(issue.user?.login ?? deletedAccount);
  const assignee = (issue.assignees ?? []).map((account) => people.get(account.id)).find((person) => person !== undefined);
  const { rows } = await tx.query<{ id: string }>(
    `with numbered as (
       update projects set next_ticket_number = next_ticket_number + 1 where id = $2
       returning next_ticket_number - 1 as number
     )
     insert into tickets (workspace_id, project_id, number, title, description, status_id, labels, verification,
       created_by, created_at, status_entered_at, github_issue_node_id, github_issue_url, assignee_id)
     select $1, $2, number, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12 from numbered
     returning id`,
    [
      job.workspaceId,
      job.projectId,
      title,
      description,
      statusId,
      labels,
      statusId === places.done ? "verified" : null,
      author?.id ?? job.startedBy,
      createdAt,
      issue.node_id,
      issue.html_url,
      assignee?.id ?? null,
    ],
  );
  const ticket = { id: rows[0]!.id, workspaceId: job.workspaceId };
  await indexMentions(tx, "ticket", ticket, description);
  await recordChanges(tx, ticket, job.startedBy, createdAt, [
    {
      field: "created",
      from: null,
      to: { source: "github", url: issue.html_url, author: author ?? { login: issue.user?.login ?? deletedAccount } },
    },
    ...(assignee ? [{ field: "assignee" as const, from: null, to: assignee }] : []),
  ]);
  for (const comment of comments) {
    const writer = comment.user ? people.get(comment.user.id) : undefined;
    const login = writer ? null : (comment.user?.login ?? deletedAccount);
    if (login !== null) unmatched.add(login);
    const body = comment.body ?? "";
    const { rows: written } = await tx.query<{ id: string }>(
      `insert into comments (workspace_id, ticket_id, actor_user_id, body, created_at, github_author_login)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [job.workspaceId, ticket.id, writer?.id ?? null, body, new Date(comment.created_at), login],
    );
    await indexMentions(tx, "comment", { id: written[0]!.id, workspaceId: job.workspaceId }, body);
  }
  context.live.publish(tx, job.workspaceId, { type: "ticket.created", projectId: job.projectId, ticketId: ticket.id });
  return true;
}
