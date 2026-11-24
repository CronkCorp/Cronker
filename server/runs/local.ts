import type { Context } from "../context.js";
import { modelIdOf, settingsOf } from "../workspaces/workspaces.js";
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
      // The Machine passes `claude` a model id, never a label: a label the Workspace doesn't map is refused here,
      // where its Admin can see why, rather than on the Machine.
      const { rows } = await context.db.query<{ workspaceId: string }>(`select workspace_id as "workspaceId" from runs where id = $1`, [
        run.runId,
      ]);
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
      context.live.sendToMachines(run.runner.id, { type: "run.claimable", runId: run.runId });
      return { started: true, reference: {} };
    },
    // Cronk stopped the Run. A lost Run may yet come back (CRONK-142), so its token is kept until it is stopped for good.
    async stop(run) {
      await revokeLocalRunToken(context, run.runId, { unlessLost: true });
    },
    async ended(run) {
      await revokeLocalRunToken(context, run.runId);
    },
    // A removed Runner's Runs stop, so nothing keeps running on a Machine unseen.
    stopsRunsWhenRemoved: true,
  };
}

/** Revokes the Agent token minted for a claimed local Run, once; `unlessLost` leaves a lost Run's token working. */
export async function revokeLocalRunToken(context: Context, runId: string, { unlessLost = false } = {}): Promise<void> {
  const { rows } = await context.db.query<{ tokenId: string | null }>(
    `update local_runs set revoked_at = $2 where run_id = $1 and revoked_at is null
       and not ($3::boolean and exists (select 1 from runs where runs.id = $1 and runs.state = 'lost'))
     returning token_id as "tokenId"`,
    [runId, context.clock.now(), unlessLost],
  );
  const tokenId = rows[0]?.tokenId;
  if (tokenId) await context.db.query("delete from agent_tokens where id = $1", [tokenId]);
}
