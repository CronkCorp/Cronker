import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, violates, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { userViewer, type Viewer } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { indexMentions } from "../work/mentions.js";
import { findProject, projectNotFound, statusesOf } from "../work/projects.js";
import { blocksTransitively, recordRelationChanges } from "../work/relations.js";
import { lockTickets, writeTicket } from "../work/ticket-writes.js";
import { distinctLabels, findTicketRef } from "../work/tickets.js";
import { requireAdmin } from "../workspaces/members.js";
import { appToken } from "./app.js";
import { appInstallations, issuesPage, linkedIssues, type IssueLinks, type IssueOnGitHub } from "./client.js";
import { installationCovering, tokenFor } from "./installations.js";
import { referencedNumbers, rewriteMarkdown, rewritePlain } from "./issue-references.js";

/**
 * Importing a Repository's GitHub issues into a Project that lists it, so an existing backlog starts in Cronk. An
 * Admin starts an import; it then runs as a background job, `runImports` reading one page of issues, oldest first,
 * per pass, until GitHub has listed them all. Each issue becomes an undelegated Ticket created at GitHub's time by
 * the Admin: open ones in the Project's first Backlog Status, those closed as not planned in its first Canceled
 * Status and other closed ones in its first Done Status, Verified. Pull Requests GitHub lists among the issues are
 * left out, and an issue imported before, known by its node id, is skipped, so an import can run again.
 *
 * Each page's Tickets are written in one transaction with the page the next pass reads, so a pass cut short is read
 * again whole. Later passes may add to a page's work (Comments, waiting out rate limits) in `importIssue` and
 * `importNextPage` without changing how a job runs.
 *
 * Once every page is read the import keeps the issues' structure in a second phase, `linking`, when every issue of
 * the run has its Ticket, so the order issues came in doesn't matter. Each pass links a batch of the issues the pages
 * queued: a sub-issue becomes a Sub-Ticket of its parent's Ticket, an issue blocked by another is blocked by its
 * Ticket, and `#123` in a Ticket's title and description becomes the key of the Ticket issue 123 became, in this run
 * or an earlier one. Each structure links at least one Ticket this run made, so a later run links new issues to old
 * ones but leaves the old ones' structure as their Users keep it. The import is done when nothing is left to link.
 */

export const Import = Type.Object({
  id: Type.String({ format: "uuid" }),
  repository: Type.Object({
    id: Type.Integer({ description: "GitHub's id for the Repository." }),
    fullName: Type.String({ description: "`owner/name` as it was when the import started." }),
  }),
  state: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  phase: Type.Union([Type.Literal("issues"), Type.Literal("linking")], {
    description: "`issues` while it reads GitHub's pages of issues; `linking` once it keeps their structure.",
  }),
  imported: Type.Integer({ minimum: 0, description: "How many issues became Tickets so far." }),
  skipped: Type.Integer({ minimum: 0, description: "How many issues were skipped, having been imported before." }),
  error: Type.Union([Type.String(), Type.Null()], { description: "Why a failed import stopped; null otherwise." }),
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
  phase: Import["phase"];
  nextPage: number;
  imported: number;
  skipped: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const importColumns = `id, project_id as "projectId", workspace_id as "workspaceId", repository_id as "repositoryId",
  repository_full_name as "repositoryFullName", started_by as "startedBy", state, phase, next_page as "nextPage", imported,
  skipped, error, started_at as "startedAt", finished_at as "finishedAt"`;

const importOf = (row: ImportRow): Import => ({
  id: row.id,
  // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
  repository: { id: Number(row.repositoryId), fullName: row.repositoryFullName },
  state: row.state,
  phase: row.phase,
  imported: row.imported,
  skipped: row.skipped,
  error: row.error,
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

/** Reads the import's next page of issues, or links its next batch, if it is still running and no other pass holds it. */
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
    const refused = (status: number) =>
      fail(
        status === 403
          ? `GitHub refused to list ${fullName}'s issues to the App. ${permissionAdvice}`
          : `GitHub no longer shows ${fullName}'s issues to the App.`,
      );
    if (job.phase === "linking") {
      const linked = await linkNextBatch(context, tx, job, (number, links) => linkedIssues(config, token, fullName, number, links));
      if (linked === "refused") return void (await refused(403));
      if (linked === "none left") {
        await tx.query("update github_imports set state = 'done', finished_at = $2 where id = $1", [job.id, clock.now()]);
      }
      return;
    }
    const page = await issuesPage(config, token, fullName, job.nextPage);
    if (page.kind === "refused") return void (await refused(page.status));
    const statuses = await statusesOf(tx, job.projectId);
    const first = (kind: string) => statuses.find((s) => s.kind === kind)!.id;
    const places = { open: first("backlog"), done: first("done"), canceled: first("canceled") };
    let imported = 0;
    let skipped = 0;
    for (const issue of page.issues) {
      if (issue.pull_request !== undefined && issue.pull_request !== null) continue;
      const ticket = await importIssue(context, tx, job, places, issue);
      if (ticket.imported) imported++;
      else skipped++;
      await queueLinks(tx, job, ticket, issue);
    }
    // After the last page the import turns to linking, unless nothing was queued to link.
    const { rowCount: queued } = page.more
      ? { rowCount: 1 }
      : await tx.query("select 1 from github_import_links where import_id = $1 limit 1", [job.id]);
    const ends = !page.more && queued === 0;
    await tx.query(
      `update github_imports set imported = imported + $2, skipped = skipped + $3, next_page = next_page + 1,
         phase = case when $4 or $5 then 'issues' else 'linking' end,
         state = case when $5 then 'done' else 'running' end, finished_at = case when $5 then $6::timestamptz end
       where id = $1`,
      [job.id, imported, skipped, page.more, ends, clock.now()],
    );
  });
}

/** Where an issue goes by its state: open, closed as completed, or closed as not planned. */
interface Places {
  open: string;
  done: string;
  canceled: string;
}

/**
 * Makes a Ticket of an issue, unless one was made of it before; the Ticket, and whether it made it. A Ticket made
 * before learns the issue's number and Repository if it lacks them, so `#123` resolves to it.
 */
async function importIssue(
  context: Context,
  tx: Tx,
  job: ImportRow,
  places: Places,
  issue: IssueOnGitHub,
): Promise<{ id: string; imported: boolean }> {
  const { rows: before } = await tx.query<{ id: string }>(
    `update tickets set github_repository_id = coalesce(github_repository_id, $3),
       github_issue_number = coalesce(github_issue_number, $4)
     where project_id = $1 and github_issue_node_id = $2 returning id`,
    [job.projectId, issue.node_id, job.repositoryId, issue.number],
  );
  if (before[0]) return { id: before[0].id, imported: false };
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
       created_by, created_at, status_entered_at, github_issue_node_id, github_issue_url, github_repository_id,
       github_issue_number, github_import_id)
     select $1, $2, number, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13, $14 from numbered
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
      job.repositoryId,
      issue.number,
      job.id,
    ],
  );
  const ticket = { id: rows[0]!.id, workspaceId: job.workspaceId };
  await indexMentions(tx, "ticket", ticket, description);
  await recordChanges(tx, ticket, job.startedBy, createdAt, [
    { field: "created", from: null, to: { source: "github", url: issue.html_url } },
  ]);
  context.live.publish(tx, job.workspaceId, { type: "ticket.created", projectId: job.projectId, ticketId: ticket.id });
  return { id: ticket.id, imported: true };
}

/**
 * Queues an issue for the linking phase if it may have structure to keep: GitHub says it has sub-issues or is
 * blocked, or the run made its Ticket and its title or body refers to `#123`.
 */
async function queueLinks(tx: Tx, job: ImportRow, ticket: { id: string; imported: boolean }, issue: IssueOnGitHub): Promise<void> {
  const subIssues = (issue.sub_issues_summary?.total ?? 0) > 0;
  const dependencies = issue.issue_dependencies_summary;
  const blockedBy = (dependencies?.total_blocked_by ?? dependencies?.blocked_by ?? 0) > 0;
  const refers = ticket.imported && referencedNumbers(`${issue.title}\n${issue.body ?? ""}`).length > 0;
  if (!subIssues && !blockedBy && !refers) return;
  await tx.query(
    `insert into github_import_links (import_id, ticket_id, issue_number, sub_issues, blocked_by) values ($1, $2, $3, $4, $5)
     on conflict (import_id, ticket_id) do nothing`,
    [job.id, ticket.id, issue.number, subIssues, blockedBy],
  );
}

/** How many queued issues one linking pass links, each taking up to two calls to GitHub. */
const linkBatch = 25;

/** A Ticket of the Project as linking reads it. */
interface Linkable {
  id: string;
  parentId: string | null;
  delegateId: string | null;
  /** Whether this run made it. */
  ours: boolean;
}

type ListLinks = (number: number, links: IssueLinks) => ReturnType<typeof linkedIssues>;

/**
 * Links the next batch of the issues the import queued, in one transaction with taking them off the queue, so a pass
 * cut short links them again whole and, as each link is made only once, makes no Relation or Change twice. Answers
 * whether there were none left, or GitHub refused to list an issue's links.
 */
async function linkNextBatch(
  context: Context,
  tx: Tx,
  job: ImportRow,
  list: ListLinks,
): Promise<"linked" | "none left" | "refused"> {
  const { rows: batch } = await tx.query<{ ticketId: string; number: number; subIssues: boolean; blockedBy: boolean }>(
    `select ticket_id as "ticketId", issue_number as number, sub_issues as "subIssues", blocked_by as "blockedBy"
     from github_import_links where import_id = $1 order by issue_number, ticket_id limit ${linkBatch}`,
    [job.id],
  );
  if (batch.length === 0) return "none left";
  for (const queued of batch) {
    const [self] = await linkables(tx, job, "id = any($3::uuid[])", [[queued.ticketId]]);
    if (!self) continue;
    for (const [links, wanted] of [
      ["sub_issues", queued.subIssues],
      ["dependencies/blocked_by", queued.blockedBy],
    ] as const) {
      if (!wanted) continue;
      const listed = await list(queued.number, links);
      if (listed.kind === "refused") return "refused";
      const others = await linkables(tx, job, "github_issue_node_id = any($3::text[])", [listed.issues.map((i) => i.node_id)]);
      for (const other of others) {
        if (links === "sub_issues") await linkSubTicket(context, tx, job, self, other);
        else await linkBlock(context, tx, job, other, self);
      }
    }
    if (self.ours) await rewriteReferences(context, tx, job, self.id);
  }
  await tx.query("delete from github_import_links where import_id = $1 and ticket_id = any($2::uuid[])", [
    job.id,
    batch.map((queued) => queued.ticketId),
  ]);
  return "linked";
}

async function linkables(tx: Tx, job: ImportRow, where: string, params: unknown[]): Promise<Linkable[]> {
  const { rows } = await tx.query<Linkable>(
    `select id, parent_id as "parentId", delegate_id as "delegateId", github_import_id is not distinct from $2 as ours
     from tickets where project_id = $1 and ${where} order by number`,
    [job.projectId, job.id, ...params],
  );
  return rows;
}

/**
 * Makes a Ticket a Sub-Ticket of its parent issue's Ticket, as the Admin who started the import, recording it on both
 * timelines. Left out where neither is this run's, where the Ticket already has a parent, where it would form a cycle,
 * and under a delegated parent, which would hand the imported Ticket its Delegation.
 */
async function linkSubTicket(context: Context, tx: Tx, job: ImportRow, parent: Linkable, child: Linkable): Promise<void> {
  if (!parent.ours && !child.ours) return;
  if (parent.id === child.id || child.parentId !== null || parent.delegateId !== null) return;
  await tx.query("select pg_advisory_xact_lock(hashtext('parents'), hashtext($1))", [job.workspaceId]);
  const { rowCount: cycle } = await tx.query(
    `with recursive ancestors (id) as (
       select $1::uuid
       union
       select tickets.parent_id from tickets join ancestors on tickets.id = ancestors.id where tickets.parent_id is not null
     )
     select 1 from ancestors where id = $2`,
    [parent.id, child.id],
  );
  if (cycle) return;
  const [locked] = await lockTickets(tx, [child.id]);
  if (!locked || locked.parentId !== null) return;
  const at = context.clock.now();
  await writeTicket(context, tx, locked, job.startedBy, { parentId: parent.id }, { at });
  child.parentId = parent.id;
  const self = (await findTicketRef(tx, job.workspaceId, child.id))!;
  await recordChanges(tx, { id: parent.id, workspaceId: job.workspaceId }, job.startedBy, at, [
    { field: "subTicket", from: null, to: self },
  ]);
  context.live.publish(tx, job.workspaceId, { type: "ticket.changed", projectId: job.projectId, ticketId: parent.id });
}

/** Makes one Ticket block another, as the Admin who started the import. Left out where neither is this run's, and where it would form a cycle. */
async function linkBlock(context: Context, tx: Tx, job: ImportRow, blocker: Linkable, blocked: Linkable): Promise<void> {
  if (!blocker.ours && !blocked.ours) return;
  if (blocker.id === blocked.id || (await blocksTransitively(tx, job.workspaceId, blocked.id, blocker.id))) return;
  const { rowCount } = await tx.query(
    `insert into relations (workspace_id, kind, ticket_id, other_ticket_id, created_by, created_at)
     values ($1, 'blocks', $2, $3, $4, $5)
     on conflict (kind, least(ticket_id, other_ticket_id), greatest(ticket_id, other_ticket_id)) do nothing`,
    [job.workspaceId, blocker.id, blocked.id, job.startedBy, context.clock.now()],
  );
  if (!rowCount) return;
  const [from, to] = [await findTicketRef(tx, job.workspaceId, blocker.id), await findTicketRef(tx, job.workspaceId, blocked.id)];
  await recordRelationChanges(context, tx, job.workspaceId, job.startedBy, "blocks", from!, to!, "added");
}

/**
 * Rewrites `#123` in a Ticket's title and description to the key of the Ticket issue 123 of the Repository became, in
 * any run; others stay as written. Part of making the Ticket, so it records no Change.
 */
async function rewriteReferences(context: Context, tx: Tx, job: ImportRow, ticketId: string): Promise<void> {
  const { rows } = await tx.query<{ title: string; description: string }>(
    "select title, description from tickets where id = $1 for update",
    [ticketId],
  );
  const ticket = rows[0]!;
  const numbers = referencedNumbers(`${ticket.title}\n${ticket.description}`);
  if (numbers.length === 0) return;
  const { rows: found } = await tx.query<{ number: number; key: string }>(
    `select tickets.github_issue_number as number, projects.key || '-' || tickets.number as key
     from tickets join projects on projects.id = tickets.project_id
     where tickets.project_id = $1 and tickets.github_repository_id = $2 and tickets.github_issue_number = any($3::integer[])`,
    [job.projectId, job.repositoryId, numbers],
  );
  const keys = new Map(found.map((row) => [row.number, row.key]));
  const keyOf = (number: number) => keys.get(number);
  const title = rewritePlain(ticket.title, keyOf);
  const description = rewriteMarkdown(ticket.description, keyOf);
  if (title === ticket.title && description === ticket.description) return;
  await tx.query("update tickets set title = $2, description = $3 where id = $1", [ticketId, title, description]);
  if (description !== ticket.description) await indexMentions(tx, "ticket", { id: ticketId, workspaceId: job.workspaceId }, description);
  context.live.publish(tx, job.workspaceId, { type: "ticket.changed", projectId: job.projectId, ticketId });
}
