import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import { mcpResource } from "../oauth/authorizations.js";
import type { Brief } from "../runs/brief.js";
import { revokeLocalRunToken } from "../runs/local.js";
import { reviveLostRun, runReports } from "../runs/runs.js";
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

export const ClaimedRun = Type.Object({
  runId: Type.String({ format: "uuid" }),
  ticketKey: Type.String({ description: "The Run's Ticket, such as `CRONK-12`." }),
  brief: Type.String({ description: "The Run's Brief, as `claude -p` is given it." }),
  modelId: Type.String({ description: "The model id the Step's label stands for in the Workspace, for `claude --model`." }),
  token: Type.String({ description: "An Agent token of the Run's Agent, minted for this Run and revoked once it ends." }),
  mcpUrl: Type.String({ format: "uri", description: "Cronk's MCP server, which the Run reaches with the token." }),
});
export type ClaimedRun = Static<typeof ClaimedRun>;

const noSuchRun = () => new ApiError(404, "not_found", "No such Run waits for this Machine.");

/**
 * Claims a Run for the Machine. Granted once: a Run claimed already, by this Machine or another, or no longer running
 * is refused with `run_not_claimable`. A Run of a Runner the Machine doesn't serve answers as not found. A Machine
 * already running as many Runs as its limit is refused with `machine_limit_reached`.
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
    }>(
      `select runs.state, runs.workspace_id as "workspaceId", workspaces.model_ids as "modelIds", runs.agent_id as "agentId", runs.model, runs.brief,
         projects.key || '-' || tickets.number as "ticketKey"
       from runs join tickets on tickets.id = runs.ticket_id join projects on projects.id = tickets.project_id
         join workspaces on workspaces.id = runs.workspace_id
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
    const modelId = modelIdOf(run, run.model.trim());
    if (!modelId) return { unmapped: run.model, claimed: null };
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
      claimed: { runId, ticketKey: run.ticketKey, brief: run.brief.text, modelId, token, mcpUrl: mcpResource(context) } satisfies ClaimedRun,
    };
  });
  if (result.claimed) return result.claimed;
  // The label lost its model id after the Run started: the Run can't run, so it fails, saying why.
  const reason =
    `The Workspace has no model id for the label ${result.unmapped}, so the Machine can't tell Claude Code which model ` +
    "to run: an Admin sets one in the Workspace's settings, then Retry.";
  await runReports(context).endedWithoutFinishing(runId, reason);
  throw new ApiError(409, "no_model_id", reason);
}

/**
 * The Runs this Machine holds that were stopped, or otherwise ended, in Cronk and whose stop it hasn't confirmed: its
 * event stream tells them again on connecting, so a Machine that was offline, or asleep, at the stop still kills them.
 */
export async function stopsToReplay(context: Context, machine: MachineSelf): Promise<string[]> {
  const { rows } = await context.db.query<{ id: string }>(
    `select runs.id from local_runs join runs on runs.id = local_runs.run_id
     where local_runs.machine_id = $1 and local_runs.stop_acked_at is null and runs.state not in ('running', 'lost')
     order by local_runs.claimed_at, runs.id`,
    [machine.id],
  );
  return rows.map((r) => r.id);
}

/** A Run this Machine claimed, and its state. */
async function heldRun(context: Context, machine: MachineSelf, runId: string): Promise<{ state: string; agentId: string; workspaceId: string }> {
  if (!isUuid(runId)) throw noSuchRun();
  const { rows } = await context.db.query<{ state: string; agentId: string; workspaceId: string }>(
    `select runs.state, runs.agent_id as "agentId", runs.workspace_id as "workspaceId"
     from local_runs join runs on runs.id = local_runs.run_id
     where local_runs.run_id = $1 and local_runs.machine_id = $2`,
    [runId, machine.id],
  );
  if (!rows[0]) throw noSuchRun();
  return rows[0];
}

/**
 * Whether a Run this Machine holds still runs, after bringing it back if it was lost: a lost Run's Machine that calls
 * again, as on waking from sleep, shows the Run wasn't gone. A lost Run that can't come back, its Ticket moved on, is
 * over for good: its token is revoked and its stop counted as told, since the answer tells the daemon to stop it.
 */
async function stillRunning(context: Context, machine: MachineSelf, runId: string): Promise<boolean> {
  const run = await heldRun(context, machine, runId);
  if (run.state === "running") return true;
  if (run.state !== "lost") return false;
  await reviveLostRun(context, { id: run.agentId, workspace: { id: run.workspaceId } }, { runId });
  if ((await heldRun(context, machine, runId)).state === "running") return true;
  await revokeLocalRunToken(context, runId);
  await acknowledgeStop(context, machine, runId);
  return false;
}

const runStopped = () =>
  new ApiError(409, "run_stopped", "This Run is no longer running in Cronk: stop its process and let go of what it holds.");

/**
 * Records a heartbeat of a Run the Machine holds, counted as a call naming the Run, so a working Run isn't lost; a lost
 * Run comes back if its Ticket hasn't moved on. A Run no longer running is refused with `run_stopped`, telling the
 * daemon to kill its process.
 */
export async function heartbeat(context: Context, machine: MachineSelf, runId: string): Promise<void> {
  if (!(await stillRunning(context, machine, runId))) throw runStopped();
  const { rowCount } = await context.db.query("update runs set last_call_at = $2 where id = $1 and state = 'running'", [
    runId,
    context.clock.now(),
  ]);
  if (!rowCount) throw runStopped();
}

/**
 * Records that the Machine killed the process of a Run it holds and cleaned up after it, so the stop isn't told again.
 * Idempotent, and accepted whatever the Run's state.
 */
export async function acknowledgeStop(context: Context, machine: MachineSelf, runId: string): Promise<void> {
  await heldRun(context, machine, runId);
  await context.db.query("update local_runs set stop_acked_at = $3 where run_id = $1 and machine_id = $2 and stop_acked_at is null", [
    runId,
    machine.id,
    context.clock.now(),
  ]);
}

export const LocalSession = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 200, description: "Claude Code's session id, from its stream's `system` `init` message." }),
});
export type LocalSession = Static<typeof LocalSession>;

/** Records the Claude Code session of a Run the Machine holds as its session reference. */
export async function reportSession(context: Context, machine: MachineSelf, runId: string, sessionId: string): Promise<void> {
  if (!(await stillRunning(context, machine, runId))) throw runStopped();
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

/**
 * Reports that the `claude` process of a Run the Machine holds ended, which also confirms any stop. A Run its agent
 * didn't finish fails with the reason, a lost one too if its Ticket hasn't moved on; one that ended already, as
 * `finish` ends it, is left as it is. A cost given is recorded as the Run's estimated cost, whichever way it ended.
 */
export async function reportEnd(context: Context, machine: MachineSelf, runId: string, end: LocalRunEnd): Promise<void> {
  const running = await stillRunning(context, machine, runId);
  await acknowledgeStop(context, machine, runId);
  const reports = runReports(context);
  if (running) await reports.endedWithoutFinishing(runId, `The session ended without calling \`finish\`: ${end.reason.trim()}`);
  if (end.costUsd !== undefined) await reports.cost(runId, { amount: Math.round(end.costUsd * 100), currency: "USD", estimate: true });
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
