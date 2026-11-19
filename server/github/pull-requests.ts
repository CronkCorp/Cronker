import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import type { Db, Tx } from "../db.js";
import type { Viewer } from "../identity/viewers.js";
import { completeMergedTickets } from "../pipeline/merges.js";
import { sendBackForFailure } from "../pipeline/sending-back.js";
import { findTicketRow, keysWritten, ticketNotFound } from "../work/tickets.js";
import type { EventHandler } from "./webhooks.js";

/**
 * Pull Requests in the Repositories Projects list, and the Tickets they link to: those whose
 * key their branch or title contains, in the Projects listing the Pull Request's Repository.
 * Projects sharing a key there, always of different Workspaces, all get the link. Links are
 * only added, as a title or branch comes to name another key, never removed. Only a merge moves
 * Tickets, which Pipeline applies.
 */

export const pullRequestStates = ["open", "draft", "merged", "closed"] as const;
export type PullRequestState = (typeof pullRequestStates)[number];

export const checkStates = ["pending", "passed", "failed", "neutral"] as const;
export type CheckState = (typeof checkStates)[number];

export const Check = Type.Object({
  name: Type.String({ description: "The check run's name, or the commit status's context." }),
  state: Type.Union(
    checkStates.map((s) => Type.Literal(s)),
    {
      description:
        "`pending` until it ends; then `passed`, `failed` (failed, timed out or cancelled, or a commit status's error) or `neutral` (neutral, skipped, stale or waiting for an action).",
    },
  ),
  url: Type.Union([Type.String(), Type.Null()], { description: "Where GitHub shows it, if it says." }),
});
export type Check = Static<typeof Check>;

export const ProducingStep = Type.Object({
  runId: Type.String({ format: "uuid", description: "The Run that was running on the Ticket when GitHub reported the Pull Request opened." }),
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
      "or a review requesting changes.",
  },
);
export type SentBack = Static<typeof SentBack>;

export const reviewStates = ["approved", "changes_requested"] as const;
export type ReviewState = (typeof reviewStates)[number];

export const PullRequestReview = Type.Object(
  {
    state: Type.Union(
      reviewStates.map((s) => Type.Literal(s)),
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
  url: Type.String({ description: "Where GitHub shows it." }),
  state: Type.Union(
    pullRequestStates.map((s) => Type.Literal(s)),
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
});
export type PullRequest = Static<typeof PullRequest>;

/** The Ticket's Pull Requests, oldest link first. */
export async function pullRequestsOf(db: Db, viewer: Viewer, ticketId: string): Promise<PullRequest[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const { rows } = await db.query<Omit<PullRequest, "id" | "checks" | "sentBack"> & {
    id: string;
    repositoryId: string;
    sha: string;
    sentBack: SentBack | null;
  }>(
    `select pull_requests.id, pull_requests.repository_id as "repositoryId", pull_requests.head_sha as sha,
       pull_requests.repository_full_name as repository, pull_requests.number, pull_requests.title,
       pull_requests.branch, pull_requests.url, pull_requests.state, pull_requests.merged_by_login as "mergedBy",
       case when runs.id is null then null
         else json_build_object('runId', runs.id, 'statusId', runs.status_id, 'name', runs.status_name) end
         as "producingStep",
       (select json_build_object('state', reviews.state, 'reviewer', reviews.reviewer, 'url', reviews.url)
        from pull_request_reviews reviews
        where reviews.pull_request_id = pull_requests.id and reviews.state <> 'dismissed'
        order by reviews.state = 'changes_requested' desc, reviews.review_id desc limit 1) as "reviewState",
       (select sent_back.failure || jsonb_build_object('at', sent_back.sent_at) from sent_back
        where sent_back.pull_request_id = pull_requests.id and sent_back.ticket_id = pull_request_links.ticket_id
        order by sent_back.seq desc limit 1) as "sentBack"
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
  return rows.map(({ id, repositoryId, sha, sentBack, ...row }, i) => ({
    id: Number(id),
    ...row,
    checks: checks[i]!,
    // jsonb carries the time as Postgres writes it; the API writes every time the same way.
    sentBack: sentBack && { ...sentBack, at: new Date(sentBack.at).toISOString() },
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
  updated_at: string;
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
async function announce({ live }: Context, tx: Tx, pullRequestIds: number[]): Promise<void> {
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
 * the Run running on that Ticket then: the producing Step's. A check that failed on its latest
 * commit before Cronk heard of the push sends the Tickets back now.
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
  const { rows: before } = await tx.query<{ state: PullRequestState }>("select state from pull_requests where id = $1 for update", [
    pr.id,
  ]);
  const wasMerged = before[0]?.state === "merged";
  // Kept only when no newer delivery came first.
  const { rowCount: newest } = await tx.query(
    `insert into pull_requests (id, repository_id, repository_full_name, number, title, branch, head_sha, state, url,
       merged_by_login, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (id) do update set repository_id = excluded.repository_id,
       repository_full_name = excluded.repository_full_name, number = excluded.number, title = excluded.title,
       branch = excluded.branch, head_sha = excluded.head_sha, state = excluded.state, url = excluded.url,
       merged_by_login = excluded.merged_by_login, updated_at = excluded.updated_at
     where pull_requests.updated_at <= excluded.updated_at`,
    [pr.id, repository.id, repository.full_name, pr.number, pr.title, pr.head.ref, pr.head.sha, state, pr.html_url,
      mergedBy?.login ?? null, pr.updated_at],
  );

  // Keys named by this delivery link even if it arrived late, since links are only ever added. A key may be
  // written more than once, in different cases, so each Ticket is taken once.
  // Branch names often join words with underscores, which would hide a key from a word boundary.
  const keys = keysWritten(`${pr.title}\n${pr.head.ref}`.replaceAll("_", " "));
  if (keys.length > 0) {
    const opened = action === "opened";
    await tx.query(
      `insert into pull_request_links (pull_request_id, ticket_id, workspace_id, producing_run_id, linked_at)
       select distinct $1::bigint, tickets.id, tickets.workspace_id,
         case when $4 then (select runs.id from runs where runs.ticket_id = tickets.id and runs.state = 'running') end,
         $5::timestamptz
       from unnest($3::text[]) as written (text)
       join project_repositories on project_repositories.repository_id = $2
       join projects on projects.id = project_repositories.project_id
         and lower(projects.key) = lower(split_part(written.text, '-', 1))
       join tickets on tickets.project_id = projects.id and tickets.number = split_part(written.text, '-', 2)::integer
       on conflict (pull_request_id, ticket_id) do update
         set producing_run_id = coalesce(pull_request_links.producing_run_id, excluded.producing_run_id)`,
      [pr.id, repository.id, keys, opened, context.clock.now()],
    );
  }
  // A check can fail on a pushed commit before GitHub reports the push: once it is the latest commit, it sends back.
  if (newest && (state === "open" || state === "draft")) {
    const { rows: failed } = await tx.query<{ name: string; url: string | null }>(
      `select name, url from commit_checks where repository_id = $1 and sha = $2 and state = 'failed'
       order by source_id limit 1`,
      [repository.id, pr.head.sha],
    );
    if (failed[0]) {
      await sendBackForFailure(context, tx, { id: pr.id, repository: repository.full_name, number: pr.number, url: pr.html_url }, {
        kind: "check",
        sha: pr.head.sha,
        ...failed[0],
      });
    }
  }
  if (newest && state === "merged" && !wasMerged) {
    await completeMergedTickets(context, tx, {
      pullRequest: { id: pr.id, repository: repository.full_name, number: pr.number, title: pr.title, url: pr.html_url },
      mergedBy,
      autoMerged: pr.auto_merge !== null && pr.auto_merge !== undefined,
    });
  }
  await announce(context, tx, [pr.id]);
};

/** The stages of a check run, in order; a delivery of an earlier stage than Cronk knows changes nothing. */
const checkRunStages: Record<string, number> = { queued: 0, requested: 0, waiting: 0, pending: 0, in_progress: 1, completed: 2 };

function checkRunState(status: string, conclusion: unknown): CheckState {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "passed";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled" || conclusion === "startup_failure") {
    return "failed";
  }
  return "neutral";
}

const statusStates: Record<string, CheckState> = { pending: "pending", success: "passed", failure: "failed", error: "failed" };

/**
 * Keeps one check of a commit, unless Cronk knows a later one of that name: a newer check run
 * or status by GitHub's id, or a later stage of the same check run. Commits of Repositories no
 * Project lists are ignored. The Pull Requests whose latest commit it is are announced, and a
 * failed check sends the Tickets an open one links back to work.
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
 * GitHub's `pull_request_review` event: a review submitted on, or dismissed from, a Pull Request Cronk knows.
 * Each reviewer's latest approval or request for changes is kept, whatever the Tickets' Statuses and whoever
 * opened the Pull Request, until a later one replaces it or GitHub dismisses it; reviews that only comment
 * change nothing. A request for changes, whoever wrote it, also sends the Tickets an open Pull Request links
 * back to work.
 */
export const onPullRequestReviewEvent: EventHandler = async (context, tx, { payload }) => {
  const { action, review, pull_request: pr } = payload as {
    action?: string;
    review?: { id?: unknown; state?: unknown; html_url?: unknown; user?: { login?: unknown } | null };
    pull_request?: { id?: unknown };
  };
  if ((action !== "submitted" && action !== "dismissed") || typeof review?.id !== "number" || typeof pr?.id !== "number") return;
  if (typeof review.state !== "string") return;
  const state = action === "dismissed" ? "dismissed" : review.state.toLowerCase();
  if (state !== "approved" && state !== "changes_requested" && state !== "dismissed") return;
  const { rows } = await tx.query<{ repository: string; number: number; url: string; open: boolean }>(
    `select repository_full_name as repository, number, url, state in ('open', 'draft') as open
     from pull_requests where id = $1`,
    [pr.id],
  );
  const known = rows[0];
  if (!known) return;
  const reviewer = typeof review.user?.login === "string" ? review.user.login : null;
  const url = typeof review.html_url === "string" ? review.html_url : null;
  // A review of an account GitHub no longer names has no reviewer to keep it under.
  if (reviewer !== null) {
    // Kept unless a later review is known; a dismissal of the same review wins whichever arrives first.
    await tx.query(
      `insert into pull_request_reviews (pull_request_id, reviewer, review_id, state, url) values ($1, $2, $3, $4, $5)
       on conflict (pull_request_id, reviewer) do update set review_id = excluded.review_id, state = excluded.state,
         url = excluded.url
       where pull_request_reviews.review_id < excluded.review_id
         or (pull_request_reviews.review_id = excluded.review_id and excluded.state = 'dismissed')`,
      [pr.id, reviewer, review.id, state, url],
    );
  }
  if (state === "changes_requested" && known.open) {
    await sendBackForFailure(context, tx, { id: pr.id, repository: known.repository, number: known.number, url: known.url }, {
      kind: "review",
      id: review.id,
      reviewer,
      url,
    });
  }
  await announce(context, tx, [pr.id]);
};
