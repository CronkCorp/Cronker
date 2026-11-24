import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { repositoryUrl, tokenRotationMarginMs, withFreshTokens } from "../github/repository-tokens.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import { mcpResource } from "../oauth/authorizations.js";
import type { Brief } from "../runs/brief.js";
import { runReports } from "../runs/runs.js";
import { sessionIdOf } from "../runs/session-ids.js";
import { convertClaudeCode } from "../transcripts/claude-code.js";
import { uploadTranscript, type Transcript } from "../transcripts/transcripts.js";
import { modelIdOf, type ModelId } from "../workspaces/workspaces.js";
import type { MachineSelf } from "./machines.js";

/**
 * The daemon protocol for Runs of `local` Runners (ADR 0014). A Run of a `local` Runner starts *claimable*: running in
 * Cronk, counted against its Runner's limit, but held by no Machine yet. A Machine serving its Runner claims it, at
 * most once and within the Machine's own limit, receiving what it needs to run `claude`; it then reports the session
 * id, heartbeats while the process runs, and reports the process's end.
 */

/** A claimable Run, as the Machine's event stream announces it. */
export async function claimableRuns(context: Context, machine: MachineSelf): Promise<string[]> {
  const { rows } = await context.db.query<{ id: string }>(
    `select runs.id from runs
     where runs.state = 'running' and runs.runner_id = any($1::uuid[])
       and not exists (select 1 from local_runs where local_runs.run_id = runs.id)
     order by runs.started_at, runs.id`,
    [machine.runners.map((r) => r.id)],
  );
  return rows.map((r) => r.id);
}

export const RepositoryToken = Type.Object({
  fullName: Type.String({ description: "The Repository, as `owner/name`." }),
  token: Type.String({ description: "A fresh installation token of Cronk's GitHub App covering the Repository, to fetch and push with." }),
  expiresAt: Type.String({ format: "date-time", description: "When the token expires; a heartbeat gives a fresh one before then." }),
});
export type RepositoryToken = Static<typeof RepositoryToken>;

export const ClaimedRepository = Type.Intersect([
  RepositoryToken,
  Type.Object({
    cloneUrl: Type.String({ format: "uri", description: "Where the Repository is cloned from and pushed to." }),
    startBranch: Type.Union([Type.String(), Type.Null()], {
      description:
        "The Ticket's branch: the branch of its open Pull Request in the Repository, most recently updated first. The " +
        "Run's worktree starts on it if the remote has it, or else off the Repository's default branch, as with null.",
    }),
  }),
]);
export type ClaimedRepository = Static<typeof ClaimedRepository>;

export const ClaimedRun = Type.Object({
  runId: Type.String({ format: "uuid" }),
  ticketKey: Type.String({ description: "The Run's Ticket, such as `CRONK-12`." }),
  brief: Type.String({ description: "The Run's Brief, as `claude -p` is given it." }),
  modelId: Type.String({ description: "The model id the Step's label stands for in the Workspace, for `claude --model`." }),
  token: Type.String({ description: "An Agent token of the Run's Agent, minted for this Run and revoked once it ends." }),
  mcpUrl: Type.String({ format: "uri", description: "Cronk's MCP server, which the Run reaches with the token." }),
  repositories: Type.Array(ClaimedRepository, { description: "The Project's Repositories, which the Run works in." }),
  allowedTools: Type.Array(Type.String(), {
    description:
      "The Runner's allowlist as it stood at the claim: the tools the Run may use without asking, for `claude " +
      "--allowedTools` with `--permission-mode acceptEdits`.",
  }),
});
export type ClaimedRun = Static<typeof ClaimedRun>;

const noSuchRun = () => new ApiError(404, "not_found", "No such Run waits for this Machine.");

/**
 * Claims a Run for the Machine. Granted once: a Run claimed already, by this Machine or another, or no longer running
 * is refused with `run_not_claimable`. A Run of a Runner the Machine doesn't serve answers as not found. A Machine
 * already running as many Runs as its limit is refused with `machine_limit_reached`, and a Run whose Runner has as
 * many claimed Runs as its limit with `runner_limit_reached`.
 */
export async function claimRun(context: Context, machine: MachineSelf, runId: string): Promise<ClaimedRun> {
  if (!isUuid(runId)) throw noSuchRun();
  const result = await transaction(context.db, async (tx) => {
    const now = context.clock.now();
    // The Machine first, then the Run: two claims by one Machine at once count each other.
    const { rows: machines } = await tx.query<{ limit: number }>(
      "select run_limit as limit from machines where id = $1 and revoked_at is null for update",
      [machine.id],
    );
    if (!machines[0]) throw noSuchRun();
    const { rows } = await tx.query<{
      state: string;
      workspaceId: string;
      modelIds: ModelId[];
      agentId: string;
      model: string;
      brief: Brief;
      ticketKey: string;
      ticketId: string;
      projectId: string;
      allowedTools: string[] | null;
    }>(
      `select runs.state, runners.allowed_tools as "allowedTools", runs.workspace_id as "workspaceId", workspaces.model_ids as "modelIds", runs.agent_id as "agentId", runs.model, runs.brief,
         projects.key || '-' || tickets.number as "ticketKey", tickets.id as "ticketId", tickets.project_id as "projectId"
       from runs join tickets on tickets.id = runs.ticket_id join projects on projects.id = tickets.project_id
         join workspaces on workspaces.id = runs.workspace_id join runners on runners.id = runs.runner_id
       where runs.id = $1 and runs.runner_id = any($2::uuid[])
       for update of runs`,
      [runId, machine.runners.map((r) => r.id)],
    );
    const run = rows[0];
    if (!run) throw noSuchRun();
    // Read once the Run is locked, so a claim that won meanwhile is seen.
    const { rowCount: claimed } = await tx.query("select 1 from local_runs where run_id = $1", [runId]);
    if (run.state !== "running" || claimed) {
      throw new ApiError(409, "run_not_claimable", "This Run was claimed already, or is no longer running.");
    }
    const { rows: held } = await tx.query<{ count: string }>(
      `select count(*) from local_runs join runs on runs.id = local_runs.run_id
       where local_runs.machine_id = $1 and runs.state = 'running'`,
      [machine.id],
    );
    if (Number(held[0]!.count) >= machines[0].limit) {
      throw new ApiError(409, "machine_limit_reached", `This Machine already runs ${machines[0].limit} Runs, its limit.`);
    }
    // A Run waiting to be claimed already counts against its Runner's limit, so this holds only once the limit was
    // lowered below its running Runs: those claimed run on, and the rest wait for them to end.
    const { rows: runner } = await tx.query<{ limit: number; claimed: string }>(
      `select runners.run_limit as limit, (select count(*) from local_runs join runs claimed on claimed.id = local_runs.run_id
         where claimed.runner_id = runners.id and claimed.state = 'running') as claimed
       from runs join runners on runners.id = runs.runner_id where runs.id = $1`,
      [runId],
    );
    if (runner[0] && Number(runner[0].claimed) >= runner[0].limit) {
      throw new ApiError(409, "runner_limit_reached", `This Run's Runner already runs ${runner[0].limit} Runs, its limit.`);
    }
    const modelId = modelIdOf(run, run.model.trim());
    if (!modelId) return { unmapped: run.model, claimed: null, repositories: [] };
    const token = issueSecret("agent");
    const { rows: tokens } = await tx.query<{ id: string }>(
      `insert into agent_tokens (agent_id, name, access, token_hash, created_at) values ($1, $2, 'write', $3, $4) returning id`,
      [run.agentId, `Run on ${run.ticketKey}`, hashSecret(token), now],
    );
    await tx.query("insert into local_runs (run_id, machine_id, token_id, claimed_at) values ($1, $2, $3, $4)", [
      runId,
      machine.id,
      tokens[0]!.id,
      now,
    ]);
    // Claimed is as good as a call: the Run's clock towards lost starts now.
    await tx.query("update runs set last_call_at = $2 where id = $1", [runId, now]);
    return {
      unmapped: null,
      claimed: {
        runId,
        ticketKey: run.ticketKey,
        brief: run.brief.text,
        modelId,
        token,
        mcpUrl: mcpResource(context),
        allowedTools: run.allowedTools ?? [],
      },
      repositories: await repositoriesOf(tx, run.projectId, run.ticketId),
    };
  });
  if (result.claimed) {
    // Asked of GitHub once the claim is recorded, holding no locks meanwhile.
    let repositories;
    try {
      repositories = await withFreshTokens(context, result.repositories);
    } catch (error) {
      const reason = `Cronk couldn't get GitHub tokens for the Run's Repositories. ${(error as Error).message}`;
      await runReports(context).endedWithoutFinishing(runId, reason);
      throw new ApiError(409, "repositories_unavailable", reason);
    }
    if (repositories.length > 0) {
      await context.db.query("update local_runs set tokens_expire_at = $2 where run_id = $1", [runId, earliest(repositories)]);
    }
    return {
      ...result.claimed,
      repositories: repositories.map((r, i) => ({
        fullName: r.fullName,
        cloneUrl: repositoryUrl(context, r.fullName),
        startBranch: result.repositories[i]!.startBranch,
        token: r.token,
        expiresAt: r.expiresAt.toISOString(),
      })),
    } satisfies ClaimedRun;
  }
  // The label lost its model id after the Run started: the Run can't run, so it fails, saying why.
  const reason =
    `The Workspace has no model id for the label ${result.unmapped}, so the Machine can't tell Claude Code which model ` +
    "to run: an Admin sets one in the Workspace's settings, then Retry.";
  await runReports(context).endedWithoutFinishing(runId, reason);
  throw new ApiError(409, "no_model_id", reason);
}

type Queryable = Pick<Context["db"], "query">;

/**
 * The Repositories of the Project, each with the Ticket's branch in it: the branch of its open Pull Request there, the
 * most recently updated if it has several.
 */
async function repositoriesOf(db: Queryable, projectId: string, ticketId: string) {
  const { rows } = await db.query<{ id: string; fullName: string; startBranch: string | null }>(
    `select repositories.id, repositories.full_name as "fullName",
       (select pull_requests.branch from pull_request_links join pull_requests on pull_requests.id = pull_request_links.pull_request_id
        where pull_request_links.ticket_id = $2 and pull_requests.repository_id = repositories.id
          and pull_requests.state in ('open', 'draft')
        order by pull_requests.updated_at desc, pull_requests.id desc limit 1) as "startBranch"
     from project_repositories join repositories on repositories.id = project_repositories.repository_id
     where project_repositories.project_id = $1
     order by lower(repositories.full_name), repositories.id`,
    [projectId, ticketId],
  );
  return rows.map((r) => ({ id: Number(r.id), fullName: r.fullName, startBranch: r.startBranch }));
}

const earliest = (tokens: { expiresAt: Date }[]) => new Date(Math.min(...tokens.map((t) => t.expiresAt.getTime())));

/** A Run this Machine claimed, and whether it still runs. */
async function heldRun(context: Context, machine: MachineSelf, runId: string): Promise<{ running: boolean }> {
  if (!isUuid(runId)) throw noSuchRun();
  const { rows } = await context.db.query<{ running: boolean }>(
    `select runs.state = 'running' as running from local_runs join runs on runs.id = local_runs.run_id
     where local_runs.run_id = $1 and local_runs.machine_id = $2`,
    [runId, machine.id],
  );
  if (!rows[0]) throw noSuchRun();
  return rows[0];
}

const runStopped = () =>
  new ApiError(409, "run_stopped", "This Run is no longer running in Cronk: stop its process and let go of what it holds.");

export const HeartbeatAnswer = Type.Object({
  repositories: Type.Array(RepositoryToken, {
    description: "Fresh GitHub tokens for the Run's Repositories once theirs expire within ten minutes; none before then.",
  }),
});
export type HeartbeatAnswer = Static<typeof HeartbeatAnswer>;

/**
 * Records a heartbeat of a Run the Machine holds, counted as a call naming the Run, so a working Run isn't lost, and
 * answers fresh GitHub tokens for its Repositories once theirs near their expiry. A Run no longer running is refused
 * with `run_stopped`, telling the daemon to kill its process.
 */
export async function heartbeat(context: Context, machine: MachineSelf, runId: string): Promise<HeartbeatAnswer> {
  const { running } = await heldRun(context, machine, runId);
  if (!running) throw runStopped();
  const now = context.clock.now();
  const { rows } = await context.db.query<{ projectId: string; ticketId: string; tokensExpireAt: Date | null }>(
    `update runs set last_call_at = $2 from tickets, local_runs
     where runs.id = $1 and runs.state = 'running' and tickets.id = runs.ticket_id and local_runs.run_id = runs.id
     returning tickets.project_id as "projectId", tickets.id as "ticketId", local_runs.tokens_expire_at as "tokensExpireAt"`,
    [runId, now],
  );
  const run = rows[0];
  if (!run) throw runStopped();
  if (!run.tokensExpireAt || run.tokensExpireAt.getTime() > now.getTime() + tokenRotationMarginMs) return { repositories: [] };
  let repositories;
  try {
    repositories = await withFreshTokens(context, await repositoriesOf(context.db, run.projectId, run.ticketId));
  } catch {
    // GitHub can't be asked now, or the App lost a Repository: the tokens the Run holds still work, so the next
    // heartbeat asks again.
    return { repositories: [] };
  }
  if (repositories.length === 0) return { repositories: [] };
  await context.db.query("update local_runs set tokens_expire_at = $2 where run_id = $1", [runId, earliest(repositories)]);
  return { repositories: repositories.map((r) => ({ fullName: r.fullName, token: r.token, expiresAt: r.expiresAt.toISOString() })) };
}

export const LocalSession = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 200, description: "Claude Code's session id, from its stream's `system` `init` message." }),
});
export type LocalSession = Static<typeof LocalSession>;

/** Records the Claude Code session of a Run the Machine holds as its session reference. */
export async function reportSession(context: Context, machine: MachineSelf, runId: string, sessionId: string): Promise<void> {
  const { running } = await heldRun(context, machine, runId);
  if (!running) throw runStopped();
  await context.db.query("update runs set session_id = $2, last_call_at = $3 where id = $1 and state = 'running'", [
    runId,
    sessionIdOf(sessionId.trim()),
    context.clock.now(),
  ]);
}

export const LocalRunEnd = Type.Object({
  reason: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: "How the `claude` process ended, such as `claude exited with code 1`.",
  }),
  deniedTools: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 20,
      description:
        "The tool calls Claude Code denied because they were outside the Runner's allowlist, such as `Bash(npm publish)`, " +
        "from its `result` message's `permission_denials`.",
    }),
  ),
  costUsd: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1_000_000,
      description:
        "What Claude Code's stream reported the session cost (`total_cost_usd` of its `result` message), in US dollars. " +
        "Recorded as the Run's estimated cost: on a subscription login it is a figure at list prices, not money spent. " +
        "Left out when the process ended without reporting one.",
    }),
  ),
});
export type LocalRunEnd = Static<typeof LocalRunEnd>;

export const LocalRunEnded = Type.Object({
  mayComeBack: Type.Boolean({
    description:
      "Whether the Run is lost and its Ticket hasn't moved on, so it may yet come back: the daemon keeps its worktree " +
      "and reports its end again later, removing the worktree once this is false.",
  }),
});
export type LocalRunEnded = Static<typeof LocalRunEnded>;

/**
 * Reports that the `claude` process of a Run the Machine holds ended. A Run its agent didn't finish fails with the
 * reason, naming any tools outside its Runner's allowlist it was denied; one that ended already, as `finish` ends it,
 * is left as it is. A cost given is recorded as the Run's estimated cost, whichever way it ended. Answers whether the
 * Run may yet come back.
 */
export async function reportEnd(context: Context, machine: MachineSelf, runId: string, end: LocalRunEnd): Promise<LocalRunEnded> {
  const { running } = await heldRun(context, machine, runId);
  const reports = runReports(context);
  if (running) {
    let reason = `The session ended without calling \`finish\`: ${end.reason.trim()}`;
    const denied = [...new Set((end.deniedTools ?? []).map((tool) => tool.trim()).filter(Boolean))];
    if (denied.length) {
      reason += `. It needed ${denied.length === 1 ? "a tool" : "tools"} outside the Runner's allowlist: ${denied.join(", ")}; widen the allowlist and Retry.`;
    }
    await reports.endedWithoutFinishing(runId, reason);
  }
  if (end.costUsd !== undefined) await reports.cost(runId, { amount: Math.round(end.costUsd * 100), currency: "USD", estimate: true });
  if (running) return { mayComeBack: false };
  const { rowCount } = await context.db.query(
    `select 1 from runs join tickets on tickets.id = runs.ticket_id
     where runs.id = $1 and runs.state = 'lost' and tickets.status_id = runs.status_id and tickets.delegate_id = runs.agent_id`,
    [runId],
  );
  return { mayComeBack: Boolean(rowCount) };
}

/**
 * Stores the Claude Code transcript of a Run the Machine holds, its JSONL file as it is, as the Transcript of the
 * Run's session, by the Run's Agent, replacing what Cronk held, as the Transcript hook's upload does. It works after
 * the Run ended, when the Run's own token is revoked, so the daemon's last upload is complete. A Run with no session
 * reported yet is refused with `no_session`.
 */
export async function uploadRunTranscript(
  context: Context,
  machine: MachineSelf,
  runId: string,
  jsonl: string,
): Promise<{ transcript: Transcript; created: boolean }> {
  await heldRun(context, machine, runId);
  const { rows } = await context.db.query<{ agentId: string; workspaceId: string; sessionId: string | null }>(
    `select agent_id as "agentId", workspace_id as "workspaceId", session_id as "sessionId" from runs where id = $1`,
    [runId],
  );
  const run = rows[0];
  if (!run) throw noSuchRun();
  if (!run.sessionId) throw new ApiError(409, "no_session", "This Run has no Claude Code session yet: report its session first.");
  return uploadTranscript(context, { id: run.agentId, workspace: { id: run.workspaceId } }, run.sessionId, convertClaudeCode(jsonl));
}
