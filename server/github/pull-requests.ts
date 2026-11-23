import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import type { Db, Tx } from "../db.js";
import type { Viewer } from "../identity/viewers.js";
import { checkAfterMerge, checkAfterPush, markerChanged } from "../pipeline/conflicts.js";
import { completeMergedTickets } from "../pipeline/merges.js";
import { queueBackports, ticketsAwaitingBackport } from "../pipeline/backports.js";
import { recordAskedMerge } from "../pipeline/pull-request-merging.js";
import { dropFromQueue, queueDue } from "../pipeline/merge-queue.js";
import { failingCheckOn, sendBackForFailure } from "../pipeline/sending-back.js";
import { findTicketRow, keysWritten, ticketNotFound } from "../work/tickets.js";
import type { EventHandler } from "./webhooks.js";
import { literals } from "../literals.js";

/**
 * Pull Requests in the Repositories Projects list, and the Tickets they link to: those whose
 * key their branch or title contains, in the Projects listing the Pull Request's Repository,
 * and those a User linked by hand. Projects sharing a key there, always of different
 * Workspaces, all get the link. Links by key are only added, as a title or branch comes to name
 * another key, never removed; a User removes only the links they made by hand. Whichever way a
 * Pull Request links, its merge moves the Ticket the same, which Pipeline applies.
 */

export const pullRequestStates = ["open", "draft", "merged", "closed"] as const;
export type PullRequestState = (typeof pullRequestStates)[number];

export const checkStates = ["pending", "passed", "failed", "neutral"] as const;
export type CheckState = (typeof checkStates)[number];

export const Check = Type.Object({
  name: Type.String({ description: "The check run's name, or the commit status's context." }),
  state: literals(
    checkStates,
    {
      description:
        "`pending` until it ends; then `passed`, `failed` (failed, timed out or cancelled, or a commit status's error) or `neutral` (neutral, skipped, stale or waiting for an action).",
    },
  ),
  url: Type.Union([Type.String(), Type.Null()], { description: "Where GitHub shows it, if it says." }),
});
export type Check = Static<typeof Check>;

export const ProducingStep = Type.Object({
  runId: Type.String({ format: "uuid", description: "The Run that was running on the Ticket when the Pull Request opened, by the time GitHub gives for its opening." }),
  statusId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Status whose Step the Run ran, or null if the Status was removed since.",
  }),
  name: Type.String({ description: "The Status's name when the Run started." }),
});
export type ProducingStep = Static<typeof ProducingStep>;

export const SentBack = Type.Union(
  [
    Type.Object({
      kind: Type.Literal("check"),
      name: Type.String({ description: "The failed check run's name, or the commit status's context." }),
      sha: Type.String({ description: "The commit it failed on, then the Pull Request's latest." }),
      url: Type.Union([Type.String(), Type.Null()], { description: "Where GitHub shows it, if it says." }),
      at: Type.String({ format: "date-time" }),
    }),
    Type.Object({
      kind: Type.Literal("review"),
      reviewer: Type.Union([Type.String(), Type.Null()], { description: "The login of the GitHub account that requested changes." }),
      url: Type.Union([Type.String(), Type.Null()], { description: "Where GitHub shows the review, if it says." }),
      at: Type.String({ format: "date-time" }),
    }),
  ],
  {
    description:
      "What last sent this Ticket back to its producing Step from this Pull Request: a failing check on its latest commit, " +
      "or a review requesting changes. A conflict with its base branch sends nothing back; `conflict` marks it instead.",
  },
);
export type SentBack = Static<typeof SentBack>;

export const Conflict = Type.Object(
  {
    branch: Type.String({ description: "The base branch it conflicts with." }),
    sha: Type.String({ description: "The base branch's commit it conflicts with: the merge's commit, or else the one GitHub compared against." }),
    merge: Type.Union(
      [
        Type.Object({
          repository: Type.String({ description: "The merged Pull Request's Repository's `owner/name`." }),
          number: Type.Integer(),
          url: Type.String({ description: "Where GitHub shows the merged Pull Request." }),
        }),
        Type.Null(),
      ],
      { description: "The merge into the base branch that made it conflict, if Cronk knows it; null for none." },
    ),
    at: Type.String({ format: "date-time", description: "When GitHub told Cronk it conflicts so." }),
  },
  {
    description:
      "GitHub's last answer that it conflicts with its base branch. Cronk asks after a merge into that branch and when an " +
      "Outcome moves its Ticket into a Review Status; the marker stays until GitHub answers that it merges cleanly.",
  },
);
export type Conflict = Static<typeof Conflict>;

const reviewStates = ["approved", "changes_requested"] as const;

export const PullRequestReview = Type.Object(
  {
    state: literals(
      reviewStates,
      { description: "`approved` or `changes_requested`." },
    ),
    reviewer: Type.String({ description: "The login of the GitHub account that wrote the review." }),
    url: Type.Union([Type.String(), Type.Null()], { description: "Where GitHub shows the review, if it says." }),
  },
  {
    description:
      "Where its review stands: of each reviewer's latest review, dismissed ones aside, the latest requesting changes, " +
      "or else the latest approval.",
  },
);
export type PullRequestReview = Static<typeof PullRequestReview>;

export const PullRequest = Type.Object({
  id: Type.Integer({ description: "GitHub's id for the Pull Request." }),
  repository: Type.String({ description: "Its Repository's `owner/name` as GitHub last reported it with the Pull Request." }),
  number: Type.Integer(),
  title: Type.String(),
  branch: Type.String({ description: "The branch it proposes to merge." }),
  baseBranch: Type.Union([Type.String(), Type.Null()], {
    description: "The branch it merges into, such as `main` or a release branch; null until GitHub has reported it.",
  }),
  url: Type.String({ description: "Where GitHub shows it." }),
  state: literals(
    pullRequestStates,
    { description: "`open`, `draft` (open but not ready for review), `merged` or `closed` (closed unmerged)." },
  ),
  checks: Type.Array(Check, { description: "The checks on its latest commit, the latest of each by name." }),
  mergedBy: Type.Union([Type.String(), Type.Null()], {
    description: "The login of the GitHub account that merged it, as GitHub reported it; null until merged, or when GitHub named none.",
  }),
  producingStep: Type.Union([ProducingStep, Type.Null()], {
    description:
      "The Step of the Run that was running on this Ticket when GitHub reported the Pull Request opened, or null if none was, as when a User opened it.",
  }),
  reviewState: Type.Union([PullRequestReview, Type.Null()], {
    description: "Null until someone approves it or requests changes, whatever the Ticket's Status and whoever opened it, and again once each such review is dismissed.",
  }),
  sentBack: Type.Union([SentBack, Type.Null()], { description: "Null until a failure on it sends the Ticket back." }),
  conflict: Type.Union([Conflict, Type.Null()], {
    description: "Null unless it is open and GitHub last answered that it conflicts with its base branch.",
  }),
  manual: Type.Boolean({
    description:
      "Whether a User linked it to the Ticket by hand. Its branch or title may name the Ticket's key as well; only a link by hand can be unlinked.",
  }),
});
export type PullRequest = Static<typeof PullRequest>;

/** The Ticket's Pull Requests, oldest link first. */
export async function pullRequestsOf(db: Db | Tx, viewer: Viewer, ticketId: string): Promise<PullRequest[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const { rows } = await db.query<Omit<PullRequest, "id" | "checks" | "sentBack" | "conflict"> & {
    id: string;
    repositoryId: string;
    sha: string;
    sentBack: SentBack | null;
    conflict: Omit<Conflict, "at"> & { at: Date } | null;
  }>(
    `select pull_requests.id, pull_requests.repository_id as "repositoryId", pull_requests.head_sha as sha,
       pull_requests.repository_full_name as repository, pull_requests.number, pull_requests.title,
       pull_requests.branch, pull_requests.base_branch as "baseBranch", pull_requests.url, pull_requests.state,
       pull_requests.merged_by_login as "mergedBy",
       case when runs.id is null then null
         else json_build_object('runId', runs.id, 'statusId', runs.status_id, 'name', runs.status_name) end
         as "producingStep",
       (select json_build_object('state', reviews.state, 'reviewer', reviews.reviewer, 'url', reviews.url)
        from pull_request_reviews reviews
        where reviews.pull_request_id = pull_requests.id and reviews.state <> 'dismissed'
        order by reviews.state = 'changes_requested' desc, reviews.review_id desc limit 1) as "reviewState",
       (select sent_back.failure || jsonb_build_object('at', sent_back.sent_at) from sent_back
        where sent_back.pull_request_id = pull_requests.id and sent_back.ticket_id = pull_request_links.ticket_id
          -- Conflicts sent Tickets back before they only marked the Pull Request; that is history, in the timeline.
          and sent_back.failure->>'kind' <> 'conflict'
        order by sent_back.seq desc limit 1) as "sentBack",
       case when pull_requests.conflict_sha is null or pull_requests.state not in ('open', 'draft') then null
         else json_build_object('branch', pull_requests.conflict_branch, 'sha', pull_requests.conflict_sha,
           'merge', (select json_build_object('repository', merged.repository_full_name, 'number', merged.number,
             'url', merged.url) from pull_requests merged where merged.id = pull_requests.conflict_merged_pull_request_id),
           'at', pull_requests.conflict_at) end as conflict,
       pull_request_links.manual_at is not null as manual
     from pull_request_links
     join pull_requests on pull_requests.id = pull_request_links.pull_request_id
     left join runs on runs.id = pull_request_links.producing_run_id
     where pull_request_links.ticket_id = $1
     order by pull_request_links.linked_at, pull_requests.id`,
    [ticket.id],
  );
  const checks = await checksOf(
    db,
    rows.map((r) => ({ repositoryId: r.repositoryId, sha: r.sha })),
  );
  // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
  return rows.map(({ id, repositoryId, sha, sentBack, conflict, ...row }, i) => ({
    id: Number(id),
    ...row,
    checks: checks[i]!,
    // jsonb carries the time as Postgres writes it; the API writes every time the same way.
    sentBack: sentBack && { ...sentBack, at: new Date(sentBack.at).toISOString() },
    conflict: conflict && { ...conflict, at: new Date(conflict.at).toISOString() },
  }));
}

/** The checks on each of several commits, by name. */
async function checksOf(db: Db | Tx, commits: { repositoryId: string; sha: string }[]): Promise<Check[][]> {
  if (commits.length === 0) return [];
  const { rows } = await db.query<Check & { repositoryId: string; sha: string }>(
    `select repository_id as "repositoryId", sha, name, state, url from commit_checks
     where (repository_id, sha) in (select * from unnest($1::bigint[], $2::text[]))
     order by lower(name), name, kind`,
    [commits.map((c) => c.repositoryId), commits.map((c) => c.sha)],
  );
  return commits.map((c) =>
    rows
      .filter((r) => r.repositoryId === c.repositoryId && r.sha === c.sha)
      .map(({ name, state, url }) => ({ name, state, url })),
  );
}

interface PullRequestPayload {
  id: number;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: { id?: unknown; login?: unknown } | null;
  auto_merge?: unknown;
  html_url: string;
  head: { ref: string; sha: string };
  base?: { ref?: unknown };
  merge_commit_sha?: unknown;
  updated_at: string;
  created_at?: unknown;
}

/** When GitHub says the Pull Request opened, if it says. */
function openedAt(pr: PullRequestPayload): Date | null {
  if (typeof pr.created_at !== "string") return null;
  const at = new Date(pr.created_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

const isPullRequest = (pr: unknown): pr is PullRequestPayload => {
  const p = pr as Partial<PullRequestPayload> | undefined;
  return (
    typeof p?.id === "number" &&
    typeof p.number === "number" &&
    typeof p.title === "string" &&
    typeof p.state === "string" &&
    typeof p.html_url === "string" &&
    typeof p.head?.ref === "string" &&
    typeof p.head.sha === "string" &&
    typeof p.updated_at === "string"
  );
};

function stateOf(pr: PullRequestPayload): PullRequestState {
  if (pr.state === "closed") return pr.merged || pr.merged_at ? "merged" : "closed";
  return pr.draft ? "draft" : "open";
}

/** Whether some Project lists the Repository; Cronk forgets a Repository once none does. */
async function isListed(tx: Tx, repositoryId: number): Promise<boolean> {
  const { rowCount } = await tx.query("select from repositories where id = $1", [repositoryId]);
  return rowCount !== 0;
}

/** Tells each Workspace with a Ticket the Pull Request links to that its Pull Requests changed. */
export async function announce({ live }: Context, tx: Tx, pullRequestIds: number[]): Promise<void> {
  if (pullRequestIds.length === 0) return;
  const { rows } = await tx.query<{ ticketId: string; projectId: string; workspaceId: string }>(
    `select distinct tickets.id as "ticketId", tickets.project_id as "projectId", tickets.workspace_id as "workspaceId"
     from pull_request_links join tickets on tickets.id = pull_request_links.ticket_id
     where pull_request_links.pull_request_id = any($1::bigint[])`,
    [pullRequestIds],
  );
  for (const { ticketId, projectId, workspaceId } of rows) {
    live.publish(tx, workspaceId, { type: "pull_requests.changed", projectId, ticketId });
  }
}

/**
 * GitHub's `pull_request` event. A Pull Request of a Repository some Project lists is kept as
 * the delivery reports it, unless Cronk already knows a newer state, and links to the Tickets
 * its title and branch name now. A delivery of its opening records, for each Ticket it links,
 * the Run that was running on that Ticket when GitHub says the Pull Request opened, even if
 * the delivery arrives after that Run ended: the producing Step's. A check that failed on its latest
 * commit before Cronk heard of the push sends the Tickets back now. GitHub's first delivery naming a merge's commit,
 * whoever made the merge, has Cronk ask whether the other open Pull Requests on its base branch now conflict. A push to
 * one marked as conflicting has Cronk ask about it again; once it merges or closes, its marker goes, and it leaves the
 * Merge Queue.
 */
export const onPullRequestEvent: EventHandler = async (context, tx, { payload }) => {
  const { action, repository, pull_request: pr } = payload as {
    action?: string;
    repository?: { id?: unknown; full_name?: unknown };
    pull_request?: unknown;
  };
  if (typeof repository?.id !== "number" || typeof repository.full_name !== "string" || !isPullRequest(pr)) return;
  if (!(await isListed(tx, repository.id))) return;

  const state = stateOf(pr);
  const mergedBy =
    state === "merged" && typeof pr.merged_by?.id === "number" && typeof pr.merged_by.login === "string"
      ? { id: pr.merged_by.id, login: pr.merged_by.login }
      : null;
  // Whether Cronk knew the Pull Request merged already, so only the delivery of its merge completes Tickets.
  const { rows: before } = await tx.query<{ state: PullRequestState; mergeCommit: string | null; headSha: string; conflicted: boolean }>(
    `select state, merge_commit_sha as "mergeCommit", head_sha as "headSha", conflict_sha is not null as conflicted
     from pull_requests where id = $1 for update`,
    [pr.id],
  );
  const wasMerged = before[0]?.state === "merged";
  // Whether Cronk knew the merge's commit already: only GitHub's deliveries name it, even of a merge a Run asked for.
  const knewMergeCommit = before[0]?.mergeCommit != null;
  // Kept only when no newer delivery came first.
  const { rowCount: newest } = await tx.query(
    `insert into pull_requests (id, repository_id, repository_full_name, number, title, branch, head_sha, state, url,
       merged_by_login, updated_at, base_branch, merge_commit_sha)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (id) do update set repository_id = excluded.repository_id,
       repository_full_name = excluded.repository_full_name, number = excluded.number, title = excluded.title,
       branch = excluded.branch, head_sha = excluded.head_sha, state = excluded.state, url = excluded.url,
       merged_by_login = excluded.merged_by_login, updated_at = excluded.updated_at,
       base_branch = coalesce(excluded.base_branch, pull_requests.base_branch), merge_commit_sha = excluded.merge_commit_sha
     where pull_requests.updated_at <= excluded.updated_at`,
    [pr.id, repository.id, repository.full_name, pr.number, pr.title, pr.head.ref, pr.head.sha, state, pr.html_url,
      mergedBy?.login ?? null, pr.updated_at, typeof pr.base?.ref === "string" ? pr.base.ref : null,
      state === "merged" && typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha : null],
  );

  // Keys named by this delivery link even if it arrived late, since links are only ever added. A key may be
  // written more than once, in different cases, so each Ticket is taken once.
  // Branch names often join words with underscores, which would hide a key from a word boundary.
  const keys = keysWritten(`${pr.title}\n${pr.head.ref}`.replaceAll("_", " "));
  if (keys.length > 0) {
    const opened = action === "opened";
    await tx.query(
      `insert into pull_request_links (pull_request_id, ticket_id, workspace_id, producing_run_id, linked_at, by_key)
       select distinct $1::bigint, tickets.id, tickets.workspace_id,
         case when $4 then (
           select runs.id from runs
           where runs.ticket_id = tickets.id and runs.state <> 'refused'
             and runs.started_at <= $6::timestamptz and (runs.ended_at is null or runs.ended_at > $6::timestamptz)
           order by runs.started_at desc, runs.seq desc limit 1
         ) end,
         $5::timestamptz, true
       from unnest($3::text[]) as written (text)
       join project_repositories on project_repositories.repository_id = $2
       join projects on projects.id = project_repositories.project_id
         and lower(projects.key) = lower(split_part(written.text, '-', 1))
       join tickets on tickets.project_id = projects.id and tickets.number = split_part(written.text, '-', 2)::integer
       on conflict (pull_request_id, ticket_id) do update
         set producing_run_id = coalesce(pull_request_links.producing_run_id, excluded.producing_run_id), by_key = true`,
      [pr.id, repository.id, keys, opened, context.clock.now(), openedAt(pr) ?? context.clock.now()],
    );
  }
  // A check can fail on a pushed commit before GitHub reports the push: once it is the latest commit, it sends back.
  if (newest && (state === "open" || state === "draft")) {
    const failed = await failingCheckOn(tx, repository.id, pr.head.sha);
    if (failed) {
      await sendBackForFailure(context, tx, { id: pr.id, repository: repository.full_name, number: pr.number, url: pr.html_url }, failed);
    }
  }
  if (newest && before[0]?.conflicted) {
    if (state === "open" || state === "draft") {
      // A push may resolve the conflict, and GitHub says nothing when it does, so Cronk asks.
      if (before[0].headSha !== pr.head.sha) await checkAfterPush(context, tx, pr.id);
    } else {
      await tx.query(
        `update pull_requests set conflict_branch = null, conflict_sha = null, conflict_merged_pull_request_id = null,
           conflict_at = null
         where id = $1`,
        [pr.id],
      );
      await markerChanged(context, tx, pr.id);
    }
  }
  // A merge someone asked Cronk for is theirs, even when GitHub's delivery of it comes before GitHub's answer.
  if (newest && state === "merged" && !wasMerged && !(await recordAskedMerge(context, tx, pr.id))) {
    await completeMergedTickets(context, tx, {
      pullRequest: { id: pr.id, repository: repository.full_name, number: pr.number, title: pr.title, url: pr.html_url },
      mergedBy,
      autoMerged: pr.auto_merge !== null && pr.auto_merge !== undefined,
      ...(pr.merged_at && !Number.isNaN(Date.parse(pr.merged_at)) ? { mergedAt: new Date(pr.merged_at) } : {}),
    });
  }
  // A Backport opened, or one whose base branch Cronk now knows, joins its release branch's Merge Queue.
  if (newest && state === "open") await queueBackports(context, tx, await ticketsAwaitingBackport(tx, pr.id));
  // A Pull Request merged or closed on GitHub leaves the Merge Queue; one whose merge completed its Ticket left already.
  if (newest && (state === "merged" || state === "closed")) await dropFromQueue(context, tx, pr.id);
  // GitHub sends nothing when the merge makes another Pull Request conflict, so Cronk asks, once it knows the merge's
  // commit: on GitHub's first delivery naming it, whether Cronk or GitHub's delivery recorded the merge first.
  if (newest && state === "merged" && !knewMergeCommit) await checkAfterMerge(context, tx, pr.id);
  await announce(context, tx, [pr.id]);
};

/** The stages of a check run, in order; a delivery of an earlier stage than Cronk knows changes nothing. */
const checkRunStages: Record<string, number> = { queued: 0, requested: 0, waiting: 0, pending: 0, in_progress: 1, completed: 2 };

/** Whether a completed check run's or check suite's conclusion is a failure. */
const isFailing = (conclusion: unknown) =>
  conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled" || conclusion === "startup_failure";

function checkRunState(status: string, conclusion: unknown): CheckState {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "passed";
  return isFailing(conclusion) ? "failed" : "neutral";
}

const statusStates: Record<string, CheckState> = { pending: "pending", success: "passed", failure: "failed", error: "failed" };

/**
 * Keeps one check of a commit, unless Cronk knows a later one of that name: a newer check run
 * or status by GitHub's id, or a later stage of the same check run. Commits of Repositories no
 * Project lists are ignored. The Pull Requests whose latest commit it is are announced, and a
 * failed check sends the Tickets an open one links back to work. A queued one the Merge Queue acts on at once.
 */
async function recordCheck(
  context: Context,
  tx: Tx,
  check: { repositoryId: number; sha: string; kind: "check_run" | "status"; name: string; sourceId: number; state: CheckState; stage: number; url: string | null },
): Promise<void> {
  if (!(await isListed(tx, check.repositoryId))) return;
  const { rowCount } = await tx.query(
    `insert into commit_checks (repository_id, sha, kind, name, source_id, state, stage, url)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (repository_id, sha, kind, name) do update set source_id = excluded.source_id,
       state = excluded.state, stage = excluded.stage, url = excluded.url
     where commit_checks.source_id < excluded.source_id
       or (commit_checks.source_id = excluded.source_id and commit_checks.stage <= excluded.stage)`,
    [check.repositoryId, check.sha, check.kind, check.name, check.sourceId, check.state, check.stage, check.url],
  );
  if (!rowCount) return;
  const { rows } = await tx.query<{ id: string; repository: string; number: number; url: string; open: boolean }>(
    `select id, repository_full_name as repository, number, url, state in ('open', 'draft') as open
     from pull_requests where repository_id = $1 and head_sha = $2 order by id`,
    [check.repositoryId, check.sha],
  );
  if (check.state === "failed") {
    for (const { id, repository, number, url, open } of rows) {
      if (!open) continue;
      await sendBackForFailure(context, tx, { id: Number(id), repository, number, url }, {
        kind: "check",
        name: check.name,
        sha: check.sha,
        url: check.url,
      });
    }
  }
  await announce(context, tx, rows.map((r) => Number(r.id)));
  await queueDue(context, tx, rows.filter((r) => r.open).map((r) => Number(r.id)));
}

/** GitHub's `check_run` event: a check run on a commit was created, progressed or completed. */
export const onCheckRunEvent: EventHandler = async (context, tx, { payload }) => {
  const { repository, check_run: run } = payload as {
    repository?: { id?: unknown };
    check_run?: { id?: unknown; name?: unknown; head_sha?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown };
  };
  if (typeof repository?.id !== "number") return;
  if (typeof run?.id !== "number" || typeof run.name !== "string" || typeof run.head_sha !== "string") return;
  if (typeof run.status !== "string") return;
  await recordCheck(context, tx, {
    repositoryId: repository.id,
    sha: run.head_sha,
    kind: "check_run",
    name: run.name,
    sourceId: run.id,
    state: checkRunState(run.status, run.conclusion),
    stage: checkRunStages[run.status] ?? 0,
    url: typeof run.html_url === "string" ? run.html_url : null,
  });
};

/** GitHub's `status` event: a commit status was set on a commit. */
export const onStatusEvent: EventHandler = async (context, tx, { payload }) => {
  const { repository, id, sha, context: name, state, target_url: url } = payload as {
    repository?: { id?: unknown };
    id?: unknown;
    sha?: unknown;
    context?: unknown;
    state?: unknown;
    target_url?: unknown;
  };
  if (typeof repository?.id !== "number" || typeof id !== "number" || typeof sha !== "string" || typeof name !== "string") return;
  const checkState = typeof state === "string" ? statusStates[state] : undefined;
  if (!checkState) return;
  await recordCheck(context, tx, {
    repositoryId: repository.id,
    sha,
    kind: "status",
    name,
    sourceId: id,
    state: checkState,
    stage: 0,
    url: typeof url === "string" ? url : null,
  });
};

/**
 * GitHub's `check_suite` event: a check suite on a commit was requested, rerequested or completed. A completed
 * suite is kept, and a rerequested one kept as no longer failing, unless Cronk knows a later delivery about it. One
 * that completed failing sends the Tickets an open Pull Request whose latest commit it is links back to work, as a
 * failing check does, though it ran no failing check run. A queued one the Merge Queue acts on at once.
 */
export const onCheckSuiteEvent: EventHandler = async (context, tx, { payload }) => {
  const { action, repository, check_suite: suite } = payload as {
    action?: unknown;
    repository?: { id?: unknown; html_url?: unknown };
    check_suite?: { id?: unknown; head_sha?: unknown; conclusion?: unknown; app?: { name?: unknown } | null; updated_at?: unknown };
  };
  if ((action !== "completed" && action !== "rerequested") || typeof repository?.id !== "number") return;
  if (typeof suite?.id !== "number" || typeof suite.head_sha !== "string" || typeof suite.updated_at !== "string") return;
  if (!(await isListed(tx, repository.id))) return;
  const name = typeof suite.app?.name === "string" ? suite.app.name : "Check suite";
  const failed = action === "completed" && isFailing(suite.conclusion);
  const url = typeof repository.html_url === "string" ? `${repository.html_url}/commit/${suite.head_sha}/checks` : null;
  const { rowCount } = await tx.query(
    `insert into commit_check_suites (repository_id, sha, id, app_name, failed, url, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (repository_id, sha, id) do update set app_name = excluded.app_name, failed = excluded.failed,
       url = excluded.url, updated_at = excluded.updated_at
     where commit_check_suites.updated_at <= excluded.updated_at`,
    [repository.id, suite.head_sha, suite.id, name, failed, url, suite.updated_at],
  );
  if (!rowCount) return;
  const { rows } = await tx.query<{ id: string; repository: string; number: number; url: string }>(
    `select id, repository_full_name as repository, number, url from pull_requests
     where repository_id = $1 and head_sha = $2 and state in ('open', 'draft') order by id`,
    [repository.id, suite.head_sha],
  );
  await queueDue(context, tx, rows.map((pr) => Number(pr.id)));
  if (!failed) return;
  const sent: number[] = [];
  for (const pr of rows) {
    const failure = { kind: "check", name, sha: suite.head_sha, url } as const;
    if (await sendBackForFailure(context, tx, { ...pr, id: Number(pr.id) }, failure)) sent.push(Number(pr.id));
  }
  await announce(context, tx, sent);
};

/**
 * GitHub's `pull_request_review` event: a review submitted on, or dismissed from, a Pull Request in a
 * Repository some Project lists. Each reviewer's latest approval or request for changes is kept, whatever the
 * Tickets' Statuses and whoever opened the Pull Request, even before Cronk hears of the Pull Request, until a
 * later one replaces it or GitHub dismisses it; reviews that only comment change nothing. A request for changes, whoever wrote it, also sends the Tickets an open Pull Request links
 * back to work. A queued one the Merge Queue acts on at once.
 */
export const onPullRequestReviewEvent: EventHandler = async (context, tx, { payload }) => {
  const { action, repository, review, pull_request: pr } = payload as {
    action?: string;
    repository?: { id?: unknown };
    review?: { id?: unknown; state?: unknown; html_url?: unknown; user?: { login?: unknown } | null };
    pull_request?: { id?: unknown };
  };
  if ((action !== "submitted" && action !== "dismissed") || typeof review?.id !== "number" || typeof pr?.id !== "number") return;
  if (typeof repository?.id !== "number") return;
  if (typeof review.state !== "string") return;
  const state = action === "dismissed" ? "dismissed" : review.state.toLowerCase();
  if (state !== "dismissed" && !(reviewStates as readonly string[]).includes(state)) return;
  if (!(await isListed(tx, repository.id))) return;
  const reviewer = typeof review.user?.login === "string" ? review.user.login : null;
  const url = typeof review.html_url === "string" ? review.html_url : null;
  let changed = false;
  // A review of an account GitHub no longer names has no reviewer to keep it under.
  if (reviewer !== null) {
    // Kept unless a later review is known; a dismissal of the same review wins whichever arrives first.
    const { rowCount } = await tx.query(
      `insert into pull_request_reviews (pull_request_id, reviewer, review_id, state, url) values ($1, $2, $3, $4, $5)
       on conflict (pull_request_id, reviewer) do update set review_id = excluded.review_id, state = excluded.state,
         url = excluded.url
       where pull_request_reviews.review_id < excluded.review_id
         or (pull_request_reviews.review_id = excluded.review_id and excluded.state = 'dismissed'
           and pull_request_reviews.state <> 'dismissed')`,
      [pr.id, reviewer, review.id, state, url],
    );
    changed = rowCount !== 0;
  }
  // Only a Pull Request Cronk knows links Tickets to send back.
  const { rows } = await tx.query<{ repository: string; number: number; url: string; open: boolean }>(
    `select repository_full_name as repository, number, url, state in ('open', 'draft') as open
     from pull_requests where id = $1`,
    [pr.id],
  );
  const known = rows[0];
  if (state === "changes_requested" && known?.open) {
    const sent = await sendBackForFailure(context, tx, { id: pr.id, repository: known.repository, number: known.number, url: known.url }, {
      kind: "review",
      id: review.id,
      reviewer,
      url,
    });
    changed ||= sent;
  }
  if (changed) await announce(context, tx, [pr.id]);
  if (changed && known?.open) await queueDue(context, tx, [pr.id]);
};
