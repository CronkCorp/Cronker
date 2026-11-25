import type { Context } from "../context.js";
import { modelIdOf, settingsOf } from "../workspaces/workspaces.js";
import { machinesWithClaude, machinesWithModel, mappedModelSql, needsClaudeReason, notSetUpReason } from "./machine-models.js";
import type { Runner, StartResult } from "./runner.js";

/**
 * The local Runner: Runs run on a Machine of its Owner's, through Claude Code's CLI signed in with their own
 * subscription. Cronk can't reach a Machine, so the Runner is pulled rather than pushed (ADR 0014): starting a Run
 * reaches no Machine. It answers *started* with no session reference yet and tells the connected Machines serving the
 * Runner that the Run is claimable; one of them claims it (`server/machines/local-runs.ts`).
 */
export function localRunner(context: Context): Runner {
  return {
    // Its Runs run on the Owner's own Machine, so `local-only` Tickets go to it.
    cloud: false,
    async start(run): Promise<StartResult> {
      const { rows } = await context.db.query<{ workspaceId: string; machineModel: string | null }>(
        `select runs.workspace_id as "workspaceId", ${mappedModelSql("runners", "runs")} as "machineModel"
         from runs join runners on runners.id = runs.runner_id where runs.id = $1`,
        [run.runId],
      );
      const machineModel = rows[0]?.machineModel ?? null;
      if (machineModel) {
        // A label mapped to a Machine model needs no model id, and never falls back to Claude: only Machines that
        // have the Machine model set up hear of the Run, and with none it is refused here, naming the label.
        const machineIds = await machinesWithModel(context.db, run.runner.id, machineModel);
        if (machineIds.length === 0) {
          return { started: false, refusal: { kind: "not_configured", message: notSetUpReason(run.model, machineModel, run.runner.name) } };
        }
        for (const machineId of machineIds) context.live.sendToMachine(machineId, { type: "run.claimable", runId: run.runId });
        return { started: true, reference: {} };
      }
      // The Machine passes `claude` a model id, never a label: a label the Workspace doesn't map is refused here,
      // where its Admin can see why, rather than on the Machine.
      const workspaceId = rows[0]?.workspaceId;
      if (workspaceId && !modelIdOf(await settingsOf(context.db, workspaceId), run.model.trim())) {
        return {
          started: false,
          refusal: {
            kind: "not_configured",
            message:
              `The Workspace has no model id for the label ${run.model}, so ${run.runner.name} can't tell Claude Code ` +
              "which model to run: an Admin sets one in the Workspace's settings.",
          },
        };
      }
      // Only Machines that run Claude hear of it; with none serving the Runner it is refused here, naming the label.
      const machineIds = await machinesWithClaude(context.db, run.runner.id);
      if (machineIds.length === 0) {
        return { started: false, refusal: { kind: "not_configured", message: needsClaudeReason(run.model, run.runner.name) } };
      }
      for (const machineId of machineIds) context.live.sendToMachine(machineId, { type: "run.claimable", runId: run.runId });
      return { started: true, reference: {} };
    },
    // Cronk stopped the Run: the Machine holding it is told to kill its process, now if it is connected, else when it
    // connects again (`stopsToReplay`). A lost Run may yet come back, so it keeps its token and its process until a
    // heartbeat finds its Ticket moved on (`server/machines/local-runs.ts`).
    async stop(run) {
      if (!(await revokeLocalRunToken(context, run.runId, { unlessLost: true }))) return;
      const { rows } = await context.db.query<{ machineId: string }>(
        `select machine_id as "machineId" from local_runs where run_id = $1 and stop_acked_at is null`,
        [run.runId],
      );
      for (const { machineId } of rows) context.live.sendToMachine(machineId, { type: "run.stop", runId: run.runId });
    },
    async ended(run) {
      await revokeLocalRunToken(context, run.runId);
    },
    // A removed Runner's Runs stop, so nothing keeps running on a Machine unseen.
    stopsRunsWhenRemoved: true,
  };
}

/**
 * Revokes the Agent token minted for a claimed local Run, once; `unlessLost` leaves a lost Run's token working, and a
 * Run that came back from lost meanwhile. Answers false only when it left the Run alone.
 */
export async function revokeLocalRunToken(context: Context, runId: string, { unlessLost = false } = {}): Promise<boolean> {
  if (unlessLost) {
    const { rowCount } = await context.db.query("select 1 from runs where id = $1 and state in ('lost', 'running')", [runId]);
    if (rowCount) return false;
  }
  const { rows } = await context.db.query<{ tokenId: string | null }>(
    `update local_runs set revoked_at = $2 where run_id = $1 and revoked_at is null returning token_id as "tokenId"`,
    [runId, context.clock.now()],
  );
  const tokenId = rows[0]?.tokenId;
  if (tokenId) await context.db.query("delete from agent_tokens where id = $1", [tokenId]);
  return true;
}
