import type { Context } from "../context.js";
import { runReports } from "./runs.js";

/**
 * What a Run of a `local` Runner needs (CRONK-156): a label its Runner maps to a Machine model needs that Machine
 * model, and any other label needs Claude, as before. The mapping is read when it is needed, at the start and at the
 * claim, so a change applies to Runs not claimed yet; the claim records the Machine model on the Run (`runs.machine_model`).
 */

/** A Machine model's name: 1 to 50 lower case letters, digits and dashes. */
export const machineModelNamePattern = "^[a-z0-9-]{1,50}$";

/** A label and the Machine model it stands for, on a `local` Runner. */
export interface MachineModelMapping {
  label: string;
  model: string;
}

/**
 * SQL for the Machine model the Run's label is mapped to on its Runner, matched ignoring case; null for an unmapped
 * label, which needs Claude.
 */
export const mappedModelSql = (runners: string, runs: string) =>
  `(select m->>'model' from jsonb_array_elements(${runners}.machine_models) m
    where lower(m->>'label') = lower(btrim(${runs}.model)) limit 1)`;

/** SQL for whether the Machine offers what a Run needs, given its mapped Machine model (null for Claude). */
export const offersSql = (machines: string, mapped: string) =>
  `(case when ${mapped} is null then ${machines}.announces_claude
    else ${machines}.announced_models @> jsonb_build_array(jsonb_build_object('name', ${mapped})) end)`;

/** Why a Run on a mapped label can't run: no Machine serving its Runner has its Machine model set up. */
export const notSetUpReason = (label: string, model: string, runnerName: string) =>
  `The label ${label} is mapped to the Machine model ${model}, which no Machine serving ${runnerName} has set up: ` +
  `add it with \`cronk-runner model add ${model}\`, or map the label again on the Runner's card.`;

type Queryable = Pick<Context["db"], "query">;

/** The ids of the Machines serving the Runner, paired or offline, that have the Machine model set up. */
export async function machinesWithModel(db: Queryable, runnerId: string, model: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select machines.id from machine_runners join machines on machines.id = machine_runners.machine_id
     where machine_runners.runner_id = $1 and machines.revoked_at is null
       and machines.announced_models @> jsonb_build_array(jsonb_build_object('name', $2::text))
     order by machines.id`,
    [runnerId, model],
  );
  return rows.map((r) => r.id);
}

/** The ids of the Machines serving the Runner that run Claude. */
export async function machinesWithClaude(db: Queryable, runnerId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select machines.id from machine_runners join machines on machines.id = machine_runners.machine_id
     where machine_runners.runner_id = $1 and machines.revoked_at is null and machines.announces_claude
     order by machines.id`,
    [runnerId],
  );
  return rows.map((r) => r.id);
}

/**
 * Once what the Runner's Machines offer or its mapping changed: its Runs not claimed yet whose label now needs a
 * Machine model none of them has set up fail, naming the label, and each connected Machine serving it is told again
 * of the Runs it may now claim. Call it once the change committed.
 */
export async function recheckClaimable(context: Context, runnerIds: string[]): Promise<void> {
  if (runnerIds.length === 0) return;
  const { rows: refusable } = await context.db.query<{ id: string; model: string; mapped: string; runnerName: string }>(
    `select runs.id, runs.model, mapped.model as mapped, runners.name as "runnerName"
     from runs join runners on runners.id = runs.runner_id
     cross join lateral (select ${mappedModelSql("runners", "runs")} as model) mapped
     where runs.state = 'running' and runs.runner_id = any($1::uuid[]) and mapped.model is not null
       and not exists (select 1 from local_runs where local_runs.run_id = runs.id)
       and not exists (select 1 from machine_runners join machines on machines.id = machine_runners.machine_id
         where machine_runners.runner_id = runners.id and machines.revoked_at is null
           and machines.announced_models @> jsonb_build_array(jsonb_build_object('name', mapped.model)))`,
    [runnerIds],
  );
  for (const run of refusable) {
    await runReports(context).endedWithoutFinishing(run.id, `${notSetUpReason(run.model, run.mapped, run.runnerName)} Then Retry.`);
  }
  const { rows: machines } = await context.db.query<{ id: string; runnerIds: string[] }>(
    `select machines.id, array_agg(machine_runners.runner_id) as "runnerIds"
     from machines join machine_runners on machine_runners.machine_id = machines.id
     where machines.revoked_at is null and machines.connections > 0
       and machines.id in (select machine_id from machine_runners where runner_id = any($1::uuid[]))
     group by machines.id`,
    [runnerIds],
  );
  for (const machine of machines) {
    for (const runId of await claimableRunsFor(context.db, machine.id, machine.runnerIds)) {
      context.live.sendToMachine(machine.id, { type: "run.claimable", runId });
    }
  }
}

/**
 * The Runs of these Runners waiting to be claimed that the Machine offers what they need for, oldest first: those whose
 * label is mapped to a Machine model it has set up, and the rest if it runs Claude.
 */
export async function claimableRunsFor(db: Queryable, machineId: string, runnerIds: string[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select runs.id from runs join runners on runners.id = runs.runner_id join machines on machines.id = $2
     where runs.state = 'running' and runs.runner_id = any($1::uuid[])
       and not exists (select 1 from local_runs where local_runs.run_id = runs.id)
       and ${offersSql("machines", mappedModelSql("runners", "runs"))}
     order by runs.started_at, runs.id`,
    [runnerIds, machineId],
  );
  return rows.map((r) => r.id);
}
