import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { branchHead, createRef, repositoryById } from "../github/client.js";
import { installationCovering, tokenFor } from "../github/installations.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import { userName, type User } from "../identity/user.js";
import { literals } from "../literals.js";
import type { ChangeActor } from "./changes.js";
import { findProject, projectNotFound, requireProjectWrite, type Project } from "./projects.js";
import { lockTickets, writeTicket } from "./ticket-writes.js";

/**
 * Releases: a Project's named sets of Tickets that ship together, such as `v0.3.0`. A Release goes from planned to cut
 * to released. A User with Write cuts a planned Release, and Cronk creates its release branch at the default branch's
 * head in each Repository the Project lists. Only a planned Release is renamed, deleted or has Tickets tagged with it. A Ticket has at most one Release, of its own Project.
 */

export const releaseStates = ["planned", "cut", "released"] as const;
export type ReleaseState = (typeof releaseStates)[number];
export const ReleaseState = literals(releaseStates, {
  description: "`planned` while Tickets are tagged with it; `cut` once its release branches exist; `released` once published.",
});

/** A Release as a Ticket shows it. */
export const TicketRelease = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ description: "A semantic version, such as `v0.3.0`." }),
  state: ReleaseState,
  branch: Type.String({ description: "Its release branch: `release/<name>`." }),
});
export type TicketRelease = Static<typeof TicketRelease>;

/** Selects the Ticket `alias`'s Release as a TicketRelease, or null. */
export const ticketReleaseColumn = (alias: string) =>
  `(select json_build_object('id', releases.id, 'name', releases.name, 'state', releases.state,
     'branch', 'release/' || releases.name) from releases where releases.id = ${alias}.release_id)`;

const ReleaseTicket = Type.Object({
  id: Type.String({ format: "uuid" }),
  key: Type.String(),
  title: Type.String(),
  statusId: Type.String({ format: "uuid" }),
  done: Type.Boolean({ description: "Whether it is in a Done Status." }),
});

export const Release = Type.Object({
  id: Type.String({ format: "uuid" }),
  projectId: Type.String({ format: "uuid" }),
  name: Type.String({ description: "A semantic version, such as `v0.3.0`, unique in its Project ignoring case." }),
  state: ReleaseState,
  branch: Type.String({ description: "Its release branch: `release/<name>`." }),
  createdAt: Type.String({ format: "date-time" }),
  openCount: Type.Integer({ minimum: 0, description: "How many of its Tickets are in a Backlog, Active or Review Status." }),
  doneCount: Type.Integer({ minimum: 0, description: "How many of its Tickets are in a Done Status." }),
  tickets: Type.Array(ReleaseTicket, { description: "Its Tickets, by key." }),
  cutBy: Type.Union([Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }), Type.Null()], {
    description: "The User who cut it; null while planned.",
  }),
  cutAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()], { description: "When it was cut; null while planned." }),
  repositories: Type.Array(
    Type.Object({
      repository: Type.Object({ id: Type.Integer({ description: "GitHub's id for the Repository." }), fullName: Type.String() }),
      commit: Type.String({ description: "The default branch's head its release branch was created at." }),
    }),
    { description: "Each Repository its release branch was cut in, by `owner/name`, with the commit; empty while planned." },
  ),
});
export type Release = Static<typeof Release>;

const ReleaseName = Type.String({
  minLength: 1,
  maxLength: 100,
  description: "A semantic version, such as `v0.3.0` or `1.2.0-rc.1`, with or without a leading `v`.",
});

export const ReleaseCreate = Type.Object({ name: ReleaseName });
export type ReleaseCreate = Static<typeof ReleaseCreate>;
export const ReleaseEdit = Type.Object({ name: ReleaseName });
export type ReleaseEdit = Static<typeof ReleaseEdit>;

// semver.org's grammar, with an optional leading `v`.
const numeric = "(?:0|[1-9]\\d*)";
const identifier = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const semver = new RegExp(
  `^v?${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
);

/** The name, trimmed, if it is a semantic version; refused otherwise. */
export function checkReleaseName(name: string): string {
  const trimmed = name.trim();
  if (!semver.test(trimmed)) {
    throw new ApiError(400, "invalid_release_name", `${trimmed || "An empty name"} isn't a semantic version.`, {
      rule: "A Release is named by a semantic version, such as `v0.3.0` or `1.2.0-rc.1`, with or without a leading `v`.",
      advice: "Name it like `v0.3.0`.",
    });
  }
  return trimmed;
}

const releasesSql = (where: string) => `
  select releases.id, releases.project_id as "projectId", releases.name, releases.state,
    'release/' || releases.name as branch, releases.created_at as "createdAt", releases.cut_at as "cutAt",
    (select json_build_object('id', users.id, 'name', ${userName()}) from users where users.id = releases.cut_by) as "cutBy",
    (select coalesce(json_agg(json_build_object('repository', json_build_object('id', repositories.id,
        'fullName', repositories.full_name), 'commit', release_repositories.cut_sha) order by lower(repositories.full_name)),
      '[]'::json)
     from release_repositories join repositories on repositories.id = release_repositories.repository_id
     where release_repositories.release_id = releases.id) as repositories,
    count(tickets.id) filter (where statuses.kind in ('backlog', 'active', 'review'))::int as "openCount",
    count(tickets.id) filter (where statuses.kind = 'done')::int as "doneCount",
    coalesce(json_agg(json_build_object('id', tickets.id, 'key', projects.key || '-' || tickets.number,
        'title', tickets.title, 'statusId', tickets.status_id, 'done', statuses.kind = 'done')
      order by tickets.number) filter (where tickets.id is not null), '[]'::json) as tickets
  from releases join projects on projects.id = releases.project_id
  left join tickets on tickets.release_id = releases.id
  left join statuses on statuses.id = tickets.status_id
  where ${where}
  group by releases.id, projects.key`;

type ReleaseRow = Omit<Release, "createdAt" | "cutAt"> & { createdAt: Date; cutAt: Date | null };
const toRelease = ({ createdAt, cutAt, ...row }: ReleaseRow): Release => ({
  ...row,
  createdAt: createdAt.toISOString(),
  cutAt: cutAt?.toISOString() ?? null,
});

/** A Project's Releases, by name in version order as far as text sorts it, newest first. */
export async function releasesOf(db: Db, caller: Caller, projectId: string): Promise<Release[]> {
  const project = await findProject(db, caller, projectId);
  if (!project) throw projectNotFound();
  const { rows } = await db.query<ReleaseRow>(
    `${releasesSql("releases.project_id = $1")} order by releases.created_at desc, releases.name`,
    [project.id],
  );
  return rows.map(toRelease);
}

async function readRelease(tx: Tx, releaseId: string): Promise<Release> {
  const { rows } = await tx.query<ReleaseRow>(releasesSql("releases.id = $1"), [releaseId]);
  return toRelease(rows[0]!);
}

/** The Project, locked, for a change to its Releases; refused without Write. */
async function writableProject(tx: Tx, caller: Caller, projectId: string): Promise<Project> {
  const project = await findProject(tx, caller, projectId, { lock: true });
  if (!project) throw projectNotFound();
  requireProjectWrite(project);
  return project;
}

function releaseNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Release in this Project.");
}

/** The Project's Release, locked; only a planned one, for a change only a planned Release takes. */
async function plannedRelease(tx: Tx, project: Project, releaseId: string, doing: string) {
  const { rows } = isUuid(releaseId)
    ? await tx.query<{ id: string; name: string; state: ReleaseState }>(
        "select id, name, state from releases where id = $1 and project_id = $2 for update",
        [releaseId, project.id],
      )
    : { rows: [] };
  const release = rows[0];
  if (!release) throw releaseNotFound();
  if (release.state !== "planned") throw notPlanned(release.name, release.state, doing);
  return release;
}

function notPlanned(name: string, state: ReleaseState, doing: string): ApiError {
  return new ApiError(409, "release_not_planned", `${name} is ${state}, so it can't be ${doing}.`, {
    rule: "Only a planned Release is renamed, deleted, cut or has Tickets tagged with it or untagged from it.",
    advice: "Tag the Ticket with a planned Release, or leave it as it is.",
  });
}

async function checkNameFree(tx: Tx, projectId: string, name: string, exceptId: string | null): Promise<void> {
  const { rows } = await tx.query<{ name: string }>(
    "select name from releases where project_id = $1 and lower(name) = lower($2) and id is distinct from $3",
    [projectId, name, exceptId],
  );
  if (rows[0]) {
    throw new ApiError(409, "release_name_taken", `This Project already has a Release called ${rows[0].name}.`, {
      rule: "A Release's name is unique in its Project, ignoring case.",
      advice: "Pick another name, or tag Tickets with the Release that has it.",
    });
  }
}

export async function createRelease(context: Context, caller: Caller, projectId: string, input: ReleaseCreate): Promise<Release> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const project = await writableProject(tx, caller, projectId);
    const name = checkReleaseName(input.name);
    await checkNameFree(tx, project.id, name, null);
    const { rows } = await tx.query<{ id: string }>(
      "insert into releases (workspace_id, project_id, name, created_at) values ($1, $2, $3, $4) returning id",
      [project.workspaceId, project.id, name, clock.now()],
    );
    live.publish(tx, project.workspaceId, { type: "releases.changed", projectId: project.id });
    return readRelease(tx, rows[0]!.id);
  });
}

/** Renames a planned Release; its Tickets stay tagged with it. */
export async function renameRelease(
  context: Context,
  caller: Caller,
  projectId: string,
  releaseId: string,
  input: ReleaseEdit,
): Promise<Release> {
  const { db, live } = context;
  return transaction(db, async (tx) => {
    const project = await writableProject(tx, caller, projectId);
    const release = await plannedRelease(tx, project, releaseId, "renamed");
    const name = checkReleaseName(input.name);
    await checkNameFree(tx, project.id, name, release.id);
    await tx.query("update releases set name = $2 where id = $1", [release.id, name]);
    live.publish(tx, project.workspaceId, { type: "releases.changed", projectId: project.id });
    return readRelease(tx, release.id);
  });
}

/** Deletes a planned Release, untagging its Tickets, each recording the Change. */
export async function deleteRelease(context: Context, caller: Caller, projectId: string, releaseId: string): Promise<void> {
  const { db, clock, live } = context;
  await transaction(db, async (tx) => {
    const project = await writableProject(tx, caller, projectId);
    const release = await plannedRelease(tx, project, releaseId, "deleted");
    const actor: ChangeActor = caller.kind === "user" ? caller.id : { kind: "agent", id: caller.id, runId: null };
    const { rows } = await tx.query<{ id: string }>("select id from tickets where release_id = $1", [release.id]);
    const now = clock.now();
    for (const ticket of await lockTickets(tx, rows.map((row) => row.id))) {
      await writeTicket(context, tx, ticket, actor, { releaseId: null }, { at: now });
    }
    await tx.query("delete from releases where id = $1", [release.id]);
    live.publish(tx, project.workspaceId, { type: "releases.changed", projectId: project.id });
  });
}

/**
 * The Release a Ticket of the Project is to be tagged with, by name ignoring case: its id, or null to untag. Refused
 * for a name the Project has no Release by, and for a Release that isn't planned; untagging from one that isn't
 * planned is refused too.
 */
export async function releaseToTag(
  tx: Tx,
  projectId: string,
  name: string | null,
  currentReleaseId: string | null,
): Promise<string | null> {
  if (currentReleaseId !== null) {
    const { rows } = await tx.query<{ id: string; name: string; state: ReleaseState }>(
      "select id, name, state from releases where id = $1",
      [currentReleaseId],
    );
    const current = rows[0]!;
    const same = name !== null && current.name.toLowerCase() === name.trim().toLowerCase();
    if (same) return current.id;
    if (current.state !== "planned") throw notPlanned(current.name, current.state, "untagged from its Tickets");
  }
  if (name === null) return null;
  const { rows } = await tx.query<{ id: string; name: string; state: ReleaseState }>(
    "select id, name, state from releases where project_id = $1 and lower(name) = lower($2)",
    [projectId, name.trim()],
  );
  const release = rows[0];
  if (!release) {
    const { rows: known } = await tx.query<{ name: string }>(
      "select name from releases where project_id = $1 and state = 'planned' order by created_at",
      [projectId],
    );
    throw new ApiError(400, "unknown_release", `This Project has no Release called ${name.trim()}.`, {
      rule: "A Ticket is tagged with a Release of its own Project, named as it is, ignoring case.",
      advice:
        known.length > 0
          ? `Use one of its planned Releases: ${known.map((r) => r.name).join(", ")}.`
          : "The Project has no planned Release: ask a User with Write in it to create one.",
    });
  }
  if (release.state !== "planned") throw notPlanned(release.name, release.state, "given more Tickets");
  return release.id;
}

/** A Repository's state, read before a Cut writes anything. */
interface CutPlan {
  id: number;
  fullName: string;
  token: string;
  head: string;
}

/**
 * Cuts a planned Release: creates `release/<name>` at the default branch's head in each Repository the Project lists,
 * as the GitHub App, and records each Repository's cut commit and who cut it and when. Every Repository is read first,
 * so a release branch that already exists anywhere, or a Repository the App can't reach, refuses the whole Cut before
 * any branch is created. A branch that appears between the two passes, or GitHub failing partway, leaves the branches
 * already created and the Release planned; the refusal names them.
 */
export async function cutRelease(context: Context, user: User, projectId: string, releaseId: string): Promise<Release> {
  const { db, clock, live, config } = context;
  return transaction(db, async (tx) => {
    const project = await writableProject(tx, { kind: "user", ...user }, projectId);
    const release = await plannedRelease(tx, project, releaseId, "cut");
    const branch = `release/${release.name}`;
    const { rows: repositories } = await tx.query<{ id: string; fullName: string }>(
      `select repositories.id, repositories.full_name as "fullName" from project_repositories
       join repositories on repositories.id = project_repositories.repository_id
       where project_repositories.project_id = $1 order by lower(repositories.full_name)`,
      [project.id],
    );
    if (repositories.length === 0) {
      throw new ApiError(409, "no_repositories", `${project.key} lists no Repositories, so there is nowhere to cut ${branch}.`, {
        rule: "Cutting a Release creates its release branch in each Repository its Project lists.",
        advice: "Add the Project's Repositories in its settings, then cut the Release.",
      });
    }

    const plans: CutPlan[] = [];
    const existing: string[] = [];
    for (const repository of repositories) {
      const id = Number(repository.id);
      const installationId = await installationCovering(context, id);
      const token = installationId === undefined ? undefined : await tokenFor(context, installationId);
      const onGitHub = token === undefined ? undefined : await repositoryById(config, token, id);
      if (!token || !onGitHub) {
        throw new ApiError(409, "repository_not_installed", `The GitHub App can't reach ${repository.fullName}, so ${release.name} can't be cut.`, {
          rule: "Cronk cuts a release branch in each of the Project's Repositories as the GitHub App, so the App must be installed on every one.",
          advice: `Install the GitHub App on ${repository.fullName}, or remove it from the Project, then cut the Release.`,
        });
      }
      const fullName = onGitHub.full_name;
      const defaultBranch = onGitHub.default_branch ?? "main";
      const head = await branchHead(config, token, fullName, defaultBranch);
      if (!head) {
        throw new ApiError(409, "default_branch_missing", `${fullName} has no ${defaultBranch} branch to cut ${branch} from.`, {
          rule: "A release branch is cut from the head of each Repository's default branch.",
          advice: `Push ${defaultBranch} to ${fullName}, then cut the Release.`,
        });
      }
      if ((await branchHead(config, token, fullName, branch)) !== undefined) existing.push(fullName);
      plans.push({ id, fullName, token, head });
    }
    if (existing.length > 0) {
      throw new ApiError(
        409,
        "release_branch_exists",
        `${branch} already exists in ${existing.join(", ")}, so ${release.name} wasn't cut and no branch was created.`,
        {
          rule: "A Cut creates each release branch itself, so it is refused when one already exists in any Repository.",
          advice: `Delete ${branch} from ${existing.join(", ")}, or rename the Release, then cut it.`,
        },
      );
    }

    const created: string[] = [];
    for (const plan of plans) {
      const answer = await createRef(config, plan.token, plan.fullName, `refs/heads/${branch}`, plan.head).catch((error: unknown) => {
        throw partialCut(branch, created, `GitHub failed creating it in ${plan.fullName}`, error);
      });
      if (!answer.created) {
        throw partialCut(branch, created, `GitHub refused creating it in ${plan.fullName}: ${answer.message || answer.status}`);
      }
      created.push(plan.fullName);
      await tx.query("insert into release_repositories (release_id, repository_id, cut_sha) values ($1, $2, $3)", [
        release.id,
        plan.id,
        plan.head,
      ]);
    }
    await tx.query("update releases set state = 'cut', cut_by = $2, cut_at = $3 where id = $1", [release.id, user.id, clock.now()]);
    live.publish(tx, project.workspaceId, { type: "releases.changed", projectId: project.id });
    return readRelease(tx, release.id);
  });
}

function partialCut(branch: string, created: string[], what: string, cause?: unknown): ApiError {
  const already = created.length > 0 ? ` It was already created in ${created.join(", ")}.` : "";
  const detail = cause instanceof Error ? ` (${cause.message})` : "";
  return new ApiError(502, "release_cut_failed", `${what}${detail}, so the Release stays planned.${already}`, {
    rule: "A Release is cut only once its release branch exists in every Repository of its Project.",
    advice:
      created.length > 0
        ? `Delete ${branch} from ${created.join(", ")}, then cut the Release again.`
        : "Cut the Release again once GitHub answers.",
  });
}
